'use strict';
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const L = require('./logic');
const { hashPassword, checkPassword, newToken, hashToken, newId, Limiter } = require('./auth');
const { openDb } = require('./db');
const { makePaystack } = require('./paystack');
const { makeNotifier } = require('./notify');
const M = require('./messages');

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const STAFF = ['manager', 'ceo'];
const CEO = ['ceo'];
const DAY = 864e5;
const HOLD_MS = 30 * 60 * 1000;
const COOKIE = 'apj_sid';
const STATIC = { '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
const PAGES = new Set(['/', '/portal', '/payment/return', '/reset', '/privacy']);

const str = (v, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const int = v => (Number.isInteger(v) ? v : (typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : NaN));
const nowIso = () => new Date().toISOString();

function createApp(config) {
  const db = openDb(config.dataDir);
  const appUrl = String(config.appUrl || '').replace(/\/$/, '');
  const paystack = makePaystack({ secretKey: config.paystackKey, baseUrl: config.paystackBase });
  const secure = appUrl.startsWith('https://');
  const loginLimit = new Limiter(8, 15 * 60 * 1000);
  const signupLimit = new Limiter(config.signupPerHour || 30, 60 * 60 * 1000);
  const bookLimit = new Limiter(40, 60 * 60 * 1000);
  const forgotIpLimit = new Limiter(config.forgotPerHour || 10, 60 * 60 * 1000);
  const forgotEmailLimit = new Limiter(3, 60 * 60 * 1000);
  const notifier = makeNotifier({ db, email: config.email, sms: config.sms });
  const q = sql => db.prepare(sql);
  const audit = (user, action, detail) => q('INSERT INTO audit(at,user_id,action,detail) VALUES(?,?,?,?)').run(nowIso(), user ? user.id : null, action, detail ? JSON.stringify(detail).slice(0, 1000) : null);
  const setting = k => (q('SELECT value FROM settings WHERE key=?').get(k) || {}).value;
  const unit = id => q('SELECT * FROM units WHERE id=?').get(id);
  const units = () => q('SELECT id,name,kind FROM units WHERE active=1 ORDER BY sort,name').all();
  const label = u => (u.role === 'ceo' ? 'CEO' : u.role === 'manager' ? 'Manager' : 'Guest');

  /* ---------- messages ---------- */
  const msgCtx = () => ({ resort: setting('resortName'), slogan: setting('slogan'), currency: setting('currency'), phone: setting('contactPhone'), policy: setting('cancelPolicy'), appUrl });
  // Message rows are saved with the booking change. If the change fails, nothing is sent.
  function tell(event, r) {
    const m = M.bookingMessage(event, r, (unit(r.unit_id) || {}).name || 'the resort', msgCtx());
    const u = r.user_id ? q('SELECT email,sms_on FROM users WHERE id=?').get(r.user_id) : null;
    if (u) notifier.enqueue({ channel: 'email', to: u.email, subject: m.subject, text: m.text, html: m.html, kind: event });
    if (m.sms && (u ? u.sms_on : r.sms_ok)) notifier.enqueue({ channel: 'sms', to: r.guest_phone, text: m.sms, kind: event });
  }
  function alertDesk(heading, lines, sms) {
    const m = M.deskAlert(msgCtx(), heading, lines, sms);
    notifier.enqueue({ channel: 'email', to: setting('deskEmail'), subject: m.subject, text: m.text, html: m.html, kind: 'desk_alert' });
    if (m.sms) notifier.enqueue({ channel: 'sms', to: setting('deskPhone'), text: m.sms, kind: 'desk_alert' });
  }
  function alertCeo(e) {
    const m = M.deskAlert(msgCtx(), 'An expense needs your approval', [`${e.note || e.cat}: ${M.money(e.amt, setting('currency'))}.`, 'It will not count in the accounts until you decide.'], null);
    q("SELECT email FROM users WHERE role='ceo' AND active=1").all().forEach(u => notifier.enqueue({ channel: 'email', to: u.email, subject: m.subject, text: m.text, html: m.html, kind: 'approval' }));
  }
  function sendReminders() {
    const hour = new Date().getHours(); if (hour < 9 || hour > 20) return;
    const rows = q(`SELECT * FROM requests WHERE type='stay' AND status='confirmed' AND check_in=? AND reminder_sent=0 AND substr(created_at,1,10)<?`).all(L.addDays(L.today(), 1), L.today());
    rows.forEach(r => db.tx(() => {
      const claimed = q('UPDATE requests SET reminder_sent=1 WHERE id=? AND reminder_sent=0').run(r.id).changes;
      if (claimed) tell('reminder', r);
    }));
  }

  /* ---------- availability ---------- */
  function expireHolds() { q("UPDATE requests SET status='expired',updated_at=? WHERE status='awaiting_payment' AND hold_expires<?").run(nowIso(), Date.now()); }
  function freeRooms(type, from, to, exceptId = '') {
    const rows = q(`SELECT check_in,check_out FROM requests WHERE type='stay' AND room_type_id=? AND id<>? AND check_in<? AND check_out>? AND (status IN('confirmed','checked_in') OR (status='awaiting_payment' AND hold_expires>=?))`).all(type.id, exceptId, to, from, Date.now());
    let most = 0;
    for (let d = from; d < to; d = L.addDays(d, 1)) most = Math.max(most, rows.filter(r => r.check_in <= d && d < r.check_out).length);
    return Math.max(0, type.count - most);
  }
  function poolLeft(date, exceptId = '') {
    const max = Number(setting('poolMax')) || 0;
    const used = q(`SELECT COALESCE(SUM(adults+kids),0) n FROM requests WHERE type='pool' AND pool_date=? AND id<>? AND (status='confirmed' OR (status='awaiting_payment' AND hold_expires>=?))`).get(date, exceptId, Date.now()).n;
    return max ? Math.max(0, max - used) : Infinity;
  }

  /* ---------- creating requests: every price comes from the server ---------- */
  function priceAndValidate(b) {
    const type = b.type;
    if (type === 'stay') {
      const rt = q('SELECT * FROM room_types WHERE id=? AND active=1').get(str(b.roomType));
      if (!rt) throw bad('That room is no longer available.');
      const { checkIn, checkOut } = b;
      if (!L.isDate(checkIn) || !L.isDate(checkOut)) throw bad('Choose valid dates.');
      if (checkIn < L.today()) throw bad("Check-in can't be in the past.");
      if (checkOut <= checkIn) throw bad('Check-out must be after check-in.');
      const nights = L.nightsBetween(checkIn, checkOut);
      if (nights > 60) throw bad('Bookings longer than 60 nights must be arranged with the front desk.');
      const guests = int(b.guests);
      if (!(guests >= 1)) throw bad('Enter how many guests are staying.');
      if (guests > rt.sleeps) throw bad(`${rt.name} sleeps up to ${rt.sleeps}. Choose a larger room or book another room.`);
      if (rt.rate <= 0) throw bad('This room has no rate set yet. Please call the front desk.');
      return { unit_id: rt.unit_id, room_type_id: rt.id, room_name: rt.name, check_in: checkIn, check_out: checkOut, guests, total: rt.rate * nights, _rt: rt };
    }
    if (type === 'pool') {
      const pu = q("SELECT id FROM units WHERE kind='pool' AND active=1 LIMIT 1").get();
      if (!pu) throw bad('The pool is not taking bookings.');
      if (!L.isDate(b.date) || b.date < L.today()) throw bad('Choose today or a later date.');
      const adults = int(b.adults); const kids = int(b.kids);
      if (!(adults >= 0) || !(kids >= 0) || adults + kids < 1 || adults + kids > 100) throw bad('Add at least one person.');
      const total = adults * Number(setting('poolAdult')) + kids * Number(setting('poolChild'));
      if (total <= 0) throw bad('Pool prices are not set yet. Please call the front desk.');
      return { unit_id: pu.id, pool_date: b.date, adults, kids, total };
    }
    if (type === 'order') {
      if (!Array.isArray(b.lines) || !b.lines.length || b.lines.length > 50) throw bad('Add something to your order first.');
      const where = str(b.deliverTo, 100);
      if (!where) throw bad('Say where to bring the order, such as a room or table number.');
      let unitId = null; let total = 0;
      const lines = b.lines.map(l => {
        const m = q('SELECT * FROM menu_items WHERE id=? AND active=1').get(str(l.id));
        const n = int(l.qty);
        if (!m) throw bad('An item in your order is no longer on the menu.');
        if (!(n >= 1 && n <= 50)) throw bad('Quantities must be between 1 and 50.');
        if (unitId && unitId !== m.unit_id) throw bad('Each order must be for one bar or restaurant.');
        unitId = m.unit_id; total += m.price * n;
        return { id: m.id, name: m.name, price: m.price, qty: n };
      });
      return { unit_id: unitId, lines: JSON.stringify(lines), deliver_to: where, total };
    }
    throw bad('Choose a room, an order or a pool pass.');
  }
  function insertRequest({ user, source, guestName, guestPhone, payChoice, body }) {
    const name = str(guestName, 100); const phone = str(guestPhone, 30);
    if (!name) throw bad("Enter the guest's name.");
    if (!/^[+\d][\d\s-]{6,}$/.test(phone)) throw bad('Enter a valid phone number.');
    const p = priceAndValidate(body);
    const id = newId();
    db.tx(() => {
      expireHolds();
      if (body.type === 'stay' && freeRooms(p._rt, p.check_in, p.check_out) < 1) throw new HttpError(409, 'That room is full on these dates. Try other dates or another room.');
      if (body.type === 'pool' && poolLeft(p.pool_date) < p.adults + p.kids) throw new HttpError(409, 'Not enough pool places are left on that day.');
      if (payChoice === 'online') {
        const open = q("SELECT COUNT(*) n FROM requests WHERE user_id=? AND status='awaiting_payment'").get(user.id).n;
        if (open >= 3) throw new HttpError(429, 'You have unpaid bookings waiting. Pay or cancel them first.');
      }
      const t = nowIso();
      q(`INSERT INTO requests(id,type,user_id,source,guest_name,guest_phone,unit_id,room_type_id,room_name,check_in,check_out,guests,pool_date,adults,kids,deliver_to,lines,total,status,pay_choice,hold_expires,created_at,updated_at)
         VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, body.type, user.role === 'customer' ? user.id : null, source, name, phone, p.unit_id,
        p.room_type_id || null, p.room_name || null, p.check_in || null, p.check_out || null, p.guests || null, p.pool_date || null, p.adults ?? null, p.kids ?? null,
        p.deliver_to || null, p.lines || null, p.total, payChoice === 'online' ? 'awaiting_payment' : 'pending', payChoice, payChoice === 'online' ? Date.now() + HOLD_MS : null, t, t);
      if (source === 'desk' && body.smsOk === true) q('UPDATE requests SET sms_ok=1 WHERE id=?').run(id);
      if (source === 'online' && payChoice === 'resort') {
        const row = q('SELECT * FROM requests WHERE id=?').get(id);
        tell('received', row);
        const d = M.describe(row, (unit(row.unit_id) || {}).name || '');
        alertDesk('New request waiting for the desk', [`${name} (${phone}): ${d.long}.`, `Total: ${M.money(row.total, setting('currency'))}.`], null);
      }
    });
    return id;
  }
  const publicRequest = r => ({ ...r, lines: r.lines ? JSON.parse(r.lines) : undefined, unit_name: (unit(r.unit_id) || {}).name || '' });

  /* ---------- payments ---------- */
  function postPayment(r, method, by, nights, fees) {
    const unitRow = unit(r.unit_id) || {};
    const desc = r.type === 'stay' ? `${r.room_name}, ${nights} night${nights === 1 ? '' : 's'}` : r.type === 'pool' ? 'Pool passes' : 'Order';
    q(`INSERT OR IGNORE INTO ledger(id,date,kind,unit_id,cat,amt,method,status,note,by_label,nights,ref,created_at) VALUES(?,?,'income',?,?,?,?,'approved',?,?,?,?,?)`)
      .run(newId(), L.today(), r.unit_id, L.incomeCat(r.type, unitRow.kind), r.total, method, `${desc} · ${r.guest_name}`, by, nights, `pay-${r.id}`, nowIso());
    if (fees > 0) {
      q(`INSERT OR IGNORE INTO ledger(id,date,kind,unit_id,cat,amt,method,status,note,by_label,nights,ref,created_at) VALUES(?,?,'expense','shared','Payment fees',?,'Paystack','approved',?,'System',0,?,?)`)
        .run(newId(), L.today(), fees, `Paystack fee · ${r.guest_name}`, `fee-${r.id}`, nowIso());
    }
  }
  // Runs for the webhook and for the customer's return page. Safe to repeat.
  function applyPaystackResult(reference, data) {
    return db.tx(() => {
      const pay = q('SELECT * FROM payments WHERE reference=?').get(reference);
      if (!pay) return { state: 'unknown' };
      if (pay.status === 'success' || pay.status === 'review') return { state: pay.status, requestId: pay.request_id };
      const review = reason => {
        q("UPDATE payments SET status='review',reason=?,channel=?,updated_at=? WHERE reference=?").run(reason, data.channel || null, nowIso(), reference);
        audit(null, 'payment_review', { reference, reason });
        const held = q('SELECT * FROM requests WHERE id=?').get(pay.request_id);
        tell('review', held);
        alertDesk('A payment needs checking', [`${held.guest_name} (${held.guest_phone}).`, reason, `Paystack reference: ${reference}`], `${setting('resortName')}: A payment needs checking. Open Today in the portal.`);
        return { state: 'review', requestId: pay.request_id };
      };
      if (data.status !== 'success') {
        if (['failed', 'abandoned', 'reversed'].includes(data.status)) q("UPDATE payments SET status='failed',reason=?,updated_at=? WHERE reference=?").run(String(data.gateway_response || data.status).slice(0, 200), nowIso(), reference);
        return { state: 'not_paid', requestId: pay.request_id };
      }
      if (data.reference !== reference || Number(data.amount) !== pay.amount || String(data.currency).toUpperCase() !== pay.currency) {
        return review(`Paystack reports ${data.currency} ${Number(data.amount) / 100} but ${pay.currency} ${pay.amount / 100} was due.`);
      }
      const r = q('SELECT * FROM requests WHERE id=?').get(pay.request_id);
      if (r.paid) return review('The customer paid this booking twice. Refund one payment from the Paystack dashboard.');
      expireHolds();
      const current = q('SELECT status FROM requests WHERE id=?').get(r.id).status;
      let status = r.type === 'order' ? 'preparing' : 'confirmed';
      let room = true;
      if (current !== 'awaiting_payment') {
        // The 30-minute hold ran out or was cancelled before the money arrived.
        if (r.type === 'stay') { const rt = q('SELECT * FROM room_types WHERE id=?').get(r.room_type_id); room = rt && freeRooms(rt, r.check_in, r.check_out, r.id) > 0; }
        if (r.type === 'pool') room = poolLeft(r.pool_date, r.id) >= r.adults + r.kids;
        if (!['expired', 'cancelled'].includes(current)) room = false;
      }
      if (!room) status = 'payment_review';
      q("UPDATE requests SET status=?,paid=1,paid_method='Paystack',hold_expires=NULL,updated_at=? WHERE id=?").run(status, nowIso(), r.id);
      q("UPDATE payments SET status=?,channel=?,reason=?,updated_at=? WHERE reference=?").run('success', data.channel || null, room ? null : 'Paid after the room was taken. Find another room or refund.', nowIso(), reference);
      const nights = r.type === 'stay' ? L.nightsBetween(r.check_in, r.check_out) : 0;
      postPayment(r, 'Paystack', 'System', nights, Number.isInteger(data.fees) ? data.fees : 0);
      audit(null, 'payment_success', { reference, amount: pay.amount });
      const fresh = q('SELECT * FROM requests WHERE id=?').get(r.id);
      if (room) tell('paid', fresh);
      else {
        tell('review', fresh);
        alertDesk('A paid booking has no room', [`${fresh.guest_name} (${fresh.guest_phone}) paid after the room was taken. Find another room or refund.`, `Paystack reference: ${reference}`], `${setting('resortName')}: A paid booking has no room. Open Today in the portal.`);
      }
      return { state: room ? 'success' : 'conflict', requestId: r.id };
    });
  }

  /* ---------- routes ---------- */
  const routes = [];
  const route = (method, pattern, roles, handler) => {
    const keys = []; const rx = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, rx, keys, roles, handler });
  };
  const ANY = 'any';

  // --- sign in ---
  const startSession = (ctx, user) => {
    const token = newToken(); const ttl = user.role === 'customer' ? 14 * DAY : DAY;
    q('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + ttl);
    ctx.res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(ttl / 1000)}${secure ? '; Secure' : ''}`);
  };
  const me = u => (u ? { id: u.id, email: u.email, name: u.name, phone: u.phone, role: u.role, smsOn: Boolean(u.sms_on) } : null);
  const passwordOk = p => typeof p === 'string' && p.length >= 10 && p.length <= 200;
  const PW_MSG = 'Use a password of at least 10 characters.';
  route('GET', '/api/me', null, ctx => ({ user: me(ctx.user), paystack: paystack.enabled }));
  route('POST', '/api/auth/register', null, async ctx => {
    if (!signupLimit.allow(ctx.ip)) throw new HttpError(429, 'Too many new accounts from this connection. Try again later.');
    const email = str(ctx.body.email, 200).toLowerCase(); const name = str(ctx.body.name, 100); const phone = str(ctx.body.phone, 30);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    if (!name) throw bad('Enter your name.');
    if (!/^[+\d][\d\s-]{6,}$/.test(phone)) throw bad('Enter a valid phone number.');
    if (!passwordOk(ctx.body.password)) throw bad(PW_MSG);
    if (ctx.body.consent !== true) throw bad('Please accept the privacy notice to create an account.');
    const pw = await hashPassword(ctx.body.password);
    const id = newId();
    try { q("INSERT INTO users(id,email,name,phone,role,pw,created_at) VALUES(?,?,?,?,'customer',?,?)").run(id, email, name, phone, pw, nowIso()); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'An account with this email already exists. Sign in instead.'); throw e; }
    const user = q('SELECT * FROM users WHERE id=?').get(id);
    startSession(ctx, user);
    return { user: me(user) };
  });
  const DUMMY = 's1$00000000000000000000000000000000$0000000000000000000000000000000000000000000000000000000000000000';
  route('POST', '/api/auth/login', null, async ctx => {
    const email = str(ctx.body.email, 200).toLowerCase(); const key = `${ctx.ip}|${email}`;
    if (!loginLimit.allow(key)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    const user = q('SELECT * FROM users WHERE email=?').get(email);
    const ok = await checkPassword(String(ctx.body.password || '').slice(0, 200), user ? user.pw : DUMMY);
    if (!user || !ok || !user.active) throw new HttpError(401, 'That email or password is wrong.');
    loginLimit.clear(key);
    startSession(ctx, user);
    if (user.role !== 'customer') audit(user, 'staff_login');
    return { user: me(user) };
  });
  route('POST', '/api/auth/logout', ANY, ctx => {
    q('DELETE FROM sessions WHERE token_hash=?').run(ctx.tokenHash);
    ctx.res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
    return { ok: true };
  });
  route('POST', '/api/auth/password', ANY, async ctx => {
    if (!loginLimit.allow(`pw|${ctx.user.id}`)) throw new HttpError(429, 'Too many attempts. Wait 15 minutes and try again.');
    if (!await checkPassword(String(ctx.body.current || ''), ctx.user.pw)) throw bad('Your current password is wrong.');
    if (!passwordOk(ctx.body.password)) throw bad(PW_MSG);
    const pw = await hashPassword(ctx.body.password);
    q('UPDATE users SET pw=? WHERE id=?').run(pw, ctx.user.id);
    q('DELETE FROM sessions WHERE user_id=? AND token_hash<>?').run(ctx.user.id, ctx.tokenHash);
    return { ok: true };
  });
  route('POST', '/api/auth/reset', null, async ctx => {
    if (!signupLimit.allow(`reset|${ctx.ip}`)) throw new HttpError(429, 'Too many attempts. Try again later.');
    if (!passwordOk(ctx.body.password)) throw bad(PW_MSG);
    const pw = await hashPassword(ctx.body.password);
    const hash = hashToken(String(ctx.body.token || ''));
    db.tx(() => {
      const t = q('SELECT * FROM reset_tokens WHERE token_hash=?').get(hash);
      if (!t || t.used || t.expires_at < Date.now()) throw bad('This link has expired or was already used. Ask the front desk for a new one.');
      q('UPDATE reset_tokens SET used=1 WHERE token_hash=?').run(hash);
      q('UPDATE users SET pw=? WHERE id=?').run(pw, t.user_id);
      q('UPDATE reset_tokens SET used=1 WHERE user_id=?').run(t.user_id);
      q('DELETE FROM sessions WHERE user_id=?').run(t.user_id);
      const u = q('SELECT email,name FROM users WHERE id=?').get(t.user_id);
      const m = M.passwordChanged(msgCtx(), u.name);
      notifier.enqueue({ channel: 'email', to: u.email, subject: m.subject, text: m.text, html: m.html, kind: 'password_changed' });
    });
    return { ok: true };
  });
  route('POST', '/api/auth/forgot', null, ctx => {
    if (!notifier.enabled.email) throw new HttpError(503, 'Password emails are not switched on yet. Please call the front desk for a new link.');
    const email = str(ctx.body.email, 200).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    if (!forgotIpLimit.allow(ctx.ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    // The reply is the same whether or not an account exists, so nobody can use this to find out who is a customer.
    if (forgotEmailLimit.allow(email)) {
      const user = q('SELECT * FROM users WHERE email=? AND active=1').get(email);
      if (user) {
        const token = newToken();
        db.tx(() => {
          q('UPDATE reset_tokens SET used=1 WHERE user_id=?').run(user.id);
          q('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), user.id, Date.now() + 60 * 60 * 1000);
          audit(user, 'password_reset_requested');
        });
        const m = M.resetMessage(msgCtx(), user.name, `${appUrl}/reset#${token}`);
        notifier.sendPrivateEmail({ to: user.email, subject: m.subject, text: m.text, html: m.html, kind: 'password_reset' });
      }
    }
    return { ok: true };
  });
  route('POST', '/api/me/sms', ANY, ctx => {
    q('UPDATE users SET sms_on=? WHERE id=?').run(ctx.body.on ? 1 : 0, ctx.user.id);
    return { ok: true };
  });

  // --- public ---
  const catalog = () => ({
    resortName: setting('resortName'), slogan: setting('slogan'), currency: setting('currency'), approvalLimit: undefined,
    contactPhone: setting('contactPhone'), contactEmail: setting('contactEmail'), address: setting('address'), cancelPolicy: setting('cancelPolicy'),
    units: units(),
    roomTypes: q('SELECT id,unit_id unit,name,rate,count,sleeps FROM room_types WHERE active=1 ORDER BY sort,name').all(),
    menu: q('SELECT id,unit_id unit,section,name,price FROM menu_items WHERE active=1 ORDER BY sort,section,name').all(),
    pool: { adult: Number(setting('poolAdult')), child: Number(setting('poolChild')), maxPerDay: Number(setting('poolMax')) },
    paystack: paystack.enabled, selfReset: notifier.enabled.email,
  });
  route('GET', '/api/public/catalog', null, () => catalog());
  route('GET', '/api/public/availability', null, ctx => {
    const { from, to, date } = ctx.query; const out = { rooms: {}, poolLeft: null };
    expireHolds();
    if (L.isDate(from) && L.isDate(to) && to > from && L.nightsBetween(from, to) <= 60) q('SELECT * FROM room_types WHERE active=1').all().forEach(t => { out.rooms[t.id] = freeRooms(t, from, to); });
    if (L.isDate(date)) { const left = poolLeft(date); out.poolLeft = left === Infinity ? null : left; }
    return out;
  });

  // --- customer ---
  route('POST', '/api/requests', ['customer', ...STAFF], ctx => {
    if (!bookLimit.allow(ctx.user.id)) throw new HttpError(429, 'Too many requests. Try again later.');
    const b = ctx.body;
    const payChoice = b.pay === 'online' && paystack.enabled ? 'online' : 'resort';
    if (b.pay === 'online' && !paystack.enabled) throw bad('Online payment is not switched on yet. Choose pay at the resort.');
    const id = insertRequest({ user: ctx.user, source: 'online', guestName: b.guestName || ctx.user.name, guestPhone: b.guestPhone || ctx.user.phone, payChoice, body: b });
    return { id };
  });
  route('GET', '/api/requests/mine', ANY, ctx => {
    expireHolds();
    return { requests: q('SELECT * FROM requests WHERE user_id=? ORDER BY created_at DESC LIMIT 200').all(ctx.user.id).map(publicRequest) };
  });
  const ownRequest = (ctx) => {
    const r = q('SELECT * FROM requests WHERE id=?').get(ctx.params.id);
    if (!r || r.user_id !== ctx.user.id) throw new HttpError(404, 'We could not find that request.');
    return r;
  };
  route('POST', '/api/requests/:id/cancel', ANY, ctx => {
    db.tx(() => {
      const r = ownRequest(ctx);
      if (r.paid || !['pending', 'awaiting_payment'].includes(r.status)) throw bad('This can no longer be cancelled here. Please call the front desk.');
      q("UPDATE requests SET status='cancelled',updated_at=? WHERE id=?").run(nowIso(), r.id);
    });
    return { ok: true };
  });
  route('POST', '/api/requests/:id/pay', ANY, async ctx => {
    if (!paystack.enabled) throw bad('Online payment is not switched on yet.');
    expireHolds();
    const r = ownRequest(ctx);
    if (r.paid) throw bad('This is already paid.');
    if (r.status !== 'awaiting_payment') throw bad('The time to pay for this request has ended. Please book again.');
    const reference = `APJ-${r.id}-${newId(4)}`;
    const t = nowIso();
    q("INSERT INTO payments(reference,request_id,amount,currency,status,created_at,updated_at) VALUES(?,?,?,'GHS','initialized',?,?)").run(reference, r.id, r.total, t, t);
    const data = await paystack.initialize({ email: ctx.user.email, amount: r.total, reference, currency: 'GHS', callbackUrl: `${appUrl}/payment/return`, metadata: { request_id: r.id } });
    return { url: data.authorization_url, reference };
  });
  route('GET', '/api/payments/:reference/confirm', ANY, async ctx => {
    const pay = q('SELECT p.*,r.user_id FROM payments p JOIN requests r ON r.id=p.request_id WHERE reference=?').get(ctx.params.reference);
    if (!pay || pay.user_id !== ctx.user.id) throw new HttpError(404, 'We could not find that payment.');
    if (pay.status === 'initialized') { const data = await paystack.verify(pay.reference); return applyPaystackResult(pay.reference, data); }
    return { state: pay.status === 'failed' ? 'not_paid' : pay.status, requestId: pay.request_id };
  });
  route('POST', '/webhooks/paystack', null, async ctx => {
    if (!paystack.signatureValid(ctx.raw, ctx.req.headers['x-paystack-signature'])) throw new HttpError(401, 'Bad signature');
    const event = ctx.body;
    if (event.event !== 'charge.success' || !event.data || typeof event.data.reference !== 'string') return { ok: true };
    const pay = q('SELECT reference FROM payments WHERE reference=?').get(event.data.reference);
    if (!pay) { audit(null, 'webhook_unknown_reference', { reference: event.data.reference.slice(0, 80) }); return { ok: true }; }
    // Ask Paystack directly as well, so only its own records can confirm a booking.
    const data = await paystack.verify(pay.reference);
    applyPaystackResult(pay.reference, data);
    return { ok: true };
  });

  // --- desk ---
  route('GET', '/api/desk/requests', STAFF, ctx => {
    expireHolds();
    return { requests: q('SELECT * FROM requests ORDER BY created_at DESC LIMIT 1000').all().map(publicRequest) };
  });
  route('POST', '/api/desk/requests', STAFF, ctx => {
    const id = insertRequest({ user: ctx.user, source: 'desk', guestName: ctx.body.guestName, guestPhone: ctx.body.guestPhone, payChoice: 'resort', body: ctx.body });
    audit(ctx.user, 'walkin', { id });
    return { id };
  });
  route('POST', '/api/desk/requests/:id/move', STAFF, ctx => {
    const to = str(ctx.body.to, 20);
    db.tx(() => {
      expireHolds();
      const r = q('SELECT * FROM requests WHERE id=?').get(ctx.params.id);
      if (!r) throw new HttpError(404, 'We could not find that request.');
      if (!L.canMove(r.type, r.status, to)) throw bad('That step is not possible from its current status.');
      if (['cancelled', 'declined'].includes(to) && r.paid && r.status !== 'payment_review' && ctx.user.role !== 'ceo') throw new HttpError(403, 'This one is already paid. Ask the CEO to cancel it, because it records a refund.');
      if (r.type === 'stay' && to === 'confirmed') {
        const rt = q('SELECT * FROM room_types WHERE id=?').get(r.room_type_id);
        if (!rt || freeRooms(rt, r.check_in, r.check_out, r.id) < 1) throw new HttpError(409, `No ${r.room_name} room is free for those dates. Decline it or agree other dates with the guest.`);
      }
      if (r.type === 'pool' && to === 'confirmed' && poolLeft(r.pool_date, r.id) < r.adults + r.kids) throw new HttpError(409, 'Not enough pool places are left on that day.');
      q('UPDATE requests SET status=?,updated_at=? WHERE id=?').run(to, nowIso(), r.id);
      if (to === 'cancelled' && r.paid) {
        q(`INSERT OR IGNORE INTO ledger(id,date,kind,unit_id,cat,amt,method,status,note,by_label,ref,created_at) VALUES(?,?,'expense',?,'Refunds',?,?,'approved',?,?,?,?)`).run(newId(), L.today(), r.unit_id, r.total, r.paid_method || 'Paystack', `Refund · ${r.guest_name}`, label(ctx.user), `refund-${r.id}`, nowIso());
      }
      audit(ctx.user, 'request_move', { id: r.id, to });
      const event = { confirmed: 'confirmed', preparing: 'accepted', declined: 'declined', cancelled: 'cancelled' }[to];
      if (event) tell(event, q('SELECT * FROM requests WHERE id=?').get(r.id));
    });
    return { ok: true };
  });
  route('POST', '/api/desk/requests/:id/payment', STAFF, ctx => {
    const method = str(ctx.body.method, 30);
    if (!L.METHODS.includes(method) || method === 'Paystack') throw bad('Choose how the guest paid.');
    db.tx(() => {
      const r = q('SELECT * FROM requests WHERE id=?').get(ctx.params.id);
      if (!r) throw new HttpError(404, 'We could not find that request.');
      if (r.paid) throw new HttpError(409, 'This is already paid.');
      if (['pending', 'declined', 'cancelled', 'expired', 'awaiting_payment'].includes(r.status)) throw bad('Confirm or accept this request before taking payment.');
      q('UPDATE requests SET paid=1,paid_method=?,updated_at=? WHERE id=?').run(method, nowIso(), r.id);
      postPayment(r, method, label(ctx.user), r.type === 'stay' ? L.nightsBetween(r.check_in, r.check_out) : 0, 0);
      audit(ctx.user, 'desk_payment', { id: r.id, method, amount: r.total });
      tell('desk_paid', q('SELECT * FROM requests WHERE id=?').get(r.id));
    });
    return { ok: true };
  });
  route('GET', '/api/desk/payment-issues', STAFF, () => ({
    issues: q(`SELECT p.reference,p.amount,p.reason,p.status,r.guest_name,r.guest_phone,r.id request_id FROM payments p JOIN requests r ON r.id=p.request_id WHERE p.resolved_note IS NULL AND (p.status='review' OR r.status='payment_review') ORDER BY p.updated_at DESC`).all(),
  }));
  route('POST', '/api/desk/payment-issues/:reference/resolve', STAFF, ctx => {
    const note = str(ctx.body.note, 300); if (!note) throw bad('Say what was done, such as refunded on Paystack.');
    q('UPDATE payments SET resolved_note=?,updated_at=? WHERE reference=?').run(note, nowIso(), ctx.params.reference);
    audit(ctx.user, 'payment_issue_resolved', { reference: ctx.params.reference, note });
    return { ok: true };
  });
  route('GET', '/api/desk/customers', STAFF, ctx => {
    const email = str(ctx.query.email, 200); if (!email) return { customers: [] };
    return { customers: q("SELECT id,email,name,phone FROM users WHERE role='customer' AND email=?").all(email) };
  });
  route('POST', '/api/desk/reset-link', STAFF, ctx => {
    const target = q('SELECT * FROM users WHERE id=?').get(str(ctx.body.userId, 40));
    if (!target) throw new HttpError(404, 'We could not find that account.');
    if (target.role !== 'customer' && ctx.user.role !== 'ceo') throw new HttpError(403, 'Only the CEO can reset staff passwords.');
    const token = newToken();
    q('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), target.id, Date.now() + DAY);
    audit(ctx.user, 'reset_link', { user: target.id });
    return { url: `${appUrl}/reset#${token}` };
  });

  // --- accounts ---
  const monthRows = m => q('SELECT * FROM ledger WHERE date>=? AND date<=? ORDER BY date DESC,created_at DESC').all(`${m}-01`, `${m}-31`);
  const monthParam = ctx => { const m = ctx.query.month; if (!L.isMonth(m)) throw bad('Choose a valid month.'); return m; };
  route('GET', '/api/ledger', STAFF, ctx => ({ entries: monthRows(monthParam(ctx)) }));
  route('POST', '/api/ledger', STAFF, ctx => {
    const b = ctx.body; const kind = b.kind === 'expense' ? 'expense' : 'income';
    const amt = int(b.amt); const date = b.date;
    if (!(amt > 0) || amt > 1e11) throw bad('Enter an amount greater than zero.');
    if (!L.isDate(date) || date > L.today()) throw bad('Choose a date that is not in the future.');
    const cats = kind === 'income' ? L.INCOME_CATS : L.EXPENSE_CATS;
    if (!cats.includes(b.cat)) throw bad('Choose a category.');
    const unitId = str(b.unit, 40);
    if (!(unit(unitId) || (kind === 'expense' && unitId === 'shared'))) throw bad('Choose a business unit.');
    if (!L.METHODS.includes(b.method)) throw bad('Choose how it was paid.');
    const limit = Number(setting('approvalLimit')) || 0;
    const status = kind === 'expense' && ctx.user.role !== 'ceo' && limit && amt >= limit ? 'pending' : 'approved';
    const nights = kind === 'income' && (unit(unitId) || {}).kind === 'hotel' ? Math.max(0, int(b.nights) || 0) : 0;
    const id = newId();
    q(`INSERT INTO ledger(id,date,kind,unit_id,cat,amt,method,status,note,by_user,by_label,nights,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, date, kind, unitId, b.cat, amt, b.method, status, str(b.note, 300), ctx.user.id, label(ctx.user), nights, nowIso());
    audit(ctx.user, 'ledger_add', { id, kind, amt });
    if (status === 'pending') alertCeo({ note: str(b.note, 300), cat: b.cat, amt });
    return { id, status };
  });
  route('POST', '/api/ledger/:id/void', STAFF, ctx => {
    const e = q('SELECT * FROM ledger WHERE id=?').get(ctx.params.id);
    if (!e) throw new HttpError(404, 'We could not find that entry.');
    if (ctx.user.role !== 'ceo' && e.ref) throw new HttpError(403, 'Only the CEO can void payments and payroll posted by the system.');
    if (!['approved', 'pending'].includes(e.status)) throw bad('This entry is already closed.');
    q("UPDATE ledger SET status='void',voided_by=? WHERE id=?").run(label(ctx.user), e.id);
    audit(ctx.user, 'ledger_void', { id: e.id, amt: e.amt });
    return { ok: true };
  });
  route('GET', '/api/approvals', CEO, () => ({ entries: q("SELECT * FROM ledger WHERE status='pending' ORDER BY date").all() }));
  route('POST', '/api/ledger/:id/decide', CEO, ctx => {
    const to = ctx.body.to; if (!['approved', 'rejected'].includes(to)) throw bad('Approve or reject this expense.');
    const r = q("UPDATE ledger SET status=?,decided_by='CEO' WHERE id=? AND status='pending'").run(to, ctx.params.id);
    if (!r.changes) throw new HttpError(409, 'This expense has already been decided.');
    audit(ctx.user, 'ledger_decide', { id: ctx.params.id, to });
    return { ok: true };
  });
  function report(m) {
    const ids = units().map(u => u.id).concat('shared');
    const entries = monthRows(m); const pnl = L.buildPnl(entries, ids);
    const nets = []; for (let i = 11; i >= 0; i--) { const mm = L.shiftMonth(m, -i); nets.push({ m: mm, net: L.buildPnl(monthRows(mm)).net }); }
    const isOpen = m === L.today().slice(0, 7);
    const days = isOpen ? Number(L.today().slice(8)) : L.daysIn(m);
    const occupancy = {};
    units().filter(u => u.kind === 'hotel').forEach(u => {
      const rooms = q('SELECT COALESCE(SUM(count),0) n FROM room_types WHERE unit_id=? AND active=1').get(u.id).n;
      occupancy[u.id] = rooms ? Math.round(pnl.byUnit[u.id].nights / (rooms * days) * 100) : null;
    });
    return { month: m, open: isOpen, count: entries.length, pnl, prevNet: nets[10].net, nets, occupancy, cats: { income: L.INCOME_CATS, expense: L.EXPENSE_CATS } };
  }
  route('GET', '/api/reports/month', STAFF, ctx => report(monthParam(ctx)));
  route('GET', '/api/reports/month.csv', STAFF, ctx => {
    const m = monthParam(ctx); const p = report(m).pnl; const money = v => (v / 100).toFixed(2);
    const name = id => (id === 'shared' ? 'Resort-wide costs' : (unit(id) || {}).name || id);
    const rows = [['APIJOS RESORT accounts', m], [], ['Revenue']];
    Object.keys(p.inc).forEach(k => rows.push([k, money(p.inc[k])]));
    rows.push(['Total revenue', money(p.income)], ['Cost of sales', money(p.cogs)], ['Gross profit', money(p.gross)]);
    Object.keys(p.exp).filter(k => k !== 'Cost of sales').forEach(k => rows.push([k, money(p.exp[k])]));
    rows.push(['Net profit or loss', money(p.net)], [], ['Business unit', 'Revenue', 'Costs', 'Net']);
    Object.keys(p.byUnit).forEach(id => { const u = p.byUnit[id]; rows.push([name(id), money(u.income), money(u.expense), money(u.net)]); });
    rows.push([], ['Date', 'Type', 'Business unit', 'Category', 'Amount', 'Method', 'Status', 'Note', 'Entered by']);
    monthRows(m).forEach(e => rows.push([e.date, e.kind, name(e.unit_id), e.cat, money(e.amt), e.method || '', e.status, e.note || '', e.by_label || '']));
    const cell = v => { let s = String(v ?? ''); if (/^[=+\-@\t\r]/.test(s) && Number.isNaN(Number(s))) s = `'${s}`; return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    ctx.res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="apijos-accounts-${m}.csv"` });
    ctx.res.end(`﻿${rows.map(r => r.map(cell).join(',')).join('\n')}`);
    return ctx.handled;
  });

  // --- stock and staff ---
  route('GET', '/api/stock', STAFF, () => ({ items: q('SELECT * FROM stock ORDER BY name').all() }));
  route('POST', '/api/stock', STAFF, ctx => {
    const b = ctx.body; const name = str(b.name, 100); if (!name) throw bad('Enter the item name.');
    if (!unit(str(b.unit, 40))) throw bad('Choose a business unit.');
    const id = str(b.id, 40) || newId();
    const reorder = Math.max(0, Number(b.reorder) || 0); const uom = str(b.uom, 20) || 'units';
    if (b.id) { const r = q('UPDATE stock SET name=?,unit_id=?,uom=?,reorder=? WHERE id=?').run(name, b.unit, uom, reorder, id); if (!r.changes) throw new HttpError(404, 'We could not find that item.'); }
    else q('INSERT INTO stock(id,name,unit_id,uom,qty,reorder) VALUES(?,?,?,?,?,?)').run(id, name, b.unit, uom, Math.max(0, Number(b.qty) || 0), reorder);
    return { id };
  });
  route('POST', '/api/stock/:id/in', STAFF, ctx => {
    const qty = Number(ctx.body.qty); const cost = int(ctx.body.cost);
    if (!(qty > 0)) throw bad('Enter the quantity received.');
    if (!(cost >= 0)) throw bad('Enter what it cost in total. Use 0 if it was free.');
    if (!L.METHODS.includes(ctx.body.method)) throw bad('Choose how it was paid.');
    db.tx(() => {
      const it = q('SELECT * FROM stock WHERE id=?').get(ctx.params.id); if (!it) throw new HttpError(404, 'We could not find that item.');
      q('UPDATE stock SET qty=qty+? WHERE id=?').run(qty, it.id);
      if (cost > 0) {
        const limit = Number(setting('approvalLimit')) || 0;
        q(`INSERT INTO ledger(id,date,kind,unit_id,cat,amt,method,status,note,by_user,by_label,created_at) VALUES(?,?,'expense',?,'Cost of sales',?,?,?,?,?,?,?)`).run(newId(), L.today(), it.unit_id, cost, ctx.body.method, ctx.user.role !== 'ceo' && limit && cost >= limit ? 'pending' : 'approved', `Restock: ${qty} ${it.uom} ${it.name}`, ctx.user.id, label(ctx.user), nowIso());
        if (ctx.user.role !== 'ceo' && limit && cost >= limit) alertCeo({ note: `Restock: ${qty} ${it.uom} ${it.name}`, cat: 'Cost of sales', amt: cost });
      }
      audit(ctx.user, 'stock_in', { id: it.id, qty, cost });
    });
    return { ok: true };
  });
  route('POST', '/api/stock/:id/out', STAFF, ctx => {
    const qty = Number(ctx.body.qty); if (!(qty > 0)) throw bad('Enter the quantity used.');
    const r = q('UPDATE stock SET qty=qty-? WHERE id=? AND qty>=?').run(qty, ctx.params.id, qty);
    if (!r.changes) throw bad('There is not that much in stock.');
    return { ok: true };
  });
  route('DELETE', '/api/stock/:id', STAFF, ctx => { q('DELETE FROM stock WHERE id=?').run(ctx.params.id); return { ok: true }; });
  route('GET', '/api/staff', STAFF, () => ({ teams: q('SELECT * FROM staff ORDER BY name').all() }));
  route('POST', '/api/staff', STAFF, ctx => {
    const b = ctx.body; const name = str(b.name, 100); const pay = int(b.pay); const people = int(b.people) || 1; const u = str(b.unit, 40);
    if (!name) throw bad('Enter a name or team.'); if (!(pay >= 0)) throw bad('Enter the monthly pay per person.');
    if (!(unit(u) || u === 'shared')) throw bad('Choose a business unit.');
    const id = str(b.id, 40) || newId();
    q('INSERT INTO staff(id,name,unit_id,people,pay) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,unit_id=excluded.unit_id,people=excluded.people,pay=excluded.pay').run(id, name, u, people, pay);
    audit(ctx.user, 'staff_save', { id, pay, people });
    return { id };
  });
  route('DELETE', '/api/staff/:id', STAFF, ctx => { q('DELETE FROM staff WHERE id=?').run(ctx.params.id); audit(ctx.user, 'staff_remove', { id: ctx.params.id }); return { ok: true }; });
  route('GET', '/api/payroll', STAFF, ctx => {
    const m = monthParam(ctx);
    return { posted: q('SELECT ref FROM ledger WHERE ref LIKE ?').all(`payroll-${m}-%`).map(r => r.ref) };
  });
  route('POST', '/api/payroll', STAFF, ctx => {
    const m = ctx.body.month; if (!L.isMonth(m) || m > L.today().slice(0, 7)) throw bad('Choose this month or an earlier one.');
    const date = m === L.today().slice(0, 7) ? L.today() : `${m}-${L.pad(L.daysIn(m))}`;
    let n = 0;
    db.tx(() => q('SELECT * FROM staff').all().forEach(t => {
      if (t.pay <= 0) return;
      n += Number(q(`INSERT OR IGNORE INTO ledger(id,date,kind,unit_id,cat,amt,method,status,note,by_user,by_label,ref,created_at) VALUES(?,?,'expense',?,'Payroll',?,'Bank transfer','approved',?,?,?,?,?)`).run(newId(), date, t.unit_id, t.pay * t.people, `Payroll: ${t.name}`, ctx.user.id, label(ctx.user), `payroll-${m}-${t.id}`, nowIso()).changes);
    }));
    if (!n) throw new HttpError(409, 'Payroll for that month is already posted.');
    audit(ctx.user, 'payroll', { month: m, teams: n });
    return { posted: n };
  });

  // --- catalog and settings ---
  route('PUT', '/api/admin/catalog', STAFF, ctx => {
    const b = ctx.body; if (!Array.isArray(b.units) || !Array.isArray(b.roomTypes) || !Array.isArray(b.menu)) throw bad('Those rates could not be read. Reload and try again.');
    const KINDS = ['hotel', 'bar', 'restaurant', 'pool', 'other'];
    const money = (v, what) => { const n = int(v); if (!(n >= 0)) throw bad(`${what} must be zero or more.`); return n; };
    db.tx(() => {
      const seen = { u: [], r: [], m: [] };
      b.units.forEach((u, i) => {
        const name = str(u.name, 80); if (!name) throw bad('Every business unit needs a name.'); if (!KINDS.includes(u.kind)) throw bad('Choose a kind for each unit.');
        const id = str(u.id, 40) || newId(); seen.u.push(id);
        q('INSERT INTO units(id,name,kind,sort,active) VALUES(?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET name=excluded.name,kind=excluded.kind,sort=excluded.sort,active=1').run(id, name, u.kind, i);
      });
      b.roomTypes.forEach((t, i) => {
        const name = str(t.name, 80); if (!name) throw bad('Every room type needs a name.'); if (!seen.u.includes(t.unit)) throw bad(`Choose a hotel for ${name}.`);
        const id = str(t.id, 40) || newId(); seen.r.push(id);
        q('INSERT INTO room_types(id,unit_id,name,rate,count,sleeps,sort,active) VALUES(?,?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET unit_id=excluded.unit_id,name=excluded.name,rate=excluded.rate,count=excluded.count,sleeps=excluded.sleeps,sort=excluded.sort,active=1').run(id, t.unit, name, money(t.rate, 'Room rates'), money(t.count, 'Room counts'), Math.max(1, money(t.sleeps, 'Sleeps')), i);
      });
      b.menu.forEach((m, i) => {
        const name = str(m.name, 100); if (!name) throw bad('Every menu item needs a name.'); if (!seen.u.includes(m.unit)) throw bad(`Choose where ${name} is sold.`);
        const id = str(m.id, 40) || newId(); seen.m.push(id);
        q('INSERT INTO menu_items(id,unit_id,section,name,price,sort,active) VALUES(?,?,?,?,?,?,1) ON CONFLICT(id) DO UPDATE SET unit_id=excluded.unit_id,section=excluded.section,name=excluded.name,price=excluded.price,sort=excluded.sort,active=1').run(id, m.unit, str(m.section, 40) || 'Menu', name, money(m.price, 'Prices'), i);
      });
      // Removed items are hidden, never erased, so old bookings still read correctly.
      const hide = (table, ids) => q(`UPDATE ${table} SET active=0 WHERE id NOT IN (${ids.map(() => '?').join(',') || "''"})`).run(...ids);
      hide('units', seen.u); hide('room_types', seen.r); hide('menu_items', seen.m);
      const p = b.pool || {};
      const put = q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
      put.run('poolAdult', String(money(p.adult ?? 0, 'Pool prices'))); put.run('poolChild', String(money(p.child ?? 0, 'Pool prices'))); put.run('poolMax', String(money(p.maxPerDay ?? 0, 'Pool places')));
      audit(ctx.user, 'catalog_save');
    });
    return catalog();
  });
  const SETTING_KEYS = ['resortName', 'slogan', 'currency', 'contactPhone', 'contactEmail', 'address', 'cancelPolicy', 'deskEmail', 'deskPhone'];
  route('GET', '/api/admin/settings', STAFF, ctx => ({ approvalLimit: Number(setting('approvalLimit')) || 0, ...(ctx.user.role === 'ceo' ? { deskEmail: setting('deskEmail'), deskPhone: setting('deskPhone') } : {}) }));
  route('PUT', '/api/admin/settings', CEO, ctx => {
    const b = ctx.body; const put = q('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    if (!str(b.resortName)) throw bad("Enter the resort's name.");
    const limit = int(b.approvalLimit); if (!(limit >= 0)) throw bad('Enter an approval limit of 0 or more.');
    db.tx(() => { SETTING_KEYS.forEach(k => { if (typeof b[k] === 'string') put.run(k, str(b[k], 1500)); }); put.run('approvalLimit', String(limit)); audit(ctx.user, 'settings_save'); });
    return { ok: true };
  });
  route('GET', '/api/admin/users', CEO, () => ({ users: q("SELECT id,email,name,phone,role,active FROM users WHERE role<>'customer' ORDER BY role,name").all() }));
  route('POST', '/api/admin/users', CEO, async ctx => {
    const email = str(ctx.body.email, 200).toLowerCase(); const name = str(ctx.body.name, 100);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Enter a valid email address.');
    if (!name) throw bad('Enter their name.');
    if (!['manager', 'ceo'].includes(ctx.body.role)) throw bad('Choose a role.');
    // No password is set here. The new person chooses one through a one-time link.
    const pw = await hashPassword(newToken()); const id = newId();
    try { q('INSERT INTO users(id,email,name,phone,role,pw,created_at) VALUES(?,?,?,?,?,?,?)').run(id, email, name, str(ctx.body.phone, 30), ctx.body.role, pw, nowIso()); }
    catch (e) { if (/UNIQUE/.test(e.message)) throw new HttpError(409, 'This email already has an account.'); throw e; }
    const token = newToken();
    q('INSERT INTO reset_tokens(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hashToken(token), id, Date.now() + DAY);
    audit(ctx.user, 'staff_account_add', { id, role: ctx.body.role });
    const url = `${appUrl}/reset#${token}`;
    const m = M.inviteMessage(msgCtx(), name, url);
    const emailed = await notifier.sendPrivateEmail({ to: email, subject: m.subject, text: m.text, html: m.html, kind: 'staff_invite' });
    return { id, url, emailed };
  });
  route('POST', '/api/admin/users/:id/active', CEO, ctx => {
    if (ctx.params.id === ctx.user.id) throw bad("You can't switch off your own account.");
    const active = ctx.body.active ? 1 : 0;
    const r = q("UPDATE users SET active=? WHERE id=? AND role<>'customer'").run(active, ctx.params.id);
    if (!r.changes) throw new HttpError(404, 'We could not find that account.');
    if (!active) q('DELETE FROM sessions WHERE user_id=?').run(ctx.params.id);
    audit(ctx.user, 'staff_account_active', { id: ctx.params.id, active });
    return { ok: true };
  });
  route('GET', '/api/admin/messages', CEO, () => ({
    email: notifier.enabled.email, sms: notifier.enabled.sms,
    rows: q('SELECT channel,recipient,subject,kind,status,attempts,last_error,created_at FROM outbox ORDER BY created_at DESC LIMIT 100').all(),
    failed: q("SELECT COUNT(*) n FROM outbox WHERE status='failed' AND created_at>?").get(new Date(Date.now() - 7 * 864e5).toISOString()).n,
  }));
  route('POST', '/api/admin/messages/test', CEO, async ctx => {
    const channel = ctx.body.channel; const to = str(ctx.body.to, 200);
    if (!['email', 'sms'].includes(channel)) throw bad('Choose email or text message.');
    if (!notifier.enabled[channel]) throw bad(`${channel === 'email' ? 'Email' : 'Text messages'} are not switched on yet. Add the keys in your hosting settings.`);
    try {
      if (channel === 'email') {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw bad('Enter a valid email address.');
        const m = M.deskAlert(msgCtx(), 'Test message', ['Your email messages are working.'], null);
        await notifier.sendEmail({ to, subject: m.subject, text: m.text, html: m.html });
      } else {
        const n = M.toMsisdn(to); if (!n) throw bad('Enter a valid phone number.');
        await notifier.sendSms({ to: n, text: `${setting('resortName')}: Test message. Your text messages are working.` });
      }
    } catch (e) { if (e.status) throw e; throw bad(`It did not send. ${e.message}`); }
    audit(ctx.user, 'message_test', { channel });
    return { ok: true };
  });
  route('GET', '/api/admin/audit', CEO, () => ({ rows: q('SELECT at,action,detail,(SELECT name FROM users u WHERE u.id=a.user_id) who FROM audit a ORDER BY id DESC LIMIT 200').all() }));
  route('GET', '/api/admin/backup', CEO, ctx => {
    const tmp = path.join(os.tmpdir(), `apijos-backup-${newId()}.db`);
    db.prepare('VACUUM INTO ?').run(tmp);
    audit(ctx.user, 'backup_download');
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="apijos-backup-${L.today()}.db"` });
    fs.createReadStream(tmp).on('close', () => fs.rm(tmp, () => {})).pipe(ctx.res);
    return ctx.handled;
  });

  /* ---------- server ---------- */
  const securityHeaders = res => {
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  };
  const clientIp = req => {
    if (config.trustProxy) { const f = String(req.headers['x-forwarded-for'] || '').split(',').map(s => s.trim()).filter(Boolean); if (f.length) return f[f.length - 1]; }
    return req.socket.remoteAddress || '';
  };
  const readBody = req => new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > 512 * 1024) { reject(new HttpError(413, 'That request is too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks))); req.on('error', reject);
  });
  const sameOrigin = req => {
    const origin = req.headers.origin; if (!origin) return !req.headers.cookie; // browsers always send Origin on cross-site writes
    const expected = [appUrl, `http://${req.headers.host}`, `https://${req.headers.host}`].filter(Boolean);
    return appUrl ? origin === appUrl : expected.includes(origin);
  };
  const sessionUser = req => {
    const m = String(req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
    if (!m) return {};
    const tokenHash = hashToken(m[1]);
    const row = q('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.active=1').get(tokenHash, Date.now());
    return row ? { user: row, tokenHash } : {};
  };
  const sendJson = (res, status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
  const publicDir = path.join(__dirname, '..', 'public');
  const handled = Symbol('handled');

  async function handle(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://x');
    const pathname = url.pathname;
    if (req.method === 'GET' && pathname === '/healthz') return sendJson(res, 200, { ok: true });
    if (req.method === 'GET' && STATIC[pathname]) {
      const [file, type] = STATIC[pathname]; res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(publicDir, file)).pipe(res);
    }
    if (req.method === 'GET' && PAGES.has(pathname)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(publicDir, 'index.html')).pipe(res);
    }
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/webhooks/')) { res.writeHead(404, { 'Content-Type': 'text/plain' }); return res.end('Not found'); }
    const match = routes.find(r => r.method === req.method && r.rx.test(pathname));
    if (!match) return sendJson(res, 404, { error: 'Not found' });
    const isWebhook = pathname.startsWith('/webhooks/');
    if (req.method !== 'GET' && !isWebhook && !sameOrigin(req)) return sendJson(res, 403, { error: 'This request came from another website and was blocked.' });
    const { user, tokenHash } = sessionUser(req);
    if (match.roles) {
      if (!user) return sendJson(res, 401, { error: 'Please sign in first.' });
      if (match.roles !== ANY && !match.roles.includes(user.role)) return sendJson(res, 403, { error: "Your account doesn't have access to this." });
    }
    const raw = req.method === 'GET' ? Buffer.alloc(0) : await readBody(req);
    let body = {};
    if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { throw bad('That request could not be read.'); } }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('That request could not be read.');
    const m = pathname.match(match.rx); const params = {};
    match.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const ctx = { req, res, params, query: Object.fromEntries(url.searchParams), body, raw, user, tokenHash, ip: clientIp(req), handled };
    const out = await match.handler(ctx);
    if (out !== handled) sendJson(res, 200, out);
  }
  const server = http.createServer((req, res) => {
    handle(req, res).catch(err => {
      const status = err.status || (err.upstream ? 502 : 500);
      if (status >= 500) console.error(new Date().toISOString(), req.method, req.url.split('?')[0], err.message);
      if (res.headersSent) return res.destroy();
      sendJson(res, status, { error: err.status ? err.message : err.upstream ? 'The payment service is not responding. Try again in a moment.' : 'Something went wrong on our side. Try again.' });
    });
  });
  server.requestTimeout = 30000; server.headersTimeout = 15000;
  const timer = setInterval(() => { try { expireHolds(); q('DELETE FROM sessions WHERE expires_at<?').run(Date.now()); sendReminders(); } catch (e) { console.error(e.message); } }, 60000);
  timer.unref();

  async function ensureCeo({ email, password, name }) {
    if (q("SELECT 1 FROM users WHERE role='ceo' LIMIT 1").get()) return false;
    if (!email || !passwordOk(password)) { console.warn('No CEO account yet. Set INITIAL_CEO_EMAIL and INITIAL_CEO_PASSWORD (10+ characters) and restart.'); return false; }
    q("INSERT INTO users(id,email,name,phone,role,pw,created_at) VALUES(?,?,?,'','ceo',?,?)").run(newId(), email.toLowerCase(), name || 'CEO', await hashPassword(password), nowIso());
    console.log('CEO account created.');
    return true;
  }
  return { server, db, ensureCeo, notifier, sendReminders, close: () => { clearInterval(timer); notifier.close(); server.close(); server.closeAllConnections(); db.close(); } };
}
module.exports = { createApp };
