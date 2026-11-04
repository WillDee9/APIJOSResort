'use strict';
const crypto = require('node:crypto');

function makePaystack({ secretKey, baseUrl = 'https://api.paystack.co' }) {
  const call = async (path, options = {}) => {
    const res = await fetch(baseUrl + path, {
      ...options,
      headers: { authorization: `Bearer ${secretKey}`, 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.status) { const e = new Error(`Paystack: ${body.message || res.status}`); e.upstream = true; throw e; }
    return body.data;
  };
  return {
    enabled: Boolean(secretKey),
    initialize: ({ email, amount, reference, currency, callbackUrl, metadata }) => call('/transaction/initialize', {
      method: 'POST',
      body: JSON.stringify({ email, amount: String(amount), reference, currency, callback_url: callbackUrl, metadata: JSON.stringify(metadata || {}) }),
    }),
    verify: reference => call(`/transaction/verify/${encodeURIComponent(reference)}`),
    signatureValid(rawBody, signature) {
      if (!secretKey || typeof signature !== 'string') return false;
      const expected = Buffer.from(crypto.createHmac('sha512', secretKey).update(rawBody).digest('hex'));
      const given = Buffer.from(signature);
      return expected.length === given.length && crypto.timingSafeEqual(expected, given);
    },
  };
}
module.exports = { makePaystack };
