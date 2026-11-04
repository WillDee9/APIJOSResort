'use strict';
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const scrypt = promisify(crypto.scrypt);
const OPTS = { N: 32768, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 32, OPTS);
  return `s1$${salt.toString('hex')}$${key.toString('hex')}`;
}
async function checkPassword(password, stored) {
  const [, saltHex, keyHex] = String(stored).split('$');
  const key = await scrypt(password, Buffer.from(saltHex, 'hex'), 32, OPTS);
  return crypto.timingSafeEqual(key, Buffer.from(keyHex, 'hex'));
}
const newToken = () => crypto.randomBytes(32).toString('base64url');
const hashToken = t => crypto.createHash('sha256').update(t).digest('hex');
const newId = (n = 9) => crypto.randomBytes(n).toString('base64url').replace(/[-_]/g, 'x');

// Small in-memory limiter. One server process, so this is enough to slow password guessing.
class Limiter {
  constructor(max, windowMs) { this.max = max; this.windowMs = windowMs; this.hits = new Map(); }
  allow(key) {
    const now = Date.now(); const h = this.hits.get(key);
    if (!h || now - h.start > this.windowMs) { this.hits.set(key, { start: now, n: 1 }); this.sweep(now); return true; }
    h.n += 1; return h.n <= this.max;
  }
  clear(key) { this.hits.delete(key); }
  sweep(now) { if (this.hits.size > 5000) for (const [k, h] of this.hits) if (now - h.start > this.windowMs) this.hits.delete(k); }
}
module.exports = { hashPassword, checkPassword, newToken, hashToken, newId, Limiter };
