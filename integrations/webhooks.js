"use strict";

const net = require("node:net");
const { createHmac } = require("node:crypto");

const WEBHOOK_EVENTS = Object.freeze(["order.created", "order.updated", "booking.created", "booking.updated", "customer.registered", "customer.updated"]);
const PRIVATE_IPV4_CIDRS = Object.freeze([
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4]
]);

function ipv4Integer(address) {
  if (net.isIP(address) !== 4) return null;
  return address.split(".").reduce((value, octet) => value * 256 + Number(octet), 0);
}

function inCidr(address, network, prefix) {
  const value = ipv4Integer(address), base = ipv4Integer(network);
  if (value === null || base === null) return false;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(base / size);
}

function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 4) return !PRIVATE_IPV4_CIDRS.some(([network, prefix]) => inCidr(address, network, prefix));
  if (family !== 6) return false;
  const normalized = address.toLowerCase().split("%")[0];
  const firstHextet = Number.parseInt(normalized.split(":")[0] || "0", 16);
  // Global unicast is 2000::/3. Reject mapped, loopback, unique-local,
  // link-local, multicast, documentation and transition ranges by default.
  return firstHextet >= 0x2000 && firstHextet <= 0x3fff &&
    !normalized.startsWith("2001:db8:") && !normalized.startsWith("2001:0:") &&
    !normalized.startsWith("2001:2:") && !normalized.startsWith("2001:10:") &&
    !normalized.startsWith("2002:");
}

function parseWebhookUrl(value) {
  let url;
  try { url = new URL(String(value || "")); } catch (_) { throw new Error("Enter a valid HTTPS webhook URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || net.isIP(url.hostname) ||
      url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local") ||
      url.hostname.endsWith(".internal") || !url.hostname.includes(".")) {
    throw new Error("Webhook destinations must use HTTPS on a public DNS hostname.");
  }
  return url;
}

function validateWebhookEvents(events) {
  if (!Array.isArray(events) || events.length < 1 || events.length > WEBHOOK_EVENTS.length ||
      events.some(event => !WEBHOOK_EVENTS.includes(event))) {
    throw new Error("Choose one or more supported webhook events.");
  }
  return [...new Set(events)];
}

function signWebhook(secret, timestamp, body) {
  return createHmac("sha256", secret).update(String(timestamp) + ".").update(body).digest("hex");
}

module.exports = { WEBHOOK_EVENTS, isPublicAddress, parseWebhookUrl, validateWebhookEvents, signWebhook };
