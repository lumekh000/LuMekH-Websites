"use strict";

const { randomBytes, createHash, timingSafeEqual } = require("node:crypto");
const { signWebhook } = require("./webhooks");

function createApiKey() {
  return "lmh_" + randomBytes(32).toString("base64url");
}

function hashApiKey(key) {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function verifyApiKey(key, expectedHash) {
  if (typeof key !== "string" || !/^lmh_[A-Za-z0-9_-]{43}$/.test(key) || !/^[a-f0-9]{64}$/.test(expectedHash || "")) return false;
  return timingSafeEqual(Buffer.from(hashApiKey(key), "hex"), Buffer.from(expectedHash, "hex"));
}

module.exports = { createApiKey, hashApiKey, verifyApiKey, signWebhook };
