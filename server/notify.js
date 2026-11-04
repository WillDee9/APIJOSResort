'use strict';
const { newId } = require('./auth');
const { toMsisdn, smsSafe } = require('./messages');

const RETRY_MINUTES = [1, 5, 30, 120, 360];

class SendError extends Error { constructor(msg, permanent) { super(msg); this.permanent = permanent; } }

function makeNotifier({ db, email = {}, sms = {} }) {
  const enabled = { email: Boolean(email.apiKey && email.from), sms: Boolean(sms.apiKey && sms.sender) };
  const emailBase = email.baseUrl || 'https://api.resend.com';
  const smsBase = sms.baseUrl || 'https://sms.arkesel.com';
  let closed = false; let running = false; let kickTimer = null;

  const asError = (res, text, who) => new SendError(`${who} replied ${res.status}: ${String(text).slice(0, 160)}`, res.status >= 400 && res.status < 500 && ![408, 429].includes(res.status));
  async function sendEmail({ to, subject, text, html, key }) {
    const res = await fetch(`${emailBase}/emails`, {
      method: 'POST',
      headers: { authorization: `Bearer ${email.apiKey}`, 'content-type': 'application/json', ...(key ? { 'Idempotency-Key': key } : {}) },
      body: JSON.stringify({ from: email.from, to: [to], subject, text, html }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw asError(res, await res.text().catch(() => ''), 'Email service');
  }
  async function sendSms({ to, text }) {
    const res = await fetch(`${smsBase}/api/v2/sms/send`, {
      method: 'POST',
      headers: { 'api-key': sms.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ sender: sms.sender, message: smsSafe(text), recipients: [to] }),
      signal: AbortSignal.timeout(15000),
    });
    const raw = await res.text().catch(() => '');
    if (!res.ok) throw asError(res, raw, 'SMS service');
    let body = {}; try { body = JSON.parse(raw); } catch { /* reply checked below */ }
    if (body.status && String(body.status).toLowerCase() !== 'success') throw new SendError(`SMS service said: ${raw.slice(0, 160)}`, true);
  }

  // Saved inside the same database transaction as the booking change, so a booking and its message stand or fall together.
  function enqueue({ channel, to, subject, text, html, kind }) {
    if (!enabled[channel] || !to || !text) return false;
    const recipient = channel === 'sms' ? toMsisdn(to) : String(to);
    if (!recipient) return false;
    db.prepare(`INSERT INTO outbox(id,channel,recipient,subject,body,html,kind,status,attempts,next_try,created_at) VALUES(?,?,?,?,?,?,?,'pending',0,?,?)`)
      .run(newId(), channel, recipient, subject || null, text, html || null, kind || 'message', Date.now(), new Date().toISOString());
    kick();
    return true;
  }
  const done = (id, status, error) => db.prepare("UPDATE outbox SET status=?,body='',html=NULL,last_error=?,sent_at=? WHERE id=?").run(status, error || null, new Date().toISOString(), id);
  async function processQueue() {
    if (running || closed) return;
    running = true;
    try {
      const rows = db.prepare("SELECT * FROM outbox WHERE status='pending' AND next_try<=? ORDER BY created_at LIMIT 20").all(Date.now());
      for (const m of rows) {
        if (closed) return;
        try {
          if (m.channel === 'email') await sendEmail({ to: m.recipient, subject: m.subject, text: m.body, html: m.html, key: m.id });
          else await sendSms({ to: m.recipient, text: m.body });
          if (closed) return;
          done(m.id, 'sent');
        } catch (e) {
          if (closed) return;
          const attempts = m.attempts + 1;
          if (e.permanent || attempts > RETRY_MINUTES.length) { done(m.id, 'failed', e.message); console.error(new Date().toISOString(), `${m.channel} message failed: ${e.message}`); }
          else db.prepare('UPDATE outbox SET attempts=?,next_try=?,last_error=? WHERE id=?').run(attempts, Date.now() + RETRY_MINUTES[attempts - 1] * 60000, e.message, m.id);
        }
      }
    } catch (e) { if (!closed) console.error('Message queue:', e.message); } finally { running = false; }
  }
  function kick() { if (closed || kickTimer) return; kickTimer = setTimeout(() => { kickTimer = null; processQueue(); }, 50); kickTimer.unref(); }
  // For password links only. These are sent straight away and never stored, so the database never holds a working link.
  async function sendPrivateEmail({ to, subject, text, html, kind }) {
    if (!enabled.email) return false;
    const log = status => db.prepare(`INSERT INTO outbox(id,channel,recipient,subject,body,kind,status,attempts,next_try,created_at,sent_at) VALUES(?,?,?,?,'',?,?,1,0,?,?)`)
      .run(newId(), 'email', to, subject, kind, status, new Date().toISOString(), new Date().toISOString());
    try { await sendEmail({ to, subject, text, html }); if (!closed) log('sent'); return true; }
    catch (e) { console.error('Private email failed:', e.message); if (!closed) log('failed'); return false; }
  }
  const timer = setInterval(() => {
    processQueue();
    try { db.prepare('DELETE FROM outbox WHERE created_at<?').run(new Date(Date.now() - 90 * 864e5).toISOString()); } catch (e) { console.error(e.message); }
  }, 15000);
  timer.unref();

  return { enabled, enqueue, processQueue, kick, sendPrivateEmail, sendEmail, sendSms, close() { closed = true; clearInterval(timer); clearTimeout(kickTimer); } };
}
module.exports = { makeNotifier, SendError };
