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
  "CREATE TABLE IF NOT EXISTS bookings (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, service_id BIGINT UNSIGNED NOT NULL, starts_at DATETIME NOT NULL, status ENUM('requested','confirmed','cancelled','completed') NOT NULL DEFAULT 'requested', notes VARCHAR(1000) NOT NULL DEFAULT '', created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_bookings_start (starts_at, status), INDEX idx_bookings_user (user_id, starts_at), CONSTRAINT fk_bookings_user FOREIGN KEY (user_id) REFERENCES app_users(id), CONSTRAINT fk_bookings_service FOREIGN KEY (service_id) REFERENCES services(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS orders (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, user_id BIGINT UNSIGNED NOT NULL, total DECIMAL(10,2) NOT NULL, status ENUM('new','processing','completed','cancelled') NOT NULL DEFAULT 'new', full_name VARCHAR(160) NOT NULL, phone VARCHAR(40) NOT NULL, address VARCHAR(500) NOT NULL, city VARCHAR(120) NOT NULL, postal_code VARCHAR(24) NOT NULL, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP, INDEX idx_orders_user (user_id, created_at), INDEX idx_orders_created (created_at), CONSTRAINT fk_orders_user FOREIGN KEY (user_id) REFERENCES app_users(id)) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS order_items (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, order_id BIGINT UNSIGNED NOT NULL, product_id BIGINT UNSIGNED NOT NULL, product_name VARCHAR(160) NOT NULL, quantity SMALLINT UNSIGNED NOT NULL, unit_price DECIMAL(10,2) NOT NULL, INDEX idx_order_items_order (order_id), CONSTRAINT fk_order_items_order FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS product_categories (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, name VARCHAR(120) NOT NULL, slug VARCHAR(150) NOT NULL UNIQUE, description VARCHAR(1000) NOT NULL DEFAULT '', active TINYINT(1) NOT NULL DEFAULT 1, sort_order INT NOT NULL DEFAULT 0, created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS product_variants (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, product_id BIGINT UNSIGNED NOT NULL, sku VARCHAR(64) NULL UNIQUE, name VARCHAR(160) NOT NULL, attributes_json TEXT NOT NULL, price DECIMAL(10,2) NULL, stock INT NULL, active TINYINT(1) NOT NULL DEFAULT 1, INDEX idx_variant_product (product_id,active), CONSTRAINT fk_variant_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
  "CREATE TABLE IF NOT EXISTS product_images (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, product_id BIGINT UNSIGNED NOT NULL, image_url VARCHAR(1000) NOT NULL, alt_text VARCHAR(180) NOT NULL DEFAULT '', sort_order INT NOT NULL DEFAULT 0, INDEX idx_product_images (product_id,sort_order), CONSTRAINT fk_product_image_product FOREIGN KEY (product_id) REFERENCES products(id) ON DELETE CASCADE) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4",
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
      ["products","sku","VARCHAR(64) NULL"],
      ["products","sale_price","DECIMAL(10,2) NULL"],
      ["products","category_id","BIGINT UNSIGNED NULL"],
      ["products","featured","TINYINT(1) NOT NULL DEFAULT 0"],
      ["products","is_virtual","TINYINT(1) NOT NULL DEFAULT 0"],
      ["products","weight_grams","INT UNSIGNED NULL"],
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
    const [ownerRows] = await dbPool.execute("SELECT id FROM app_users WHERE LOWER(email)=? AND email_verified=1 LIMIT 1",[adminEmail]);
    if (ownerRows.length) {
      await dbPool.execute("UPDATE app_users SET role='customer' WHERE role='admin' AND id<>?",[ownerRows[0].id]);
      await dbPool.execute("UPDATE app_users SET role='admin' WHERE id=?",[ownerRows[0].id]);
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
    const [rows] = await dbPool.execute("SELECT p.id,p.name,p.description,p.price,p.sale_price,COALESCE(p.sale_price,p.price) AS current_price,p.stock,p.image_url,p.sku,p.featured,p.is_virtual,p.weight_grams,c.name AS category_name,(SELECT COUNT(*) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS review_count,(SELECT ROUND(AVG(r.rating),1) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS average_rating FROM products p LEFT JOIN product_categories c ON c.id=p.category_id WHERE " + where.join(" AND ") + " ORDER BY " + orderBy + " LIMIT ? OFFSET ?", [...params,perPage,(page-1)*perPage]);
    const [[count]] = await dbPool.execute("SELECT COUNT(*) AS total FROM products p WHERE " + where.map(x=>x.replaceAll("p.","p.")).join(" AND "), params);
    return sendJson(res, 200, { products: rows, total: Number(count.total), page, pages: Math.ceil(Number(count.total)/perPage) });
  }
  const productMatch = route.match(/^\/api\/products\/(\d+)$/);
  if (req.method === "GET" && productMatch) {
    if (!dbReady) return sendError(res, 503, "The store is being set up.");
    const id = Number(productMatch[1]);
    const [[product]] = await dbPool.execute("SELECT p.id,p.name,p.description,p.price,p.sale_price,COALESCE(p.sale_price,p.price) AS current_price,p.stock,p.image_url,p.sku,p.featured,p.is_virtual,p.weight_grams,c.name AS category_name,(SELECT COUNT(*) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS review_count,(SELECT ROUND(AVG(r.rating),1) FROM product_reviews r WHERE r.product_id=p.id AND r.status='approved') AS average_rating FROM products p LEFT JOIN product_categories c ON c.id=p.category_id WHERE p.id=? AND p.active=1 LIMIT 1",[id]);
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

  if (req.method === "GET" && route === "/api/services") {
    if (!dbReady) return sendError(res, 503, "Appointments are being set up.");
    const [rows] = await dbPool.execute("SELECT id,name,description,duration_minutes,price FROM services WHERE active=1 ORDER BY created_at DESC LIMIT 100");
    return sendJson(res, 200, { services: rows });
  }

  if (req.method === "POST" && route === "/api/bookings") {
    const session = await requireSession(req, res);
    if (!session) return;
    const body = await readJson(req);
    const serviceId = Number(body.serviceId);
    const startsAt = new Date(body.startsAt);
    const notes = cleanText(body.notes, 1000);
    if (!Number.isInteger(serviceId) || serviceId < 1 || Number.isNaN(startsAt.getTime()) || startsAt.getTime() < Date.now() + 300000) return sendError(res, 400, "Choose a service and a future date and time.");
    const startSql = startsAt.toISOString().slice(0, 19).replace("T", " ");
    const conn = await dbPool.getConnection();
    try {
      await conn.beginTransaction();
      const lockName = "booking-day:" + startSql.slice(0, 10);
      const [lock] = await conn.execute("SELECT GET_LOCK(?,5) AS acquired", [lockName]);
      if (!lock[0] || Number(lock[0].acquired) !== 1) { await conn.rollback(); return sendError(res, 409, "That time is busy. Please try another time."); }
      const [services] = await conn.execute("SELECT id,name,duration_minutes FROM services WHERE id=? AND active=1 LIMIT 1", [serviceId]);
      if (!services.length) { await conn.execute("SELECT RELEASE_LOCK(?)", [lockName]); await conn.rollback(); return sendError(res, 404, "That service is not available."); }
      const endSql = new Date(startsAt.getTime() + Number(services[0].duration_minutes) * 60000).toISOString().slice(0, 19).replace("T", " ");
      const [conflicts] = await conn.execute("SELECT b.id FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.status IN ('requested','confirmed') AND b.starts_at < ? AND DATE_ADD(b.starts_at, INTERVAL s.duration_minutes MINUTE) > ? LIMIT 1", [endSql, startSql]);
      if (conflicts.length) { await conn.execute("SELECT RELEASE_LOCK(?)", [lockName]); await conn.rollback(); return sendError(res, 409, "That time is already booked. Please choose another time."); }
      const [result] = await conn.execute("INSERT INTO bookings (user_id,service_id,starts_at,notes) VALUES (?,?,?,?)", [session.user.id, serviceId, startSql, notes]);
      await conn.execute("SELECT RELEASE_LOCK(?)", [lockName]);
      await conn.commit();
      let emailSent = false;
      if (process.env.SMTP_PASS) emailSent = await sendMail(session.user.email, "LuMekH appointment request received", "<p>Your appointment request for " + services[0].name + " has been received.</p>");
      return sendJson(res, 201, { message: "Appointment request saved.", bookingId: result.insertId, emailSent });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  if (req.method === "POST" && route === "/api/orders") {
    const session = await requireSession(req, res);
    if (!session) return;
    const body = await readJson(req);
    const items = Array.isArray(body.items) ? body.items.slice(0, 30) : [];
    const fullName = cleanText(body.fullName, 160);
    const phone = cleanText(body.phone, 40);
    const address = cleanText(body.address, 500);
    const city = cleanText(body.city, 120);
    const postalCode = cleanText(body.postalCode, 24);
    if (!items.length || !fullName || !phone || !address || !city || !postalCode) return sendError(res, 400, "Add items and complete the delivery details.");
    const conn = await dbPool.getConnection();
    try {
      await conn.beginTransaction();
      let total = 0;
      const products = [];
      for (const item of items) {
        const productId = Number(item.productId);
        const quantity = Number(item.quantity);
        if (!Number.isInteger(productId) || productId < 1 || !Number.isInteger(quantity) || quantity < 1 || quantity > 25) { await conn.rollback(); return sendError(res, 400, "One of the basket items is not valid."); }
        const [found] = await conn.execute("SELECT id,name,price,stock FROM products WHERE id=? AND active=1 LIMIT 1 FOR UPDATE", [productId]);
        if (!found.length) { await conn.rollback(); return sendError(res, 409, "A product in your basket is no longer available."); }
        const product = found[0];
        if (product.stock !== null && Number(product.stock) < quantity) { await conn.rollback(); return sendError(res, 409, product.name + " has limited stock. Update your basket and try again."); }
        total += Number(product.price) * quantity;
        products.push({ id: product.id, name: product.name, price: Number(product.price), quantity, stock: product.stock });
      }
      const [order] = await conn.execute("INSERT INTO orders (user_id,total,full_name,phone,address,city,postal_code) VALUES (?,?,?,?,?,?,?)", [session.user.id, total, fullName, phone, address, city, postalCode]);
      for (const product of products) {
        await conn.execute("INSERT INTO order_items (order_id,product_id,product_name,quantity,unit_price) VALUES (?,?,?,?,?)", [order.insertId, product.id, product.name, product.quantity, product.price]);
        if (product.stock !== null) await conn.execute("UPDATE products SET stock=stock-? WHERE id=?", [product.quantity, product.id]);
      }
      await conn.commit();
      let emailSent = false;
      if (process.env.SMTP_PASS) emailSent = await sendMail(session.user.email, "LuMekH order received", "<p>Your order #" + order.insertId + " has been received. Total: ₹" + total.toFixed(2) + ".</p><p>Payment will be confirmed separately.</p>");
      return sendJson(res, 201, { message: "Order request saved. Payment will be confirmed separately.", orderId: order.insertId, total, emailSent });
    } catch (error) {
      await conn.rollback();
      throw error;
    } finally { conn.release(); }
  }

  if (req.method === "GET" && route === "/api/account") {
    const session = await getSession(req);
    if (!session) return sendError(res, 401, "Please sign in to view your account.");
    if (!dbReady) return sendError(res, 503, "Your account data is being prepared.");
    const [orders] = await dbPool.execute("SELECT id,total,status,created_at FROM orders WHERE user_id=? ORDER BY created_at DESC LIMIT 100", [session.user.id]);
    const [bookings] = await dbPool.execute("SELECT b.id,b.starts_at,b.status,b.notes,s.name AS service_name,s.duration_minutes FROM bookings b JOIN services s ON s.id=b.service_id WHERE b.user_id=? ORDER BY b.starts_at DESC LIMIT 100", [session.user.id]);
    return sendJson(res, 200, { user: session.user, orders, bookings });
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
    if (req.method === "GET" && route === "/api/admin/products") {
      const [rows] = await dbPool.query("SELECT id,name,description,price,stock,image_url,active,created_at FROM products ORDER BY created_at DESC LIMIT 200");
      return sendJson(res, 200, { products: rows });
    }
    if (req.method === "POST" && route === "/api/admin/products") {
      const body = await readJson(req);
      const name = cleanText(body.name, 160);
      const description = cleanText(body.description, 3000);
      const price = Number(body.price);
      const stock = body.stock === "" || body.stock === null || body.stock === undefined ? null : Number(body.stock);
      const imageUrl = cleanText(body.imageUrl, 1000);
      if (name.length < 2 || !Number.isFinite(price) || price < 0 || (stock !== null && (!Number.isInteger(stock) || stock < 0))) return sendError(res, 400, "Enter a product name, valid price, and whole-number stock amount.");
      await dbPool.execute("INSERT INTO products (name,description,price,stock,image_url) VALUES (?,?,?,?,?)", [name, description, price, stock, imageUrl || null]);
      return sendJson(res, 201, { message: "Product added." });
    }
    if (req.method === "GET" && route === "/api/admin/services") {
      const [rows] = await dbPool.query("SELECT id,name,description,duration_minutes,price,active,created_at FROM services ORDER BY created_at DESC LIMIT 200");
      return sendJson(res, 200, { services: rows });
    }
    if (req.method === "POST" && route === "/api/admin/services") {
      const body = await readJson(req);
      const name = cleanText(body.name, 160);
      const description = cleanText(body.description, 3000);
      const duration = Number(body.durationMinutes);
      const price = Number(body.price);
      if (name.length < 2 || !Number.isInteger(duration) || duration < 5 || duration > 720 || !Number.isFinite(price) || price < 0) return sendError(res, 400, "Enter a service name, duration from 5 to 720 minutes, and a valid price.");
      await dbPool.execute("INSERT INTO services (name,description,duration_minutes,price) VALUES (?,?,?,?)", [name, description, duration, price]);
      return sendJson(res, 201, { message: "Service added." });
    }
    if (req.method === "GET" && route === "/api/admin/bookings") {
      const [rows] = await dbPool.query("SELECT b.id,b.starts_at,b.status,b.notes,b.created_at,u.name AS customer_name,u.email AS customer_email,s.name AS service_name,s.duration_minutes,s.price FROM bookings b JOIN app_users u ON u.id=b.user_id JOIN services s ON s.id=b.service_id ORDER BY b.starts_at DESC LIMIT 300");
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
