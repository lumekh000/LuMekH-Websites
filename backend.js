const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { randomBytes, createHash, scrypt, timingSafeEqual } = require("node:crypto");
const { promisify } = require("node:util");
const mysql = require("mysql2/promise");
const nodemailer = require("nodemailer");

const scryptAsync = promisify(scrypt);
const publicDir = path.join(__dirname, "public");
const adminEmail = String(process.env.ADMIN_EMAIL || "lumekh000@gmail.com").trim().toLowerCase();
const mailUser = process.env.SMTP_USER || "noreply@lumekh.com";
const mimeTypes = { ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp" };

const dbConfigured = Boolean(process.env.DB_NAME && process.env.DB_USER && process.env.DB_PASSWORD);
const dbPool = dbConfigured ? mysql.createPool({
  host: process.env.DB_HOST === "localhost" ? "127.0.0.1" : (process.env.DB_HOST || "127.0.0.1"),
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 8,
  queueLimit: 0,
  timezone: "Z",
  decimalNumbers: true
}) : null;
let dbReady = false;
const loginAttempts = new Map();

const schema = [
  "CREATE TABLE IF NOT EXISTS app_users (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, email VARCHAR(254) NOT NULL UNIQUE, password_hash VARCHAR(255) NOT NULL, role ENUM('customer','admin') NOT NULL DEFAULT 'customer', email_verified TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_users_created (created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS app_sessions (token_hash CHAR(64) NOT NULL PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, csrf_token CHAR(64) NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_sessions_user (user_id), INDEX idx_sessions_expiry (expires_at), CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS email_tokens (token_hash CHAR(64) NOT NULL PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, purpose ENUM('verify','reset') NOT NULL, expires_at DATETIME NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_email_tokens_user (user_id), CONSTRAINT fk_email_tokens_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS products (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(160) NOT NULL, description TEXT NOT NULL, price DECIMAL(10,2) NOT NULL, stock INT NULL, image_url VARCHAR(1000) NULL, active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_products_active (active, created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS services (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(160) NOT NULL, description TEXT NOT NULL, duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 60, price DECIMAL(10,2) NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_services_active (active, created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS service_categories (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL UNIQUE, description VARCHAR(1000) NOT NULL DEFAULT '', active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS booking_resources (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, resource_type ENUM('agent','studio') NOT NULL, name VARCHAR(160) NOT NULL, email VARCHAR(254) NOT NULL DEFAULT '', location VARCHAR(500) NOT NULL DEFAULT '', timezone VARCHAR(80) NOT NULL DEFAULT 'Asia/Kolkata', active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_booking_resources (resource_type,active,name)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS service_extras (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, service_id BIGINT UNSIGNED NOT NULL, name VARCHAR(160) NOT NULL, description VARCHAR(1000) NOT NULL DEFAULT '', price DECIMAL(10,2) NOT NULL DEFAULT 0, duration_minutes SMALLINT UNSIGNED NOT NULL DEFAULT 0, price_per_day TINYINT(1) NOT NULL DEFAULT 0, active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_service_extras (service_id,active), CONSTRAINT fk_service_extra_service FOREIGN KEY (service_id) REFERENCES services(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS booking_settings (setting_key VARCHAR(80) NOT NULL PRIMARY KEY, setting_value TEXT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS bookings (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, service_id BIGINT UNSIGNED NOT NULL, starts_at DATETIME NOT NULL, status ENUM('requested','confirmed','cancelled','completed') NOT NULL DEFAULT 'requested', notes VARCHAR(1000) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_bookings_start (starts_at, status), INDEX idx_bookings_user (user_id, starts_at), CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES app_users(id), CONSTRAINT fk_bookings_service FOREIGN KEY (service_id) REFERENCES services(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS orders (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, total DECIMAL(10,2) NOT NULL, status ENUM('new','processing','completed','cancelled') NOT NULL DEFAULT 'new', full_name VARCHAR(160) NOT NULL, phone VARCHAR(40) NOT NULL, address VARCHAR(500) NOT NULL, city VARCHAR(120) NOT NULL, postal_code VARCHAR(24) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_orders_user (user_id, created_at), INDEX idx_orders_created (created_at), CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES app_users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS order_items (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL, product_name VARCHAR(160) NOT NULL, quantity SMALLINT UNSIGNED NOT NULL, unit_price DECIMAL(10,2) NOT NULL, INDEX idx_order_items_order (order_id), CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS product_categories (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, slug VARCHAR(150) NOT NULL UNIQUE, description VARCHAR(1000) NOT NULL DEFAULT '', active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS product_variants (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, product_id BIGINT UNSIGNED NOT NULL, sku VARCHAR(64) NULL UNIQUE, name VARCHAR(160) NOT NULL, attributes_json TEXT NOT NULL, price DECIMAL(10,2) NULL, stock INT NULL, active TINYINT(1) NOT NULL DEFAULT 1, INDEX idx_variant_product (product_id,active), CONSTRAINT fk_variant_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS product_images (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, product_id BIGINT UNSIGNED NOT NULL, image_url VARCHAR(1000) NOT NULL, alt_text VARCHAR(180) NOT NULL DEFAULT '', sort_order INT NOT NULL DEFAULT 0, INDEX idx_product_images (product_id,sort_order), CONSTRAINT fk_product_image_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS media_assets (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, file_name VARCHAR(255) NOT NULL, mime_type VARCHAR(120) NOT NULL, file_size INT UNSIGNED NOT NULL, is_private TINYINT(1) NOT NULL DEFAULT 0, data MEDIUMBLOB NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_media_private (is_private,created_at)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS coupons (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, code VARCHAR(80) NOT NULL UNIQUE, discount_type ENUM('percent','fixed_cart','fixed_product') NOT NULL DEFAULT 'percent', amount DECIMAL(10,2) NOT NULL, minimum_amount DECIMAL(10,2) NOT NULL DEFAULT 0, usage_limit INT NULL, used_count INT NOT NULL DEFAULT 0, expires_at DATETIME NULL, active TINYINT(1) NOT NULL DEFAULT 1, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS coupon_usage (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, coupon_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL, order_id BIGINT UNSIGNED NOT NULL, used_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_coupon_order (coupon_id,order_id), INDEX idx_coupon_user (coupon_id,user_id), CONSTRAINT fk_coupon_usage_coupon FOREIGN KEY (coupon_id) REFERENCES coupons(id), CONSTRAINT fk_coupon_usage_user FOREIGN KEY (user_id) REFERENCES app_users(id), CONSTRAINT fk_coupon_usage_order FOREIGN KEY (order_id) REFERENCES orders(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS customer_addresses (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, label VARCHAR(60) NOT NULL DEFAULT 'Home', full_name VARCHAR(160) NOT NULL, phone VARCHAR(40) NOT NULL, address VARCHAR(500) NOT NULL, city VARCHAR(120) NOT NULL, region VARCHAR(120) NOT NULL DEFAULT '', postal_code VARCHAR(24) NOT NULL, country VARCHAR(80) NOT NULL DEFAULT 'India', is_default TINYINT(1) NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_address_user (user_id), CONSTRAINT fk_address_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS wishlists (user_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (user_id,product_id), CONSTRAINT fk_wishlist_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE, CONSTRAINT fk_wishlist_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS product_reviews (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, product_id BIGINT UNSIGNED NOT NULL, user_id BIGINT UNSIGNED NOT NULL, rating TINYINT UNSIGNED NOT NULL, title VARCHAR(160) NOT NULL DEFAULT '', body VARCHAR(2000) NOT NULL DEFAULT '', status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE KEY uq_review_user_product (product_id,user_id), INDEX idx_review_product (product_id,status), CONSTRAINT fk_review_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE, CONSTRAINT fk_review_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS store_settings (setting_key VARCHAR(80) NOT NULL PRIMARY KEY, setting_value TEXT NOT NULL, updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS stock_logs (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, product_id BIGINT UNSIGNED NOT NULL, delta INT NOT NULL, reason VARCHAR(160) NOT NULL, user_id BIGINT UNSIGNED NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_stock_product (product_id,created_at), CONSTRAINT fk_stock_product FOREIGN KEY (product_id) REFERENCES products(id), CONSTRAINT fk_stock_user FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE SET NULL) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
];

async function initializeDatabase() {
  if (!dbPool) return;
  try {
    for (const sql of schema) await dbPool.query(sql);
    for (const [table,column,definition] of [
      ["app_users","phone","VARCHAR(40) NOT NULL DEFAULT ''"],
      ["services","category_id","BIGINT UNSIGNED NULL"],
      ["services","resource_ids","TEXT NULL"],
      ["bookings","resource_id","BIGINT UNSIGNED NULL"],
      ["bookings","customer_full_name","VARCHAR(160) NOT NULL DEFAULT ''"],
      ["bookings","customer_phone","VARCHAR(40) NOT NULL DEFAULT ''"],
      ["bookings","customer_address","VARCHAR(500) NOT NULL DEFAULT ''"],
      ["bookings","customer_postal_code","VARCHAR(24) NOT NULL DEFAULT ''"],
      ["services","booking_mode","ENUM('hourly','daily') NOT NULL DEFAULT 'hourly'"],
      ["services","buffer_minutes","SMALLINT UNSIGNED NOT NULL DEFAULT 0"],
      ["services","available_weekdays","VARCHAR(40) NOT NULL DEFAULT '0,1,2,3,4,5,6'"],
      ["services","start_time","TIME NULL"],
      ["services","end_time","TIME NULL"],
      ["services","min_notice_hours","SMALLINT UNSIGNED NOT NULL DEFAULT 0"],
      ["services","max_advance_days","SMALLINT UNSIGNED NOT NULL DEFAULT 365"],
      ["bookings","booking_dates_json","TEXT NULL"],
      ["bookings","booking_extras_json","TEXT NULL"],
      ["bookings","total_price","DECIMAL(10,2) NOT NULL DEFAULT 0"],
      ["products","sku","VARCHAR(64) NULL"],
      ["products","sale_price","DECIMAL(10,2) NULL"],
      ["products","category_id","BIGINT UNSIGNED NULL"],
      ["products","featured","TINYINT(1) NOT NULL DEFAULT 0"],
      ["products","is_virtual","TINYINT(1) NOT NULL DEFAULT 0"],
      ["products","weight_grams","INT UNSIGNED NULL"],
      ["products","product_type","ENUM('simple','variable','digital') NOT NULL DEFAULT 'simple'"],
      ["products","short_description","VARCHAR(500) NOT NULL DEFAULT ''"],
      ["products","download_media_id","BIGINT UNSIGNED NULL"],
      ["orders","subtotal","DECIMAL(10,2) NOT NULL DEFAULT 0"],
      ["orders","discount_total","DECIMAL(10,2) NOT NULL DEFAULT 0"],
      ["orders","shipping_total","DECIMAL(10,2) NOT NULL DEFAULT 0"],
      ["orders","tax_total","DECIMAL(10,2) NOT NULL DEFAULT 0"],
      ["orders","payment_method","VARCHAR(32) NOT NULL DEFAULT 'manual'"],
      ["orders","payment_status","VARCHAR(24) NOT NULL DEFAULT 'pending'"],
      ["orders","fulfillment_status","VARCHAR(24) NOT NULL DEFAULT 'unfulfilled'"],
      ["orders","shipping_method","VARCHAR(80) NOT NULL DEFAULT 'manual'"],
      ["orders","coupon_code","VARCHAR(80) NULL"],
      ["orders","tracking_number","VARCHAR(160) NULL"],
      ["orders","customer_note","VARCHAR(1000) NOT NULL DEFAULT ''"],
      ["orders","provider_order_id","VARCHAR(100) NULL"],
      ["orders","provider_payment_id","VARCHAR(100) NULL"],
      ["orders","updated_at","DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"],
      ["order_items","variant_id","BIGINT UNSIGNED NULL"],
      ["order_items","sku","VARCHAR(64) NULL"],
      ["order_items","image_url","VARCHAR(1000) NULL"],
      ["order_items","line_total","DECIMAL(10,2) NOT NULL DEFAULT 0"]
    ]) {
      const [columns] = await dbPool.execute("SELECT COUNT(*) AS found FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?", [table,column]);
      if (Number(columns[0].found) === 0) await dbPool.query("ALTER TABLE `" + table + "` ADD COLUMN `" + column + "` " + definition);
    }
    await dbPool.query("INSERT IGNORE INTO store_settings (setting_key,setting_value) VALUES ('currency','INR'),('currency_symbol','₹'),('tax_enabled','0'),('tax_rate','0'),('tax_label','GST'),('shipping_flat_rate','0'),('shipping_free_threshold','0'),('shipping_pickup_enabled','1'),('shipping_local_delivery_enabled','0'),('shipping_local_delivery_rate','0'),('coupon_enabled','1'),('store_name','LuMekH™'),('low_stock_threshold','5')");
    const [ownerRows] = await dbPool.execute("SELECT id FROM app_users WHERE LOWER(email)=? LIMIT 1",[adminEmail]);
    if (ownerRows.length) {
      await dbPool.execute("UPDATE app_users SET role='admin',email_verified=1 WHERE id=?",[ownerRows[0].id]);
    } else {
      const bootstrapPassword = randomBytes(48).toString("base64url");
      const bootstrapHash = await hashPassword(bootstrapPassword);
      await dbPool.execute("INSERT INTO app_users (name,email,password_hash,role,email_verified) VALUES (?,?,?,'admin',1)",["LuMekH Admin",adminEmail,bootstrapHash]);
    }
    dbReady = true;
    console.log("LuMekH database is ready.");
  } catch (error) {
    dbReady = false;
    console.error("Database initialization failed:", error.message);
    setTimeout(initializeDatabase, 15000).unref();
  }
}

function hashToken(token) { return createHash("sha256").update(token).digest("hex"); }
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, 64);
  return "scrypt$" + salt.toString("hex") + "$" + Buffer.from(derived).toString("hex");
}
async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  if (!salt.length || expected.length !== 64) return false;
  const actual = Buffer.from(await scryptAsync(password, salt, 64));
  return timingSafeEqual(actual, expected);
}
function sendJson(res, status, payload, headers) {
  res.writeHead(status, Object.assign({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }, headers || {}));
  res.end(JSON.stringify(payload));
}
function sendError(res, status, message) { sendJson(res, status, { error: message }); }
function parseCookies(header) {
  const result = {};
  for (const item of String(header || "").split(";")) {
    const index = item.indexOf("=");
    if (index < 0) continue;
    try { result[item.slice(0, index).trim()] = decodeURIComponent(item.slice(index + 1).trim()); } catch (_) {}
  }
  return result;
}
function originIsSame(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch (_) { return false; }
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100000) throw Object.assign(new Error("Request is too large."), { status: 413 });
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { throw Object.assign(new Error("Please submit valid form data."), { status: 400 }); }
}
async function readRaw(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("That file is too large."), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function cleanText(value, max) { return String(value || "").trim().slice(0, max); }
function validEmail(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254; }
function mailTransport() {
  if (!process.env.SMTP_PASS) return null;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.hostinger.com",
    port: Number(process.env.SMTP_PORT || 465),
    secure: String(process.env.SMTP_SECURE || "true") !== "false",
    auth: { user: mailUser, pass: process.env.SMTP_PASS }
  });
}
async function sendMail(to, subject, html) {
  const transport = mailTransport();
  if (!transport) return false;
  await transport.sendMail({ from: process.env.MAIL_FROM || "LuMekH™ <noreply@lumekh.com>", to, subject, html });
  return true;
}
function originFor(req) {
  const scheme = String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim() === "http" ? "http" : "https";
  return scheme + "://" + req.headers.host;
}
async function createSession(res, userId) {
  const token = randomBytes(32).toString("hex");
  const csrf = randomBytes(32).toString("hex");
  await dbPool.execute("INSERT INTO app_sessions (token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,DATE_ADD(UTC_TIMESTAMP(), INTERVAL 30 DAY))", [hashToken(token), userId, csrf]);
  res.setHeader("Set-Cookie", "sid=" + encodeURIComponent(token) + "; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
  return csrf;
}
async function getSession(req) {
  if (!dbReady) return null;
  const token = parseCookies(req.headers.cookie).sid;
  if (!token || token.length > 200) return null;
  const [rows] = await dbPool.execute("SELECT s.csrf_token,u.id,u.name,u.email,u.role,u.email_verified FROM app_sessions s JOIN app_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>UTC_TIMESTAMP() LIMIT 1", [hashToken(token)]);
  if (!rows.length) return null;
  return { csrfToken: rows[0].csrf_token, user: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role, emailVerified: Boolean(rows[0].email_verified) } };
}
async function requireSession(req, res, roles) {
  const session = await getSession(req);
  if (!session) { sendError(res, 401, "Please sign in to continue."); return null; }
  if (roles && !roles.includes(session.user.role)) { sendError(res, 403, "You do not have access to this page."); return null; }
  if (!safeEqual(String(req.headers["x-csrf-token"] || ""), session.csrfToken)) { sendError(res, 403, "Please refresh the page and try again."); return null; }
  return session;
}
async function publicSession(req, res) {
  const session = await getSession(req);
  sendJson(res, 200, { user: session ? session.user : null, csrfToken: session ? session.csrfToken : null, databaseReady: dbReady, emailReady: Boolean(process.env.SMTP_PASS) });
}
function attemptKey(req, email) { return (req.socket.remoteAddress || "unknown") + ":" + email; }
function allowLogin(req, email) {
  const key = attemptKey(req, email);
  const now = Date.now();
  const entry = loginAttempts.get(key);
  if (!entry || now - entry.started > 15 * 60 * 1000) { loginAttempts.set(key, { started: now, count: 1 }); return true; }
  if (entry.count >= 8) return false;
  entry.count += 1;
  return true;
}
function clearAttempts(req, email) { loginAttempts.delete(attemptKey(req, email)); }

async function readStoreSettings() {
  if (!dbReady) return {};
  const [rows] = await dbPool.query("SELECT setting_key,setting_value FROM store_settings");
  return Object.fromEntries(rows.map(row => [row.setting_key, row.setting_value]));
}
function couponDiscount(coupon, subtotal) {
  if (!coupon || subtotal < Number(coupon.minimum_amount || 0)) return 0;
  const raw = coupon.discount_type === "percent" ? subtotal * Number(coupon.amount) / 100 : Number(coupon.amount);
  return Math.max(0, Math.min(subtotal, Math.round(raw * 100) / 100));
}

async function api(req, res, url) {
  const route = url.pathname;
  if (req.method === "GET" && route === "/api/health") return sendJson(res, 200, { status: "ok", databaseReady: dbReady, emailReady: Boolean(process.env.SMTP_PASS) });
  if (route.startsWith("/api/") && !originIsSame(req)) return sendError(res, 403, "Request origin could not be verified.");

  if (req.method === "GET" && route === "/api/auth/session") return publicSession(req, res);

  const publicMediaMatch = route.match(/^\/api\/media\/(\d+)$/);
  if (req.method === "GET" && publicMediaMatch) {
    if (!dbReady) return sendError(res,503,"Media is being prepared.");
    const [[media]] = await dbPool.execute("SELECT file_name,mime_type,file_size,data FROM media_assets WHERE id=? AND is_private=0 LIMIT 1",[Number(publicMediaMatch[1])]);
    if (!media) return sendError(res,404,"Image not found.");
    res.writeHead(200,{"Content-Type":media.mime_type,"Content-Length":media.file_size,"Cache-Control":"public, max-age=31536000, immutable","X-Content-Type-Options":"nosniff"});
    return res.end(media.data);
  }
  const downloadMatch = route.match(/^\/api\/orders\/(\d+)\/downloads\/(\d+)$/);
  if (req.method === "GET" && downloadMatch) {
    const session = await getSession(req);
    if (!session) return sendError(res,401,"Please sign in to download your purchase.");
    const [[asset]] = await dbPool.execute("SELECT m.file_name,m.file_size,m.data FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id JOIN media_assets m ON m.id=p.download_media_id WHERE o.id=? AND o.user_id=? AND p.id=? AND p.product_type='digital' AND (o.status='completed' OR o.payment_status='paid') LIMIT 1",[Number(downloadMatch[1]),session.user.id,Number(downloadMatch[2])]);
    if (!asset) return sendError(res,404,"This download is not available for that order.");
    const fileName = cleanText(asset.file_name,180).replace(/[\\"\r\n]/g,"_") || "download";
    res.writeHead(200,{"Content-Type":"application/octet-stream","Content-Length":asset.file_size,"Content-Disposition":"attachment; filename*=UTF-8''"+encodeURIComponent(fileName),"Cache-Control":"private, no-store","X-Content-Type-Options":"nosniff"});
    return res.end(asset.data);
  }

  if (req.method === "POST" && route === "/api/auth/register") {
    if (!dbReady) return sendError(res, 503, "Account setup is still being prepared. Please try again shortly.");
    if (!process.env.SMTP_PASS) return sendError(res, 503, "Hostinger email is not connected yet. Please try again after email setup.");
    const body = await readJson(req);
    const name = cleanText(body.name, 120);
    const email = cleanText(body.email, 254).toLowerCase();
    const password = String(body.password || "");
    if (name.length < 2 || !validEmail(email) || password.length < 10) return sendError(res, 400, "Enter your name, a valid email, and a password with at least 10 characters.");
    const passwordHash = await hashPassword(password);
    const token = randomBytes(32).toString("hex");
    const conn = await dbPool.getConnection();
    try {
      await conn.beginTransaction();
      const [result] = await conn.execute("INSERT INTO app_users (name,email,password_hash) VALUES (?,?,?)", [name, email, passwordHash]);
      await conn.execute("INSERT INTO email_tokens (token_hash,user_id,purpose,expires_at) VALUES (?,?,'verify',DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 DAY))", [hashToken(token), result.insertId]);
      const link = originFor(req) + "/verify.html?token=" + encodeURIComponent(token);
      await sendMail(email, "Confirm your LuMekH account", "<p>Welcome to LuMekH.</p><p><a href=\"" + link + "\">Confirm your email address</a></p><p>This link expires in 24 hours.</p>");
      await conn.commit();
      return sendJson(res, 201, { message: "Account created. Check your email to confirm your address." });
    } catch (error) {
      await conn.rollback();
      if (error && error.code === "ER_DUP_ENTRY") return sendError(res, 409, "An account already exists for that email.");
      throw error;
    } finally { conn.release(); }
  }

  if (req.method === "POST" && route === "/api/auth/verify") {
    if (!dbReady) return sendError(res, 503, "Account setup is still being prepared.");
    const body = await readJson(req);
    const token = String(body.token || "");
    if (token.length < 32 || token.length > 200) return sendError(res, 400, "This confirmation link is not valid.");
    const conn = await dbPool.getConnection();
    try {
      await conn.beginTransaction();
      const [tokens] = await conn.execute("SELECT user_id FROM email_tokens WHERE token_hash=? AND purpose='verify' AND expires_at>UTC_TIMESTAMP() LIMIT 1 FOR UPDATE", [hashToken(token)]);
      if (!tokens.length) { await conn.rollback(); return sendError(res, 400, "This confirmation link expired or was already used."); }
      const userId = tokens[0].user_id;
      await conn.execute("UPDATE app_users SET email_verified=1 WHERE id=?", [userId]);
      await conn.execute("DELETE FROM email_tokens WHERE token_hash=?", [hashToken(token)]);
      const [users] = await conn.execute("SELECT email FROM app_users WHERE id=? LIMIT 1", [userId]);
      if (users.length && users[0].email.toLowerCase() === adminEmail) {
        await conn.execute("UPDATE app_users SET role='customer' WHERE role='admin' AND id<>?", [userId]);
        await conn.execute("UPDATE app_users SET role='admin' WHERE id=?", [userId]);
      }
      await conn.commit();
      const [rows] = await conn.execute("SELECT role FROM app_users WHERE id=?", [userId]);
      return sendJson(res, 200, { message: "Email confirmed. You can now sign in.", role: rows[0].role });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  if (req.method === "POST" && route === "/api/auth/login") {
    if (!dbReady) return sendError(res, 503, "Account setup is still being prepared.");
    const body = await readJson(req);
    const email = cleanText(body.email, 254).toLowerCase();
    const password = String(body.password || "");
    if (!validEmail(email) || password.length > 200 || !allowLogin(req, email)) return sendError(res, 429, "Too many sign-in attempts. Please wait 15 minutes and try again.");
    const [rows] = await dbPool.execute("SELECT id,name,email,password_hash,role,email_verified FROM app_users WHERE email=? LIMIT 1", [email]);
    if (!rows.length || !(await verifyPassword(password, rows[0].password_hash))) return sendError(res, 401, "Email or password is incorrect.");
    if (!rows[0].email_verified) return sendError(res, 403, "Confirm your email before signing in.");
    clearAttempts(req, email);
    const csrfToken = await createSession(res, rows[0].id);
    return sendJson(res, 200, { user: { id: rows[0].id, name: rows[0].name, email: rows[0].email, role: rows[0].role }, csrfToken });
  }

  if (req.method === "POST" && route === "/api/auth/logout") {
    const session = await requireSession(req, res);
    if (!session) return;
    const token = parseCookies(req.headers.cookie).sid;
    await dbPool.execute("DELETE FROM app_sessions WHERE token_hash=?", [hashToken(token)]);
    res.setHeader("Set-Cookie", "sid=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0");
    return sendJson(res, 200, { message: "Signed out." });
  }

  if (req.method === "POST" && route === "/api/auth/forgot") {
    if (!dbReady) return sendError(res, 503, "Account setup is still being prepared.");
    if (!process.env.SMTP_PASS) return sendError(res, 503, "Hostinger email is not connected yet.");
    const body = await readJson(req);
    const email = cleanText(body.email, 254).toLowerCase();
    if (!validEmail(email)) return sendError(res, 400, "Enter a valid email address.");
    const [users] = await dbPool.execute("SELECT id FROM app_users WHERE email=? AND email_verified=1 LIMIT 1", [email]);
    if (users.length) {
      const token = randomBytes(32).toString("hex");
      await dbPool.execute("INSERT INTO email_tokens (token_hash,user_id,purpose,expires_at) VALUES (?,?,'reset',DATE_ADD(UTC_TIMESTAMP(), INTERVAL 1 HOUR))", [hashToken(token), users[0].id]);
      const link = originFor(req) + "/reset-password.html?token=" + encodeURIComponent(token);
      await sendMail(email, "Reset your LuMekH password", "<p><a href=\"" + link + "\">Choose a new password</a></p><p>This link expires in one hour.</p>");
    }
    return sendJson(res, 200, { message: "If that account exists, a reset link has been sent." });
  }

  if (req.method === "POST" && route === "/api/auth/reset") {
    if (!dbReady) return sendError(res, 503, "Account setup is still being prepared.");
    const body = await readJson(req);
    const token = String(body.token || "");
    const password = String(body.password || "");
    if (token.length < 32 || password.length < 10) return sendError(res, 400, "Use a valid reset link and a password with at least 10 characters.");
    const [rows] = await dbPool.execute("SELECT user_id FROM email_tokens WHERE token_hash=? AND purpose='reset' AND expires_at>UTC_TIMESTAMP() LIMIT 1", [hashToken(token)]);
    if (!rows.length) return sendError(res, 400, "This reset link expired or was already used.");
    const conn = await dbPool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute("UPDATE app_users SET password_hash=? WHERE id=?", [await hashPassword(password), rows[0].user_id]);
      await conn.execute("DELETE FROM email_tokens WHERE token_hash=?", [hashToken(token)]);
      await conn.execute("DELETE FROM app_sessions WHERE user_id=?", [rows[0].user_id]);
      await conn.commit();
      return sendJson(res, 200, { message: "Password updated. Sign in with your new password." });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  if (req.method === "GET" && route === "/api/store/config") {
    if (!dbReady) return sendError(res, 503, "The store is being set up.");
    const settings = await readStoreSettings();
    const razorpayAvailable = Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
    const shippingMethods = [{ id: "flat_rate", name: "Standard delivery", cost: Number(settings.shipping_flat_rate || 0) }];
    if (settings.shipping_pickup_enabled === "1") shippingMethods.push({ id: "pickup", name: "Local pickup", cost: 0 });
    if (settings.shipping_local_delivery_enabled === "1") shippingMethods.push({ id: "local_delivery", name: "Local delivery", cost: Number(settings.shipping_local_delivery_rate || 0) });
    return sendJson(res, 200, {
      currency: settings.currency || "INR", currencySymbol: settings.currency_symbol || "₹",
      taxEnabled: settings.tax_enabled === "1", taxRate: Number(settings.tax_rate || 0), taxLabel: settings.tax_label || "Tax",
      couponEnabled: settings.coupon_enabled !== "0", freeShippingThreshold: Number(settings.shipping_free_threshold || 0),
      shippingMethods, paymentMethods: [{ id: "manual", name: "Manual payment" }, { id: "cod", name: "Cash on delivery" }, ...(razorpayAvailable ? [{ id: "razorpay", name: "Pay online", keyId: process.env.RAZORPAY_KEY_ID }] : [])]
    });
  }
  if (req.method === "GET" && route === "/api/categories") {
    if (!dbReady) return sendError(res, 503, "The store is being set up.");
    const [categories] = await dbPool.query("SELECT id,name,slug,description FROM product_categories WHERE active=1 ORDER BY sort_order,name");
    return sendJson(res, 200, { categories });
  }
  if (req.method === "GET" && route === "/api/products") {
    if (!dbReady) return sendError(res, 503, "The store is being set up.");
    const query = cleanText(url.searchParams.get("q"), 100);
    const category = Number(url.searchParams.get("category") || 0);
    const min = Number(url.searchParams.get("min") || 0);
    const max = Number(url.searchParams.get("max") || 0);
    const sort = url.searchParams.get("sort") || "newest";
    const page = Math.max(1, Math.min(1000, Number(url.searchParams.get("page") || 1)));
    const perPage = Math.max(1, Math.min(48, Number(url.searchParams.get("limit") || 24)));
    const where = ["p.active=1"];
    const params = [];
    if (query) { where.push("(p.name LIKE ? OR p.description LIKE ? OR p.sku LIKE ?)"); const needle = "%" + query + "%"; params.push(needle,needle,needle); }
    if (Number.isInteger(category) && category > 0) { where.push("p.category_id=?"); params.push(category); }
    if (Number.isFinite(min) && min > 0) { where.push("COALESCE(p.sale_price,p.price)>=?"); params.push(min); }
    if (Number.isFinite(max) && max > 0) { where.push("COALESCE(p.sale_price,p.price)<=?"); params.push(max); }
    const sortMap = { newest:"p.created_at DESC", price_asc:"COALESCE(p.sale_price,p.price) ASC", price_desc:"COALESCE(p.sale_price,p.price) DESC", name:"p.name ASC", featured:"p.featured DESC,p.created_at DESC" };
    const orderBy = sortMap[sort] || sortMap.newest;
    const [rows] = await dbPool.execute("SELECT p.id,p.name,p.description,p.price,p.sale_price,COALESCE(p.sale_price,p.price) AS current_price,p.stock,p.image_url,p.sku,p.featured,p.is_virtual,p.product_type,p.weight_grams,c.name AS category_name,(SELECT COUNT(*) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS review_count,(SELECT ROUND(AVG(r.rating),1) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS average_rating FROM products p LEFT JOIN product_categories c ON c.id=p.category_id WHERE " + where.join(" AND ") + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?", [...params,perPage,(page-1)*perPage]);
    const [[count]] = await dbPool.execute("SELECT COUNT(*) AS total FROM products p WHERE " + where.map(x=>x.replaceAll("p.","p.")).join(" AND "), params);
    return sendJson(res, 200, { products: rows, total: Number(count.total), page, pages: Math.ceil(Number(count.total)/perPage) });
  }
  const productMatch = route.match(/^\/api\/products\/(\d+)$/);
  if (req.method === "GET" && productMatch) {
    if (!dbReady) return sendError(res, 503, "The store is being set up.");
    const id = Number(productMatch[1]);
    const [[product]] = await dbPool.execute("SELECT p.id,p.name,p.description,p.price,p.sale_price,COALESCE(p.sale_price,p.price) AS current_price,p.stock,p.image_url,p.sku,p.featured,p.is_virtual,p.product_type,p.weight_grams,c.name AS category_name,(SELECT COUNT(*) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS review_count,(SELECT ROUND(AVG(r.rating),1) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS average_rating FROM products p LEFT JOIN product_categories c ON c.id=p.category_id WHERE p.id=? AND p.active=1 LIMIT 1",[id]);
    if (!product) return sendError(res,404,"Product not found.");
    const [images] = await dbPool.execute("SELECT id,image_url,alt_text FROM product_images WHERE product_id=? ORDER BY sort_order,id",[id]);
    const [variants] = await dbPool.execute("SELECT id,sku,name,attributes_json,price,stock FROM product_variants WHERE product_id=? AND active=1 ORDER BY id",[id]);
    const [reviews] = await dbPool.execute("SELECT r.rating,r.title,r.body,r.created_at,u.name AS customer_name FROM product_reviews r JOIN app_users u ON u.id=r.user_id WHERE r.product_id=? AND r.status='approved' ORDER BY r.created_at DESC LIMIT 50",[id]);
    return sendJson(res,200,{product,images,variants,reviews});
  }
  if (req.method === "POST" && route === "/api/coupons/validate") {
    if (!dbReady) return sendError(res,503,"Store is being set up.");
    const body=await readJson(req), code=cleanText(body.code,80).toUpperCase(), subtotal=Number(body.subtotal);
    const settings=await readStoreSettings();
    if(settings.coupon_enabled==="0")return sendError(res,400,"Coupons are not available at checkout.");
    if(!code||!Number.isFinite(subtotal)||subtotal<0)return sendError(res,400,"Enter a valid coupon code and basket.");
    const [[coupon]]=await dbPool.execute("SELECT * FROM coupons WHERE code=? AND active=1 LIMIT 1",[code]);
    if(!coupon)return sendError(res,404,"That coupon code is not valid.");
    if(coupon.expires_at && new Date(coupon.expires_at).getTime()<Date.now())return sendError(res,400,"That coupon has expired.");
    if(coupon.usage_limit!==null && Number(coupon.used_count)>=Number(coupon.usage_limit))return sendError(res,400,"That coupon has reached its usage limit.");
    const discount=couponDiscount(coupon,subtotal);
    if(discount<=0)return sendError(res,400,"Your basket does not meet this coupon’s minimum spend.");
    return sendJson(res,200,{code:coupon.code,discount,discountType:coupon.discount_type,message:"Coupon applied."});
  }
  if (req.method === "GET" && route === "/api/wishlist") {
    const session=await getSession(req);if(!session)return sendError(res,401,"Sign in to view your wishlist.");
    const [products]=await dbPool.execute("SELECT p.id,p.name,p.description,p.price,p.sale_price,COALESCE(p.sale_price,p.price) AS current_price,p.stock,p.image_url FROM wishlists w JOIN products p ON p.id=w.product_id WHERE w.user_id=? AND p.active=1 ORDER BY w.created_at DESC",[session.user.id]);
    return sendJson(res,200,{products});
  }
  if (req.method === "POST" && route === "/api/wishlist") {
    const session=await requireSession(req,res);if(!session)return;
    const body=await readJson(req),id=Number(body.productId);
    if(!Number.isInteger(id)||id<1)return sendError(res,400,"Choose a valid product.");
    await dbPool.execute("INSERT IGNORE INTO wishlists (user_id,product_id) SELECT ?,id FROM products WHERE id=? AND active=1",[session.user.id,id]);
    return sendJson(res,200,{message:"Saved to your wishlist."});
  }
  const wishlistMatch=route.match(/^\/api\/wishlist\/(\d+)$/);
  if(req.method==="DELETE"&&wishlistMatch){
    const session=await requireSession(req,res);if(!session)return;
    await dbPool.execute("DELETE FROM wishlists WHERE user_id=? AND product_id=?",[session.user.id,Number(wishlistMatch[1])]);
    return sendJson(res,200,{message:"Removed from wishlist."});
  }
  const reviewMatch=route.match(/^\/api\/products\/(\d+)\/reviews$/);
  if(req.method==="POST"&&reviewMatch){
    const session=await requireSession(req,res);if(!session)return;
    const body=await readJson(req),rating=Number(body.rating),title=cleanText(body.title,160),text=cleanText(body.body,2000);
    if(!Number.isInteger(rating)||rating<1||rating>5||text.length<5)return sendError(res,400,"Choose a 1–5 star rating and write a short review.");
    try{await dbPool.execute("INSERT INTO product_reviews (product_id,user_id,rating,title,body) VALUES (?,?,?,?,?)",[Number(reviewMatch[1]),session.user.id,rating,title,text]);return sendJson(res,201,{message:"Review submitted for approval."});}
    catch(error){if(error.code==="ER_DUP_ENTRY")return sendError(res,409,"You already reviewed this product.");throw error;}
  }

  if (req.method === "GET" && route === "/api/booking-settings") {
    if (!dbReady) return sendError(res,503,"Booking settings are loading.");
    const [rows]=await dbPool.query("SELECT setting_key,setting_value FROM booking_settings");
    const settings=Object.fromEntries(rows.map(row=>[row.setting_key,row.setting_value]));
    return sendJson(res,200,{settings:{timezone:settings.timezone||"Asia/Kolkata",slotIntervalMinutes:Number(settings.slot_interval_minutes||30),cancellationNoticeHours:Number(settings.cancellation_notice_hours||24),customerCanCancel:settings.customer_can_cancel!=="0"}});
  }

  if (req.method === "GET" && route === "/api/services") {
    if (!dbReady) return sendError(res, 503, "Appointments are being set up.");
    const [rows] = await dbPool.execute("SELECT s.id,s.name,s.description,s.duration_minutes,s.price,s.booking_mode,s.buffer_minutes,s.available_weekdays,s.start_time,s.end_time,s.min_notice_hours,s.max_advance_days,s.resource_ids,c.name AS category_name FROM services s LEFT JOIN service_categories c ON c.id=s.category_id WHERE s.active=1 ORDER BY c.name,s.created_at DESC LIMIT 100");
    const [extras] = await dbPool.execute("SELECT id,service_id,name,description,price,duration_minutes,price_per_day FROM service_extras WHERE active=1 ORDER BY service_id,name");
    const [resources] = await dbPool.execute("SELECT id,resource_type,name,location FROM booking_resources WHERE active=1 ORDER BY resource_type,name");
    for (const row of rows) { row.extras = extras.filter(extra => Number(extra.service_id) === Number(row.id)); let ids=[];try{ids=JSON.parse(row.resource_ids||"[]").map(Number)}catch(_){} row.resources=resources.filter(resource=>ids.includes(Number(resource.id))); }
    return sendJson(res, 200, { services: rows });
  }

  if (req.method === "POST" && route === "/api/bookings") {
    const session = await requireSession(req, res);
    if (!session) return;
    if (session.user.role !== "customer") return sendError(res,403,"Sign in with a customer account to request a booking.");
    const body = await readJson(req);
    const serviceId = Number(body.serviceId);
    const resourceId = Number(body.resourceId)||null;
    const dates = Array.isArray(body.dates) ? [...new Set(body.dates.map(x => cleanText(x, 10)).filter(x => /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(x)))].sort() : [];
    const dateTimes = new Map((Array.isArray(body.dateTimes) ? body.dateTimes : []).filter(x => x && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(String(x.date)) && typeof x.startsAt === "string").map(x => [x.date, x.startsAt]));
    const time = String(body.time || "09:00");
    const notes = cleanText(body.notes, 1000);
    const fullName = cleanText(body.fullName,160) || cleanText(session.user.name,120);
    const phone = cleanText(body.phone,40);
    const email = cleanText(body.email,254).toLowerCase();
    const address = cleanText(body.address,500);
    const postalCode = cleanText(body.postalCode,24);
    const extraIds = Array.isArray(body.extraIds) ? [...new Set(body.extraIds.map(Number).filter(x => Number.isInteger(x) && x > 0))].slice(0, 20) : [];
    if (!Number.isInteger(serviceId) || serviceId < 1 || !dates.length || dates.length > 31 || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(time)) return sendError(res, 400, "Choose a service, a valid time, and between 1 and 31 booking dates.");
    if (!validEmail(email) || email !== String(session.user.email || "").toLowerCase()) return sendError(res,400,"Enter the email address linked to your customer account.");
    if (!fullName || !phone || !address || !postalCode) return sendError(res,400,"Complete your full name, mobile number, address, and PIN code.");
    const conn = await dbPool.getConnection();
    let locks = [];
    try {
      await conn.beginTransaction();
      const [services] = await conn.execute("SELECT id,name,duration_minutes,price,booking_mode,buffer_minutes,available_weekdays,start_time,end_time,min_notice_hours,max_advance_days FROM services WHERE id=? AND active=1 LIMIT 1", [serviceId]);
      if (!services.length) { await conn.rollback(); return sendError(res, 404, "That service is not available."); }
      const service = services[0];
      let assignedResources=[];try{assignedResources=JSON.parse(service.resource_ids||"[]").map(Number)}catch(_){}
      if(assignedResources.length&&(!resourceId||!assignedResources.includes(resourceId))){await conn.rollback();return sendError(res,400,"Choose an available agent or studio for this service.");}
      if(resourceId&&!assignedResources.includes(resourceId)){await conn.rollback();return sendError(res,400,"That agent or studio is not assigned to this service.");}
      const durationMinutes = Number(service.duration_minutes);
      const earliest = Date.now() + Number(service.min_notice_hours || 0) * 3600000;
      const latest = Date.now() + Number(service.max_advance_days || 365) * 86400000;
      const addDays = (date, days) => new Date(Date.parse(date + "T00:00:00Z") + days * 86400000).toISOString().slice(0,10);
      const durationDays = service.booking_mode === "daily" ? Math.max(1,Math.ceil(durationMinutes / 1440)) : 1;
      const occurrences = dates.map(date => {
        const startsAt = new Date(dateTimes.get(date) || (date + "T" + (service.booking_mode === "daily" ? "00:00" : time) + ":00Z"));
        return { date, endDate: addDays(date,durationDays), time: service.booking_mode === "daily" ? "00:00" : time, startsAt };
      });
      if (occurrences.some(item => !Number.isFinite(item.startsAt.getTime()) || item.startsAt.getTime() < earliest || item.startsAt.getTime() > latest)) { await conn.rollback(); return sendError(res, 400, "Choose dates within this service’s booking window and notice period."); }
      const weekdays = String(service.available_weekdays || "0,1,2,3,4,5,6").split(",").map(Number);
      if (occurrences.some(item => !weekdays.includes(new Date(item.date + "T12:00:00Z").getUTCDay()))) { await conn.rollback(); return sendError(res, 400, "One or more selected dates are outside this service’s available days."); }
      if (service.booking_mode !== "daily" && service.start_time && service.end_time) {
        const open = String(service.start_time).slice(0,5), close = String(service.end_time).slice(0,5);
        if (occurrences.some(item => item.time < open || item.time >= close || (Number(item.time.slice(0,2))*60 + Number(item.time.slice(3))) + durationMinutes > Number(close.slice(0,2))*60 + Number(close.slice(3)))) { await conn.rollback(); return sendError(res, 400, "Choose a time within the service’s working hours."); }
      }
      const lockDates=[...new Set(occurrences.flatMap(item=>Array.from({length:durationDays},(_,index)=>addDays(item.date,index))))];
      const locksNeeded = lockDates.map(date => "booking-day:" + date).sort();
      for (const lockName of locksNeeded) {
        const [lock] = await conn.execute("SELECT GET_LOCK(?,5) AS acquired", [lockName]);
        if (!lock[0] || Number(lock[0].acquired) !== 1) { await conn.rollback(); return sendError(res, 409, "One of those dates is busy. Please try again."); }
        locks.push(lockName);
      }
      let extras = [];
      if (extraIds.length) {
        const marks = extraIds.map(() => "?").join(",");
        const [found] = await conn.execute("SELECT id,name,price,duration_minutes,price_per_day FROM service_extras WHERE service_id=? AND active=1 AND id IN (" + marks + ")", [serviceId,...extraIds]);
        if (found.length !== extraIds.length) { await conn.rollback(); return sendError(res, 400, "One or more selected extras are no longer available."); }
        extras = found;
      }
      const extraDuration = extras.reduce((sum,x)=>sum+Number(x.duration_minutes||0),0);
      const slotMinutes = durationMinutes + extraDuration + Number(service.buffer_minutes||0);
      if(service.booking_mode!=="daily"&&service.start_time&&service.end_time){const close=String(service.end_time).slice(0,5),closeMinutes=Number(close.slice(0,2))*60+Number(close.slice(3));if(occurrences.some(item=>Number(item.time.slice(0,2))*60+Number(item.time.slice(3))+slotMinutes>closeMinutes)){await conn.rollback();return sendError(res,400,"The selected extras or buffer extend beyond the service closing time.");}}
      const [existing] = await conn.execute("SELECT b.starts_at,b.resource_id,DATE_FORMAT(b.starts_at,'%Y-%m-%d') AS legacy_date,DATE_FORMAT(b.starts_at,'%H:%i') AS legacy_time,b.booking_dates_json,s.duration_minutes,s.booking_mode,s.buffer_minutes FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.status IN ('requested','confirmed') AND b.starts_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 365 DAY) LIMIT 5000");
      const conflicts = occurrences.some(candidate => existing.some(row => {
        let saved; try { saved = row.booking_dates_json ? JSON.parse(row.booking_dates_json) : null; } catch (_) {}
        if(resourceId&&row.resource_id&&Number(resourceId)!==Number(row.resource_id))return false;
        const slots = Array.isArray(saved) && saved.length ? saved : [{date:row.legacy_date,time:row.legacy_time}];
        return slots.some(slot => {
          const rowDays = row.booking_mode === "daily" ? Math.max(1,Math.ceil(Number(row.duration_minutes||1440)/1440)) : 1;
          const slotEnd = slot.endDate || addDays(slot.date,rowDays);
          if (service.booking_mode === "daily" || row.booking_mode === "daily") return candidate.date < slotEnd && candidate.endDate > slot.date;
          if (slot.date !== candidate.date) return false;
          const currentStart = candidate.startsAt.getTime();
          const bookedStart = slot.startsAt ? new Date(slot.startsAt).getTime() : new Date(slot.date + "T" + (slot.time || "00:00") + ":00").getTime();
          const bookedDuration = Number(row.duration_minutes||60) + Number(row.buffer_minutes||0);
          return currentStart < bookedStart + bookedDuration*60000 && currentStart + slotMinutes*60000 > bookedStart;
        });
      }));
      if (conflicts) { await conn.rollback(); return sendError(res, 409, "One or more selected dates or times are already booked."); }
      const bookingTotal = occurrences.reduce((sum, occurrence) => sum + Number(service.price || 0) + extras.reduce((extraSum, extra) => extraSum + Number(extra.price || 0) * (Number(extra.price_per_day) ? 1 : (occurrences.indexOf(occurrence) === 0 ? 1 : 0)), 0), 0);
      const bookingDates = occurrences.map(item => ({date:item.date,endDate:item.endDate,time:item.time,startsAt:item.startsAt.toISOString()}));
      const first = occurrences[0].startsAt.toISOString().slice(0,19).replace("T"," ");
      const [result] = await conn.execute("INSERT INTO bookings (user_id,service_id,starts_at,notes,booking_dates_json,booking_extras_json,total_price,resource_id,customer_full_name,customer_phone,customer_address,customer_postal_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [session.user.id,serviceId,first,notes,JSON.stringify(bookingDates),JSON.stringify(extras.map(x=>({id:x.id,name:x.name,price:Number(x.price),durationMinutes:Number(x.duration_minutes),pricePerDay:Boolean(Number(x.price_per_day))}))),bookingTotal.toFixed(2),resourceId,fullName,phone,address,postalCode]);
      for (const lockName of locks) await conn.execute("SELECT RELEASE_LOCK(?)", [lockName]);
      locks = [];
      await conn.commit();
      let emailSent = false;
      if (process.env.SMTP_PASS) emailSent = await sendMail(session.user.email, "LuMekH booking request received", "<p>Your booking request for " + service.name + " covering " + bookingDates.map(x=>x.date).join(", ") + " has been received.</p><p>Estimated total: ₹" + bookingTotal.toFixed(2) + "</p>");
      return sendJson(res, 201, { message: "Booking request saved for " + bookingDates.length + (bookingDates.length === 1 ? " date." : " dates.") + (emailSent ? " A confirmation email was sent." : ""), bookingId: result.insertId, totalPrice: bookingTotal, emailSent });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally {
      for (const lockName of locks) { try { await conn.execute("SELECT RELEASE_LOCK(?)", [lockName]); } catch (_) {} }
      conn.release();
    }
  }

  const cancelBookingMatch = route.match(new RegExp("^/api/bookings/([0-9]+)/cancel$"));
  if (req.method === "POST" && cancelBookingMatch) {
    const session=await requireSession(req,res);if(!session)return;
    if(session.user.role!=="customer")return sendError(res,403,"Only customer accounts can cancel their own bookings.");
    const [settingsRows]=await dbPool.query("SELECT setting_key,setting_value FROM booking_settings");
    const settings=Object.fromEntries(settingsRows.map(row=>[row.setting_key,row.setting_value]));
    if(settings.customer_can_cancel==="0")return sendError(res,403,"Online booking cancellation is disabled. Contact us for help.");
    const id=Number(cancelBookingMatch[1]),[[booking]]=await dbPool.execute("SELECT id,status,starts_at FROM bookings WHERE id=? AND user_id=? LIMIT 1",[id,session.user.id]);
    if(!booking)return sendError(res,404,"Booking not found.");
    if(!["requested","confirmed"].includes(booking.status))return sendError(res,409,"This booking can no longer be cancelled online.");
    const notice=Number(settings.cancellation_notice_hours||24)*3600000;
    if(new Date(booking.starts_at).getTime()-Date.now()<notice)return sendError(res,400,"This booking is inside the cancellation notice window. Contact us for help.");
    await dbPool.execute("UPDATE bookings SET status='cancelled' WHERE id=? AND user_id=?",[id,session.user.id]);
    return sendJson(res,200,{message:"Booking cancelled."});
  }

  if (req.method === "POST" && route === "/api/orders") {
    const session = await requireSession(req, res);
    if (!session) return;
    const body = await readJson(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
    const fullName = cleanText(body.fullName, 160) || session.user.name;
    const phone = cleanText(body.phone, 40);
    const email = cleanText(body.email, 254).toLowerCase();
    const address = cleanText(body.address, 500);
    const city = cleanText(body.city, 120) || "";
    const postalCode = cleanText(body.postalCode, 24);
    if (!validEmail(email) || email !== String(session.user.email || "").toLowerCase()) return sendError(res, 400, "Enter the email address linked to your customer account.");
    if (!items.length) return sendError(res, 400, "Add at least one item to your basket.");
    const conn = await dbPool.getConnection();
    try {
      await conn.beginTransaction();
      let total = 0;
      const lines = [];
      let requiresShipping = false;
      for (const item of items) {
        const productId = Number(item.productId);
        const quantity = Number(item.quantity);
        if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 25) { await conn.rollback(); return sendError(res, 400, "One of the basket items is not valid."); }
        const [found] = await conn.execute("SELECT id,name,price,sale_price,stock,image_url,sku,product_type FROM products WHERE id=? AND active=1 LIMIT 1 FOR UPDATE", [productId]);
        if (!found.length) { await conn.rollback(); return sendError(res, 409, "A product in your basket is no longer available."); }
        const product = found[0], type = product.product_type || "simple";
        let variant = null;
        if (type === "variable") {
          const variantId = Number(item.variantId);
          if (!Number.isInteger(variantId) || variantId < 1) { await conn.rollback(); return sendError(res, 400, "Choose a variation for " + product.name + "."); }
          const [variants] = await conn.execute("SELECT id,name,sku,price,stock FROM product_variants WHERE id=? AND product_id=? AND active=1 LIMIT 1 FOR UPDATE", [variantId,productId]);
          if (!variants.length) { await conn.rollback(); return sendError(res, 409, "That product option is no longer available."); }
          variant = variants[0];
        }
        const unitPrice = variant && variant.price !== null ? Number(variant.price) : Number(product.sale_price !== null ? product.sale_price : product.price);
        const stock = variant && variant.stock !== null ? variant.stock : product.stock;
        if (stock !== null && Number(stock) < quantity) { await conn.rollback(); return sendError(res, 409, product.name + (variant ? " · " + variant.name : "") + " has limited stock. Update your basket and try again."); }
        if (type !== "digital") requiresShipping = true;
        total += unitPrice * quantity;
        lines.push({id:product.id,name:product.name,displayName:product.name+(variant?" · "+variant.name:""),price:unitPrice,quantity,stock,type,variantId:variant?variant.id:null,sku:variant?variant.sku:product.sku,imageUrl:product.image_url});
      }
      if (!fullName || !phone || !address || !postalCode) { await conn.rollback(); return sendError(res, 400, "Complete your full name, mobile number, address, and PIN code."); }
      const [order] = await conn.execute("INSERT INTO orders (user_id,total,full_name,phone,address,city,postal_code,subtotal) VALUES (?,?,?,?,?,?,?,?)", [session.user.id,total,fullName,phone,address,city,postalCode,total]);
      for (const line of lines) {
        const lineTotal = line.price * line.quantity;
        await conn.execute("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price,variant_id,sku,image_url,line_total) VALUES (?,?,?,?,?,?,?,?,?)", [order.insertId,line.id,line.displayName,line.quantity,line.price,line.variantId,line.sku,line.imageUrl,lineTotal]);
        if (line.stock !== null) {
          if (line.variantId) await conn.execute("UPDATE product_variants SET stock=stock-? WHERE id=? AND stock IS NOT NULL",[line.quantity,line.variantId]);
          else await conn.execute("UPDATE products SET stock=stock-? WHERE id=? AND stock IS NOT NULL",[line.quantity,line.id]);
        }
      }
      await conn.commit();
      let emailSent = false;
      if (process.env.SMTP_PASS) emailSent = await sendMail(email,"LuMekH order received","<p>Your order #"+order.insertId+" has been received. Total: ₹"+total.toFixed(2)+".</p><p>Payment will be confirmed separately.</p>");
      return sendJson(res,201,{message:"Order request saved. Payment will be confirmed separately.",orderId:order.insertId,total,emailSent});
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  if (req.method === "GET" && route === "/api/account") {
    const session = await getSession(req);
    if (!session) return sendError(res, 401, "Please sign in to view your account.");
    if (!dbReady) return sendError(res, 503, "Your account data is being prepared.");
    const [orders] = await dbPool.execute("SELECT id,total,status,payment_status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100", [session.user.id]);
    const [bookings] = await dbPool.execute("SELECT b.id,b.starts_at,b.booking_dates_json,b.booking_extras_json,b.total_price,b.status,b.notes,s.name AS service_name,s.duration_minutes,s.booking_mode,r.name AS resource_name,r.resource_type FROM bookings b JOIN services s ON s.id=b.service_id LEFT JOIN booking_resources r ON r.id=b.resource_id WHERE b.user_id=? ORDER BY b.starts_at DESC LIMIT 100", [session.user.id]);
    const [downloads] = await dbPool.execute("SELECT o.id AS order_id,p.id AS product_id,p.name AS product_name FROM orders o JOIN order_items oi ON oi.order_id=o.id JOIN products p ON p.id=oi.product_id WHERE o.user_id=? AND p.product_type='digital' AND (o.status='completed' OR o.payment_status='paid') ORDER BY o.created_at DESC", [session.user.id]);
    return sendJson(res, 200, { user: session.user, orders, bookings, downloads });
  }

  if (route.startsWith("/api/admin/")) {
    const session = await getSession(req);
    if (!session) return sendError(res, 401, "Please sign in.");
    if (session.user.role !== "admin") return sendError(res, 403, "CRM Admin access is required.");
    if (!dbReady) return sendError(res, 503, "CRM data is being prepared.");
    if (req.method !== "GET" && !safeEqual(String(req.headers["x-csrf-token"] || ""), session.csrfToken)) return sendError(res, 403, "Please refresh the page and try again.");

    if (req.method === "GET" && route === "/api/admin/summary") {
      const [rows] = await dbPool.query("SELECT (SELECT COUNT(*) FROM app_users WHERE role='customer') AS customers,(SELECT COUNT(*) FROM products WHERE active=1) AS products,(SELECT COUNT(*) FROM services WHERE active=1) AS services,(SELECT COUNT(*) FROM bookings WHERE status='requested') AS pending_bookings,(SELECT COUNT(*) FROM orders WHERE status='new') AS new_orders");
      return sendJson(res, 200, rows[0]);
    }
    if (req.method === "GET" && route === "/api/admin/customers") {
      const q = "%" + cleanText(url.searchParams.get("q"), 80) + "%";
      const [rows] = await dbPool.execute("SELECT id,name,email,created_at,email_verified FROM app_users WHERE role='customer' AND (name LIKE ? OR email LIKE ?) ORDER BY created_at DESC LIMIT 200", [q, q]);
      return sendJson(res, 200, { customers: rows });
    }
    const uploadMatch = route.match(/^\/api\/admin\/media$/);
    if (req.method === "POST" && uploadMatch) {
      const kind = url.searchParams.get("kind") === "download" ? "download" : "image";
      const limit = kind === "image" ? 8_000_000 : 15_000_000;
      const data = await readRaw(req,limit);
      if (!data.length) return sendError(res,400,"Choose a file to upload.");
      let fileName = "upload";
      try { fileName = decodeURIComponent(String(req.headers["x-file-name"] || "upload")); } catch (_) {}
      fileName = path.basename(fileName).replace(/[\\"\r\n]/g,"_").slice(0,255) || "upload";
      let mimeType = "application/octet-stream";
      if (kind === "image") {
        const header = data.subarray(0,12);
        if (header[0]===0xff&&header[1]===0xd8&&header[2]===0xff) mimeType="image/jpeg";
        else if (header.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) mimeType="image/png";
        else if (header.toString("ascii",0,4)==="RIFF"&&header.toString("ascii",8,12)==="WEBP") mimeType="image/webp";
        else if (header.toString("ascii",0,3)==="GIF") mimeType="image/gif";
        else return sendError(res,415,"Use a JPG, PNG, WebP, or GIF image.");
      }
      const [saved] = await dbPool.execute("INSERT INTO media_assets (file_name,mime_type,file_size,is_private,data) VALUES (?,?,?,?,?)",[fileName,mimeType,data.length,kind==="download"?1:0,data]);
      return sendJson(res,201,{media:{id:saved.insertId,fileName,url:kind==="image"?"/api/media/"+saved.insertId:null,private:kind==="download"}});
    }
    if (req.method === "GET" && route === "/api/admin/categories") {
      const [categories] = await dbPool.query("SELECT c.id,c.name,c.slug,c.description,c.active,COUNT(p.id) AS product_count FROM product_categories c LEFT JOIN products p ON p.category_id=c.id GROUP BY c.id ORDER BY c.sort_order,c.name");
      return sendJson(res,200,{categories});
    }
    if (req.method === "POST" && route === "/api/admin/categories") {
      const body=await readJson(req), name=cleanText(body.name,120), description=cleanText(body.description,1000);
      if(name.length<2)return sendError(res,400,"Enter a category name.");
      const slug=name.toLowerCase().normalize("NFKD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"").slice(0,140)||"category";
      const [result]=await dbPool.execute("INSERT INTO product_categories (name,slug,description) VALUES (?,?,?)",[name,slug+"-"+randomBytes(3).toString("hex"),description]);
      return sendJson(res,201,{id:result.insertId,message:"Category added."});
    }
    if (req.method === "GET" && route === "/api/admin/products") {
      const [rows] = await dbPool.query("SELECT p.id,p.name,p.short_description,p.description,p.price,p.sale_price,p.stock,p.image_url,p.sku,p.active,p.featured,p.product_type,p.category_id,p.download_media_id,p.created_at,c.name AS category_name,(SELECT COUNT(*) FROM product_variants v WHERE v.product_id=p.id AND v.active=1) AS variant_count,(SELECT COUNT(*) FROM product_images i WHERE i.product_id=p.id) AS image_count FROM products p LEFT JOIN product_categories c ON c.id=p.category_id ORDER BY p.created_at DESC LIMIT 300");
      return sendJson(res,200,{products:rows});
    }
    const productDetailMatch=route.match(/^\/api\/admin\/products\/(\d+)$/);
    if(req.method==="GET"&&productDetailMatch){
      const id=Number(productDetailMatch[1]);
      const [[product]]=await dbPool.execute("SELECT id,name,short_description,description,price,sale_price,stock,image_url,sku,active,featured,product_type,category_id,weight_grams,download_media_id FROM products WHERE id=? LIMIT 1",[id]);
      if(!product)return sendError(res,404,"Product not found.");
      const [images]=await dbPool.execute("SELECT id,image_url,alt_text FROM product_images WHERE product_id=? ORDER BY sort_order,id",[id]);
      const [variants]=await dbPool.execute("SELECT id,sku,name,attributes_json,price,stock FROM product_variants WHERE product_id=? ORDER BY id",[id]);
      return sendJson(res,200,{product,images,variants});
    }
    const productRoute = route.match(/^\/api\/admin\/products(?:\/(\d+))?$/);
    if ((req.method==="POST"&&route==="/api/admin/products") || (req.method==="PATCH"&&productRoute&&productRoute[1])) {
      const body=await readJson(req);
      const id=productRoute&&productRoute[1]?Number(productRoute[1]):0;
      const name=cleanText(body.name,160), shortDescription=cleanText(body.shortDescription,500), description=cleanText(body.description,10000);
      const price=Number(body.price), salePrice=body.salePrice===""||body.salePrice===null||body.salePrice===undefined?null:Number(body.salePrice);
      const stock=body.stock===""||body.stock===null||body.stock===undefined?null:Number(body.stock);
      const sku=cleanText(body.sku,64)||null, productType=["simple","variable","digital"].includes(body.productType)?body.productType:"simple";
      const categoryId=Number(body.categoryId)||null, featured=body.featured?1:0;
      const weight=body.weightGrams===""||body.weightGrams===null||body.weightGrams===undefined?null:Number(body.weightGrams);
      const downloadId=productType==="digital"?Number(body.downloadMediaId)||null:null;
      if(name.length<2||!Number.isFinite(price)||price<0||(salePrice!==null&&(!Number.isFinite(salePrice)||salePrice<0||salePrice>price))||(stock!==null&&(!Number.isInteger(stock)||stock<0))||(weight!==null&&(!Number.isInteger(weight)||weight<0)))return sendError(res,400,"Check the name, prices, stock, and weight.");
      if(productType==="variable"&&(!Array.isArray(body.variants)||!body.variants.length))return sendError(res,400,"Add at least one variation to a variable product.");
      if(productType==="digital"&&!downloadId)return sendError(res,400,"Upload a digital product file.");
      if(downloadId){const [[file]]=await dbPool.execute("SELECT id FROM media_assets WHERE id=? AND is_private=1 LIMIT 1",[downloadId]);if(!file)return sendError(res,400,"Upload the download file again.");}
      const images=Array.isArray(body.images)?body.images.slice(0,12):[];
      const variants=Array.isArray(body.variants)?body.variants.slice(0,100):[];
      const imageUrl=images.length?cleanText(typeof images[0]==="string"?images[0]:images[0].url,1000):cleanText(body.imageUrl,1000);
      const conn=await dbPool.getConnection();
      try{
        await conn.beginTransaction();
        let productId=id;
        if(id){
          const [found]=await conn.execute("SELECT id FROM products WHERE id=? LIMIT 1",[id]);
          if(!found.length){await conn.rollback();return sendError(res,404,"Product not found.");}
          await conn.execute("UPDATE products SET name=?,short_description=?,description=?,price=?,sale_price=?,stock=?,image_url=?,sku=?,product_type=?,category_id=?,featured=?,is_virtual=?,weight_grams=?,download_media_id=? WHERE id=?",[name,shortDescription,description,price,salePrice,stock,imageUrl||null,sku,productType,categoryId,featured,productType==="digital"?1:0,weight,downloadId,id]);
        }else{
          const [result]=await conn.execute("INSERT INTO products (name,short_description,description,price,sale_price,stock,image_url,sku,product_type,category_id,featured,is_virtual,weight_grams,download_media_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",[name,shortDescription,description,price,salePrice,stock,imageUrl||null,sku,productType,categoryId,featured,productType==="digital"?1:0,weight,downloadId]);
          productId=result.insertId;
        }
        await conn.execute("DELETE FROM product_images WHERE product_id=?",[productId]);
        for(const [index,image] of images.entries()){
          const url=cleanText(typeof image==="string"?image:image.url,1000), alt=cleanText(typeof image==="string"?"":image.alt,180);
          if(url)await conn.execute("INSERT INTO product_images (product_id,image_url,alt_text,sort_order) VALUES (?,?,?,?)",[productId,url,alt,index]);
        }
        await conn.execute("DELETE FROM product_variants WHERE product_id=?",[productId]);
        if(productType==="variable")for(const v of variants){
          const variantName=cleanText(v.name,160), variantSku=cleanText(v.sku,64)||null, attrs=typeof v.attributes==="object"&&v.attributes?v.attributes:{Options:cleanText(v.attributes,300)};
          const variantPrice=v.price===""||v.price===null||v.price===undefined?null:Number(v.price), variantStock=v.stock===""||v.stock===null||v.stock===undefined?null:Number(v.stock);
          if(!variantName||((variantPrice!==null)&&(!Number.isFinite(variantPrice)||variantPrice<0))||((variantStock!==null)&&(!Number.isInteger(variantStock)||variantStock<0)))throw Object.assign(new Error("Check each variation name, price, and stock."),{status:400});
          await conn.execute("INSERT INTO product_variants (product_id,sku,name,attributes_json,price,stock) VALUES (?,?,?,?,?,?)",[productId,variantSku,variantName,JSON.stringify(attrs),variantPrice,variantStock]);
        }
        await conn.commit();
        return sendJson(res,id?200:201,{id:productId,message:id?"Product updated.":"Product added."});
      }catch(error){await conn.rollback();throw error;}finally{conn.release();}
    }
    if (req.method==="PATCH"&&/^\/api\/admin\/products\/\d+\/visibility$/.test(route)) {
      const id=Number(route.split("/")[4]),body=await readJson(req);
      if(typeof body.active!=="boolean")return sendError(res,400,"Choose whether this product should be visible.");
      await dbPool.execute("UPDATE products SET active=? WHERE id=?",[body.active?1:0,id]);
      return sendJson(res,200,{message:body.active?"Product published.":"Product hidden."});
    }
    if (req.method === "GET" && route === "/api/admin/resources") {
      const [rows]=await dbPool.query("SELECT id,resource_type,name,email,location,timezone,active FROM booking_resources ORDER BY resource_type,name");
      return sendJson(res,200,{resources:rows});
    }
    if (req.method === "POST" && route === "/api/admin/resources") {
      const body=await readJson(req),type=body.type==="studio"?"studio":"agent",name=cleanText(body.name,160),email=cleanText(body.email,254),location=cleanText(body.location,500),timezone=cleanText(body.timezone,80)||"Asia/Kolkata";
      if(name.length<2||(email&&!validEmail(email)))return sendError(res,400,"Enter a resource name and a valid optional email.");
      const [result]=await dbPool.execute("INSERT INTO booking_resources (resource_type,name,email,location,timezone) VALUES (?,?,?,?,?)",[type,name,email,location,timezone]);
      return sendJson(res,201,{id:result.insertId,message:"Agent or studio added."});
    }
    const resourceMatch=route.match(new RegExp("^/api/admin/resources/([0-9]+)$"));
    if(req.method==="PATCH"&&resourceMatch) {
      const body=await readJson(req);if(typeof body.active!=="boolean")return sendError(res,400,"Choose whether this resource is active.");
      await dbPool.execute("UPDATE booking_resources SET active=? WHERE id=?",[body.active?1:0,Number(resourceMatch[1])]);return sendJson(res,200,{message:"Resource updated."});
    }
    if (req.method === "GET" && route === "/api/admin/service-categories") {
      const [rows] = await dbPool.query("SELECT id,name,description,active FROM service_categories ORDER BY name");
      return sendJson(res,200,{categories:rows});
    }
    if (req.method === "POST" && route === "/api/admin/service-categories") {
      const body=await readJson(req),name=cleanText(body.name,120),description=cleanText(body.description,1000);
      if(name.length<2)return sendError(res,400,"Enter a category name.");
      try { const [result]=await dbPool.execute("INSERT INTO service_categories (name,description) VALUES (?,?)",[name,description]);return sendJson(res,201,{id:result.insertId,message:"Category added."}); }
      catch(error) { if(error.code==="ER_DUP_ENTRY")return sendError(res,409,"That service category already exists.");throw error; }
    }
    if (req.method === "GET" && route === "/api/admin/service-extras") {
      const [rows]=await dbPool.query("SELECT e.id,e.service_id,e.name,e.description,e.price,e.duration_minutes,e.price_per_day,e.active,s.name AS service_name FROM service_extras e JOIN services s ON s.id=e.service_id ORDER BY s.name,e.name");
      return sendJson(res,200,{extras:rows});
    }
    if (req.method === "POST" && route === "/api/admin/service-extras") {
      const body=await readJson(req),serviceId=Number(body.serviceId),name=cleanText(body.name,160),description=cleanText(body.description,1000),price=Number(body.price),duration=Number(body.durationMinutes||0);
      if(!Number.isInteger(serviceId)||serviceId<1||name.length<2||!Number.isFinite(price)||price<0||!Number.isInteger(duration)||duration<0||duration>720)return sendError(res,400,"Enter a service, extra name, valid price, and duration.");
      const [result]=await dbPool.execute("INSERT INTO service_extras (service_id,name,description,price,duration_minutes,price_per_day) SELECT ?,?,?,?,?,? FROM services WHERE id=?",[serviceId,name,description,price,duration,body.pricePerDay?1:0,serviceId]);
      if(!result.affectedRows)return sendError(res,404,"That service was not found.");
      return sendJson(res,201,{id:result.insertId,message:"Extra added."});
    }
    const extraMatch=route.match(new RegExp("^/api/admin/service-extras/([0-9]+)$"));
    if(req.method==="PATCH"&&extraMatch) {
      const body=await readJson(req);if(typeof body.active!=="boolean")return sendError(res,400,"Choose whether the extra is active.");
      await dbPool.execute("UPDATE service_extras SET active=? WHERE id=?",[body.active?1:0,Number(extraMatch[1])]);return sendJson(res,200,{message:"Extra updated."});
    }
    if (req.method === "GET" && route === "/api/admin/booking-settings") {
      const [rows]=await dbPool.query("SELECT setting_key,setting_value FROM booking_settings");
      const settings=Object.fromEntries(rows.map(row=>[row.setting_key,row.setting_value]));
      return sendJson(res,200,{settings:{timezone:settings.timezone||"Asia/Kolkata",slotIntervalMinutes:Number(settings.slot_interval_minutes||30),cancellationNoticeHours:Number(settings.cancellation_notice_hours||24),customerCanCancel:settings.customer_can_cancel!=="0",googleCalendarConnected:settings.google_calendar_connected==="1"}});
    }
    if (req.method === "PUT" && route === "/api/admin/booking-settings") {
      const body=await readJson(req),timezone=cleanText(body.timezone,80),interval=Number(body.slotIntervalMinutes),notice=Number(body.cancellationNoticeHours);
      if(!timezone||!Number.isInteger(interval)||interval<5||interval>240||!Number.isInteger(notice)||notice<0||notice>720||typeof body.customerCanCancel!=="boolean")return sendError(res,400,"Check the timezone, slot interval, and cancellation settings.");
      for(const [key,value] of [["timezone",timezone],["slot_interval_minutes",String(interval)],["cancellation_notice_hours",String(notice)],["customer_can_cancel",body.customerCanCancel?"1":"0"]]) await dbPool.execute("INSERT INTO booking_settings (setting_key,setting_value) VALUES (?,?) ON DUPLICATE KEY UPDATE setting_value=VALUES(setting_value)",[key,value]);
      return sendJson(res,200,{message:"Booking settings saved."});
    }
    if (req.method === "GET" && route === "/api/admin/services") {
      const [rows] = await dbPool.query("SELECT s.id,s.name,s.description,s.duration_minutes,s.price,s.active,s.category_id,s.booking_mode,s.buffer_minutes,s.available_weekdays,s.start_time,s.end_time,s.min_notice_hours,s.max_advance_days,s.resource_ids,c.name AS category_name FROM services s LEFT JOIN service_categories c ON c.id=s.category_id ORDER BY s.created_at DESC LIMIT 200");
      const [extras]=await dbPool.query("SELECT id,service_id,name,description,price,duration_minutes,price_per_day,active FROM service_extras ORDER BY service_id,name");
      for(const row of rows){row.extras=extras.filter(extra=>Number(extra.service_id)===Number(row.id));try{row.resourceIds=JSON.parse(row.resource_ids||"[]")}catch(_){row.resourceIds=[]}}
      return sendJson(res, 200, { services: rows });
    }
    const serviceEdit=route.match(new RegExp("^/api/admin/services/([0-9]+)$"));
    if ((req.method==="POST" && route === "/api/admin/services") || (req.method==="PATCH" && serviceEdit)) {
      const body=await readJson(req),id=serviceEdit?Number(serviceEdit[1]):null;
      if(id&&typeof body.active==="boolean"&&!body.name){await dbPool.execute("UPDATE services SET active=? WHERE id=?",[body.active?1:0,id]);return sendJson(res,200,{message:body.active?"Service shown.":"Service hidden."});}
      const name=cleanText(body.name,160),description=cleanText(body.description,3000),mode=body.bookingMode==="daily"?"daily":"hourly";
      const duration=Number(body.durationMinutes),price=Number(body.price),categoryId=Number(body.categoryId)||null;
      const resourceIds=Array.isArray(body.resourceIds)?[...new Set(body.resourceIds.map(Number).filter(x=>Number.isInteger(x)&&x>0))]:[];
      const buffer=Number(body.bufferMinutes||0),weekdays=Array.isArray(body.availableWeekdays)?[...new Set(body.availableWeekdays.map(Number).filter(x=>Number.isInteger(x)&&x>=0&&x<=6))]:[0,1,2,3,4,5,6];
      const open=String(body.startTime||""),close=String(body.endTime||""),minNotice=Number(body.minNoticeHours||0),maxAdvance=Number(body.maxAdvanceDays||365);
      if(name.length<2||!Number.isInteger(duration)||duration<(mode==="daily"?1:5)||duration>(mode==="daily"?45:720)||!Number.isFinite(price)||price<0||!Number.isInteger(buffer)||buffer<0||buffer>720||!weekdays.length||!Number.isInteger(minNotice)||minNotice<0||minNotice>720||!Number.isInteger(maxAdvance)||maxAdvance<1||maxAdvance>730||((open||close)&&(!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(open)||!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(close)||open>=close)))return sendError(res,400,"Check the service details, duration, price, weekdays, and availability hours.");
      if(categoryId){const [[found]]=await dbPool.execute("SELECT id FROM service_categories WHERE id=? AND active=1",[categoryId]);if(!found)return sendError(res,400,"Choose an available category.");}
      if(resourceIds.length){const marks=resourceIds.map(()=>"?").join(",");const [found]=await dbPool.execute("SELECT id FROM booking_resources WHERE active=1 AND id IN ("+marks+")",resourceIds);if(found.length!==resourceIds.length)return sendError(res,400,"Choose available agents or studios.");}
      const minutes=mode==="daily"?1440*duration:duration;
      if(id){await dbPool.execute("UPDATE services SET name=?,description=?,duration_minutes=?,price=?,category_id=?,booking_mode=?,buffer_minutes=?,available_weekdays=?,start_time=?,end_time=?,min_notice_hours=?,max_advance_days=?,resource_ids=? WHERE id=?",[name,description,minutes,price,categoryId,mode,buffer,weekdays.join(","),open||null,close||null,minNotice,maxAdvance,JSON.stringify(resourceIds),id]);return sendJson(res,200,{message:"Service updated."});}
      const [result]=await dbPool.execute("INSERT INTO services (name,description,duration_minutes,price,category_id,booking_mode,buffer_minutes,available_weekdays,start_time,end_time,min_notice_hours,max_advance_days,resource_ids) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",[name,description,minutes,price,categoryId,mode,buffer,weekdays.join(","),open||null,close||null,minNotice,maxAdvance,JSON.stringify(resourceIds)]);
      return sendJson(res,201,{id:result.insertId,message:"Service added."});
    }
    if (req.method === "GET" && route === "/api/admin/bookings") {
      const [rows] = await dbPool.query("SELECT b.id,b.starts_at,b.booking_dates_json,b.booking_extras_json,b.total_price,b.status,b.notes,b.created_at,b.customer_full_name,b.customer_phone,b.customer_address,b.customer_postal_code,COALESCE(NULLIF(b.customer_full_name,''),u.name) AS customer_name,u.email AS customer_email,s.name AS service_name,s.duration_minutes,s.booking_mode,s.price,r.name AS resource_name,r.resource_type FROM bookings b JOIN app_users u ON u.id=b.user_id JOIN services s ON s.id=b.service_id LEFT JOIN booking_resources r ON r.id=b.resource_id ORDER BY b.starts_at DESC LIMIT 300");
      return sendJson(res, 200, { bookings: rows });
    }
    if (req.method === "GET" && route === "/api/admin/orders") {
      const [rows] = await dbPool.query("SELECT o.id,o.total,o.status,o.full_name,o.phone,o.address,o.city,o.postal_code,o.created_at,u.email AS customer_email FROM orders o JOIN app_users u ON u.id=o.user_id ORDER BY o.created_at DESC LIMIT 300");
      return sendJson(res, 200, { orders: rows });
    }
    const statusMatch = route.match(/^\/api\/admin\/(bookings|orders)\/(\d+)$/);
    if (req.method === "PATCH" && statusMatch) {
      const body = await readJson(req);
      const table = statusMatch[1];
      const allowed = table === "bookings" ? ["requested","confirmed","cancelled","completed"] : ["new","processing","completed","cancelled"];
      if (!allowed.includes(body.status)) return sendError(res, 400, "That status is not available.");
      await dbPool.execute("UPDATE " + table + " SET status=? WHERE id=?", [body.status, Number(statusMatch[2])]);
      return sendJson(res, 200, { message: "Status updated." });
    }
    const activeMatch = route.match(/^\/api\/admin\/(products|services)\/(\d+)$/);
    if (req.method === "PATCH" && activeMatch) {
      const body = await readJson(req);
      if (typeof body.active !== "boolean") return sendError(res, 400, "Choose whether this item should be visible.");
      await dbPool.execute("UPDATE " + activeMatch[1] + " SET active=? WHERE id=?", [body.active ? 1 : 0, Number(activeMatch[2])]);
      return sendJson(res, 200, { message: body.active ? "Item shown." : "Item hidden." });
    }
    return sendError(res, 404, "CRM route not found.");
  }
  return sendError(res, 404, "API route not found.");
}

async function serveStatic(res, pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (_) { res.writeHead(400); res.end("Bad request"); return; }
  const requested = decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
  const filePath = path.resolve(publicDir, requested);
  if (!filePath.startsWith(publicDir + path.sep)) { res.writeHead(403); res.end("Forbidden"); return; }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(error.code === "ENOENT" ? "Page not found." : "Could not load this page.");
      return;
    }
    res.writeHead(200, { "Content-Type": mimeTypes[path.extname(filePath)] || "application/octet-stream", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY" });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") { res.writeHead(405, { Allow: "GET, HEAD" }); res.end("Method not allowed."); return; }
    return serveStatic(res, url.pathname);
  } catch (error) {
    console.error("Request failed:", error.message);
    if (!res.headersSent) sendError(res, error.status || 500, error.status ? error.message : "Something went wrong. Please try again.");
    else res.end();
  }
});
server.listen(Number(process.env.PORT || 3000), "0.0.0.0", () => {
  console.log("LuMekH is listening on port " + (process.env.PORT || 3000));
  if (dbConfigured) initializeDatabase();
});
process.on("SIGTERM", async () => {
  server.close();
  if (dbPool) await dbPool.end().catch(() => {});
  process.exit(0);
});
