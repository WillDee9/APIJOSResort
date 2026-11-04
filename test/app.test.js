'use strict';
process.env.TZ = 'Africa/Accra';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { createApp } = require('../server/app');
const L = require('../server/logic');
const M = require('../server/messages');
const { openDb } = require('../server/db');
const { DatabaseSync } = require('node:sqlite');

const KEY = 'sk_test_unit';
const CEO = { email: 'ceo@test.gh', password: 'ceo-password-123' };
let app; let base; let stub; let stubUrl;
const paystackTx = new Map(); // what the fake Paystack believes
const sentEmail = []; const sentSms = []; const keysSeen = []; const failNext = { email: [], sms: [] };
const flush = async () => { await new Promise(r => setTimeout(r, 90)); await app.notifier.processQueue(); await new Promise(r => setTimeout(r, 20)); };
const clearSent = async () => { await flush(); sentEmail.length = 0; sentSms.length = 0; keysSeen.length = 0; };

function client() {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const res = await fetch(base + url, {
      method,
      redirect: 'manual',
      headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), origin: base, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, json, headers: res.headers, text };
  };
  return { get: u => call('GET', u), post: (u, b, h) => call('POST', u, b || {}, h), put: (u, b) => call('PUT', u, b), del: u => call('DELETE', u), rawCookie: () => cookie };
}
let n = 0;
async function customer() {
  const c = client(); n += 1;
  const r = await c.post('/api/auth/register', { email: `guest${n}@test.gh`, name: `Guest ${n}`, phone: '0240000000', password: 'guest-password-1', consent: true });
  assert.equal(r.status, 200); c.email = `guest${n}@test.gh`;
  return c;
}
const webhook = (body, sig) => {
  const raw = JSON.stringify(body);
  return fetch(`${base}/webhooks/paystack`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-paystack-signature': sig ?? crypto.createHmac('sha512', KEY).update(raw).digest('hex') }, body: raw });
};
const day = n2 => L.addDays(L.today(), n2);
let ceo; let manager;

before(async () => {
  stub = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', d => chunks.push(d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/emails') {
        if (req.headers.authorization !== 'Bearer re_test') { res.statusCode = 401; return res.end('{}'); }
        const code = failNext.email.shift();
        if (code) { keysSeen.push(req.headers['idempotency-key']); res.statusCode = code; return res.end('{"message":"nope"}'); }
        const b = JSON.parse(Buffer.concat(chunks)); keysSeen.push(req.headers['idempotency-key']); sentEmail.push(b);
        return res.end('{"id":"e1"}');
      }
      if (req.url === '/api/v2/sms/send') {
        if (req.headers['api-key'] !== 'ark_test') { res.statusCode = 401; return res.end('{}'); }
        const code = failNext.sms.shift();
        if (code) { res.statusCode = code; return res.end('{"status":"error"}'); }
        sentSms.push(JSON.parse(Buffer.concat(chunks)));
        return res.end('{"status":"success","data":[]}');
      }
      if (req.headers.authorization !== `Bearer ${KEY}`) { res.statusCode = 401; return res.end(JSON.stringify({ status: false, message: 'bad key' })); }
      if (req.url === '/transaction/initialize') {
        const b = JSON.parse(Buffer.concat(chunks));
        paystackTx.set(b.reference, { status: 'abandoned', reference: b.reference, amount: Number(b.amount), currency: b.currency, channel: 'mobile_money', fees: 0 });
        return res.end(JSON.stringify({ status: true, data: { authorization_url: `${stubUrl}/pay/${b.reference}`, access_code: 'x', reference: b.reference } }));
      }
      const m = req.url.match(/^\/transaction\/verify\/(.+)$/);
      if (m) { const t = paystackTx.get(decodeURIComponent(m[1])); if (!t) { res.statusCode = 404; return res.end(JSON.stringify({ status: false, message: 'none' })); } return res.end(JSON.stringify({ status: true, data: t })); }
      res.statusCode = 404; return res.end('{}');
    });
  });
  await new Promise(r => stub.listen(0, '127.0.0.1', r));
  stubUrl = `http://127.0.0.1:${stub.address().port}`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apj-test-'));
  const probe = http.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
  base = `http://127.0.0.1:${port}`;
  app = createApp({ dataDir, appUrl: base, paystackKey: KEY, paystackBase: stubUrl, trustProxy: false, signupPerHour: 1000, forgotPerHour: 1000, email: { apiKey: 're_test', from: 'APIJOS <b@test.gh>', baseUrl: stubUrl }, sms: { apiKey: 'ark_test', sender: 'APIJOS', baseUrl: stubUrl } });
  await app.ensureCeo({ ...CEO, name: 'Test CEO' });
  await new Promise(r => app.server.listen(port, '127.0.0.1', r));
  ceo = client();
  assert.equal((await ceo.post('/api/auth/login', CEO)).status, 200);
  const made = await ceo.post('/api/admin/users', { email: 'mgr@test.gh', name: 'Manager', role: 'manager' });
  assert.equal(made.status, 200);
  const token = made.json.url.split('#')[1];
  assert.equal((await client().post('/api/auth/reset', { token, password: 'manager-password-1' })).status, 200);
  manager = client();
  assert.equal((await manager.post('/api/auth/login', { email: 'mgr@test.gh', password: 'manager-password-1' })).status, 200);
  const cat = (await ceo.get('/api/public/catalog')).json;
  const save = await ceo.put('/api/admin/catalog', {
    units: cat.units,
    roomTypes: [{ id: 'few', unit: 'hotel1', name: 'Small', rate: 50000, count: 2, sleeps: 2 }, { id: 'many', unit: 'hotel2', name: 'Big', rate: 100000, count: 50, sleeps: 4 }],
    menu: [{ id: 'rice', unit: 'restaurant', section: 'Mains', name: 'Rice', price: 9000 }, { id: 'beer', unit: 'bar1', section: 'Drinks', name: 'Beer', price: 3000 }],
    pool: { adult: 6000, child: 3000, maxPerDay: 5 },
  });
  assert.equal(save.status, 200);
});
after(() => { app.close(); stub.close(); stub.closeAllConnections(); });

const stay = (extra = {}) => ({ type: 'stay', roomType: 'many', checkIn: day(5), checkOut: day(7), guests: 2, pay: 'online', ...extra });
const paid = async (c, id, over = {}) => {
  const pay = await c.post(`/api/requests/${id}/pay`); assert.equal(pay.status, 200, JSON.stringify(pay.json));
  const t = paystackTx.get(pay.json.reference); Object.assign(t, { status: 'success', fees: 1950 }, over);
  return pay.json.reference;
};

test('anonymous visitors and customers cannot reach staff data', async () => {
  const anon = client(); const c = await customer();
  const staffOnly = ['/api/ledger?month=2026-01', '/api/reports/month?month=2026-01', '/api/reports/month.csv?month=2026-01', '/api/desk/requests', '/api/stock', '/api/staff', '/api/admin/users', '/api/admin/audit', '/api/admin/backup', '/api/approvals'];
  for (const u of staffOnly) {
    assert.equal((await anon.get(u)).status, 401, u);
    assert.equal((await c.get(u)).status, 403, u);
  }
  assert.equal((await c.post('/api/ledger', { kind: 'income', amt: 100 })).status, 403);
  assert.equal((await c.put('/api/admin/catalog', {})).status, 403);
  assert.equal((await c.post('/api/desk/requests/x/move', { to: 'confirmed' })).status, 403);
});

test('managers cannot use CEO-only powers', async () => {
  for (const u of ['/api/admin/users', '/api/admin/audit', '/api/admin/backup', '/api/approvals']) assert.equal((await manager.get(u)).status, 403, u);
  assert.equal((await manager.post('/api/admin/users', { email: 'x@y.gh', name: 'x', role: 'ceo' })).status, 403);
  assert.equal((await manager.put('/api/admin/settings', { resortName: 'Hack', approvalLimit: 0 })).status, 403);
  assert.equal((await manager.post('/api/ledger/x/decide', { to: 'approved' })).status, 403);
  const ceoId = (await ceo.get('/api/me')).json.user.id;
  assert.equal((await manager.post('/api/desk/reset-link', { userId: ceoId })).status, 403);
});

test('passwords are stored hashed, cookies are protected, and wrong logins are limited', async () => {
  const c = await customer();
  const row = app.db.prepare('SELECT pw FROM users WHERE email=?').get(c.email);
  assert.ok(row.pw.startsWith('s1$') && !row.pw.includes('guest-password-1'));
  const fresh = client();
  const ok = await fresh.post('/api/auth/login', { email: c.email, password: 'guest-password-1' });
  assert.match(ok.headers.get('set-cookie'), /HttpOnly/); assert.match(ok.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal(JSON.stringify(ok.json).includes('pw'), false);
  const attacker = client(); let last;
  for (let i = 0; i < 9; i++) last = await attacker.post('/api/auth/login', { email: c.email, password: 'wrong-password' });
  assert.equal(last.status, 429);
  assert.equal((await client().post('/api/auth/register', { email: 'short@test.gh', name: 'S', phone: '0240000000', password: 'short', consent: true })).status, 400);
});

test('forms posted from another website are blocked', async () => {
  const c = await customer();
  assert.equal((await c.post('/api/requests', stay(), { origin: 'https://evil.example' })).status, 403);
});

test('files outside the public folder cannot be read', async () => {
  for (const u of ['/../server/app.js', '/..%2fserver%2fapp.js', '/data/apijos.db', '/.env', '/package.json']) assert.equal((await fetch(base + u)).status, 404, u);
  const page = await fetch(base + '/');
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
});

test("customers can't see, pay for or cancel someone else's booking", async () => {
  const a = await customer(); const b = await customer();
  const { id } = (await a.post('/api/requests', stay())).json;
  assert.equal((await b.post(`/api/requests/${id}/pay`)).status, 404);
  assert.equal((await b.post(`/api/requests/${id}/cancel`)).status, 404);
  assert.equal((await b.get('/api/requests/mine')).json.requests.length, 0);
  const pay = await a.post(`/api/requests/${id}/pay`);
  assert.equal((await b.get(`/api/payments/${pay.json.reference}/confirm`)).status, 404);
});

test('the server sets the price and ignores prices sent by the browser', async () => {
  const c = await customer();
  const { id } = (await c.post('/api/requests', stay({ total: 1, rate: 1 }))).json;
  const r = (await c.get('/api/requests/mine')).json.requests.find(x => x.id === id);
  assert.equal(r.total, 200000);
  const { id: oid } = (await c.post('/api/requests', { type: 'order', pay: 'resort', deliverTo: 'Room 1', lines: [{ id: 'rice', qty: 2, price: 1 }] })).json;
  assert.equal((await c.get('/api/requests/mine')).json.requests.find(x => x.id === oid).total, 18000);
  assert.equal((await c.post('/api/requests', { type: 'order', pay: 'resort', deliverTo: 'Room 1', lines: [{ id: 'rice', qty: -5 }] })).status, 400);
});

test('five people racing for two rooms: exactly two get them', async () => {
  const people = await Promise.all([1, 2, 3, 4, 5].map(() => customer()));
  const results = await Promise.all(people.map(c => c.post('/api/requests', stay({ roomType: 'few', checkIn: day(20), checkOut: day(22) }))));
  assert.equal(results.filter(r => r.status === 200).length, 2);
  assert.equal(results.filter(r => r.status === 409).length, 3);
  const av = (await client().get(`/api/public/availability?from=${day(20)}&to=${day(22)}`)).json;
  assert.equal(av.rooms.few, 0);
});

test('an unpaid hold releases the room after it expires', async () => {
  const c = await customer();
  const { id } = (await c.post('/api/requests', stay({ roomType: 'few', checkIn: day(30), checkOut: day(31) }))).json;
  const q = `/api/public/availability?from=${day(30)}&to=${day(31)}`;
  assert.equal((await client().get(q)).json.rooms.few, 1);
  app.db.prepare('UPDATE requests SET hold_expires=? WHERE id=?').run(Date.now() - 1000, id);
  assert.equal((await client().get(q)).json.rooms.few, 2);
  assert.equal((await c.post(`/api/requests/${id}/pay`)).status, 400);
});

test('a forged payment message is rejected and changes nothing', async () => {
  const c = await customer();
  const { id } = (await c.post('/api/requests', stay())).json;
  const pay = await c.post(`/api/requests/${id}/pay`);
  const event = { event: 'charge.success', data: { reference: pay.json.reference, status: 'success', amount: 200000, currency: 'GHS' } };
  assert.equal((await webhook(event, 'deadbeef')).status, 401);
  assert.equal((await webhook(event, '')).status, 401);
  // Correctly signed, but Paystack's own records say it was not paid.
  assert.equal((await webhook(event)).status, 200);
  const r = (await c.get('/api/requests/mine')).json.requests.find(x => x.id === id);
  assert.equal(r.paid, 0); assert.equal(r.status, 'awaiting_payment');
});

test('a real payment confirms once, even if Paystack repeats the message', async () => {
  const c = await customer();
  const { id } = (await c.post('/api/requests', stay({ checkIn: day(40), checkOut: day(41) }))).json;
  const reference = await paid(c, id, { fees: 1950 });
  const event = { event: 'charge.success', data: { reference } };
  for (let i = 0; i < 3; i++) assert.equal((await webhook(event)).status, 200);
  assert.equal((await c.get(`/api/payments/${reference}/confirm`)).json.state, 'success');
  const r = (await c.get('/api/requests/mine')).json.requests.find(x => x.id === id);
  assert.equal(r.status, 'confirmed'); assert.equal(r.paid, 1);
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM ledger WHERE ref=?').get(`pay-${id}`).n, 1);
  const e = app.db.prepare('SELECT * FROM ledger WHERE ref=?').get(`pay-${id}`);
  assert.equal(e.amt, 100000); assert.equal(e.nights, 1);
  assert.equal(app.db.prepare('SELECT amt FROM ledger WHERE ref=?').get(`fee-${id}`).amt, 1950);
});

test('an underpayment does not confirm the booking and goes to staff for review', async () => {
  const c = await customer();
  const { id } = (await c.post('/api/requests', stay({ checkIn: day(42), checkOut: day(44) }))).json;
  const reference = await paid(c, id, { amount: 100 });
  await webhook({ event: 'charge.success', data: { reference } });
  const r = (await c.get('/api/requests/mine')).json.requests.find(x => x.id === id);
  assert.equal(r.paid, 0); assert.notEqual(r.status, 'confirmed');
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM ledger WHERE ref=?').get(`pay-${id}`).n, 0);
  const issues = (await manager.get('/api/desk/payment-issues')).json.issues;
  assert.ok(issues.some(i => i.reference === reference));
  assert.equal((await manager.post(`/api/desk/payment-issues/${reference}/resolve`, { note: 'Refunded on Paystack' })).status, 200);
  assert.ok(!(await manager.get('/api/desk/payment-issues')).json.issues.some(i => i.reference === reference));
});

test('paying twice for one booking counts once and alerts staff', async () => {
  const c = await customer();
  const { id } = (await c.post('/api/requests', stay({ checkIn: day(45), checkOut: day(46) }))).json;
  const first = await c.post(`/api/requests/${id}/pay`); const second = await c.post(`/api/requests/${id}/pay`);
  for (const p of [first, second]) { paystackTx.get(p.json.reference).status = 'success'; await webhook({ event: 'charge.success', data: { reference: p.json.reference } }); }
  assert.equal(app.db.prepare('SELECT COUNT(*) n FROM ledger WHERE ref=?').get(`pay-${id}`).n, 1);
  assert.ok((await manager.get('/api/desk/payment-issues')).json.issues.some(i => i.reference === second.json.reference));
});

test('money arriving after the room was taken is flagged, not lost', async () => {
  const a = await customer(); const b = await customer(); const d = await customer();
  const dates = { roomType: 'few', checkIn: day(50), checkOut: day(51) };
  const late = (await a.post('/api/requests', stay(dates))).json.id;
  const pay = await a.post(`/api/requests/${late}/pay`);
  app.db.prepare('UPDATE requests SET hold_expires=? WHERE id=?').run(Date.now() - 1000, late);
  assert.equal((await b.post('/api/requests', stay(dates))).status, 200);
  assert.equal((await d.post('/api/requests', stay(dates))).status, 200);
  paystackTx.get(pay.json.reference).status = 'success';
  await webhook({ event: 'charge.success', data: { reference: pay.json.reference } });
  const r = (await a.get('/api/requests/mine')).json.requests.find(x => x.id === late);
  assert.equal(r.status, 'payment_review'); assert.equal(r.paid, 1);
  assert.ok((await manager.get('/api/desk/payment-issues')).json.issues.some(i => i.request_id === late));
  assert.equal((await manager.post(`/api/desk/requests/${late}/move`, { to: 'cancelled' })).status, 200);
  assert.equal(app.db.prepare('SELECT amt FROM ledger WHERE ref=?').get(`refund-${late}`).amt, 50000);
});

test('desk workflow: walk-in, confirm, overbooking refused, cash payment posts once', async () => {
  const mk = () => manager.post('/api/desk/requests', { type: 'stay', roomType: 'few', checkIn: day(60), checkOut: day(62), guests: 1, guestName: 'Walk In', guestPhone: '0240000000' });
  const ids = [(await mk()).json.id, (await mk()).json.id, (await mk()).json.id];
  assert.equal((await manager.post(`/api/desk/requests/${ids[0]}/payment`, { method: 'Cash' })).status, 400);
  assert.equal((await manager.post(`/api/desk/requests/${ids[0]}/move`, { to: 'checked_out' })).status, 400);
  assert.equal((await manager.post(`/api/desk/requests/${ids[0]}/move`, { to: 'confirmed' })).status, 200);
  assert.equal((await manager.post(`/api/desk/requests/${ids[1]}/move`, { to: 'confirmed' })).status, 200);
  assert.equal((await manager.post(`/api/desk/requests/${ids[2]}/move`, { to: 'confirmed' })).status, 409);
  assert.equal((await manager.post(`/api/desk/requests/${ids[0]}/payment`, { method: 'Cash' })).status, 200);
  assert.equal((await manager.post(`/api/desk/requests/${ids[0]}/payment`, { method: 'Cash' })).status, 409);
  assert.equal((await manager.post(`/api/desk/requests/${ids[0]}/move`, { to: 'cancelled' })).status, 403);
  assert.equal((await ceo.post(`/api/desk/requests/${ids[0]}/move`, { to: 'cancelled' })).status, 200);
  assert.equal(app.db.prepare('SELECT method,amt FROM ledger WHERE ref=?').get(`refund-${ids[0]}`).method, 'Cash');
});

test('large expenses wait for the CEO and only count once approved', async () => {
  const m = '2020-03';
  const add = (b, c = manager) => c.post('/api/ledger', { date: `${m}-10`, unit: 'bar1', method: 'Cash', ...b });
  await add({ kind: 'income', cat: 'Drinks', amt: 1000000 });
  await add({ kind: 'expense', cat: 'Cost of sales', amt: 200000 });
  await add({ kind: 'expense', cat: 'Utilities', amt: 100033, unit: 'shared' });
  const big = await add({ kind: 'expense', cat: 'Maintenance', amt: 600000 });
  assert.equal(big.json.status, 'pending');
  const voided = await add({ kind: 'expense', cat: 'Marketing', amt: 12345 });
  assert.equal((await manager.post(`/api/ledger/${voided.json.id}/void`)).status, 200);
  let rep = (await ceo.get(`/api/reports/month?month=${m}`)).json;
  assert.equal(rep.pnl.income, 1000000); assert.equal(rep.pnl.cogs, 200000); assert.equal(rep.pnl.gross, 800000);
  assert.equal(rep.pnl.net, 699967); assert.equal(rep.pnl.pending, 600000);
  assert.equal(Object.values(rep.pnl.byUnit).reduce((s, u) => s + u.net, 0), rep.pnl.net);
  assert.equal((await ceo.post(`/api/ledger/${big.json.id}/decide`, { to: 'approved' })).status, 200);
  assert.equal((await ceo.post(`/api/ledger/${big.json.id}/decide`, { to: 'rejected' })).status, 409);
  rep = (await ceo.get(`/api/reports/month?month=${m}`)).json;
  assert.equal(rep.pnl.net, 99967); assert.equal(rep.pnl.pending, 0);
  const csv = await ceo.get(`/api/reports/month.csv?month=${m}`);
  assert.match(csv.text, /Net profit or loss,999\.67/);
  assert.equal((await manager.post('/api/ledger', { kind: 'income', date: day(1), cat: 'Rooms', amt: 5, unit: 'hotel1', method: 'Cash' })).status, 400);
});

test('managers cannot void system payments; spreadsheet formulas in notes are neutralised', async () => {
  const m = '2020-04';
  const e = await manager.post('/api/ledger', { kind: 'expense', date: `${m}-01`, cat: 'Other costs', amt: 100, unit: 'bar1', method: 'Cash', note: '=HYPERLINK("http://evil")' });
  assert.equal(e.status, 200);
  const csv = (await ceo.get(`/api/reports/month.csv?month=${m}`)).text;
  assert.match(csv, /'=HYPERLINK/);
  const sys = app.db.prepare("SELECT id FROM ledger WHERE ref LIKE 'pay-%' AND status='approved' LIMIT 1").get();
  assert.equal((await manager.post(`/api/ledger/${sys.id}/void`)).status, 403);
});

test('payroll posts once per month', async () => {
  const t = await manager.post('/api/staff', { name: 'Kitchen', unit: 'restaurant', people: 3, pay: 150000 });
  assert.equal(t.status, 200);
  assert.equal((await manager.post('/api/payroll', { month: '2020-05' })).json.posted, 1);
  assert.equal((await manager.post('/api/payroll', { month: '2020-05' })).status, 409);
  assert.equal(app.db.prepare('SELECT amt FROM ledger WHERE ref=?').get(`payroll-2020-05-${t.json.id}`).amt, 450000);
});

test('removing a room type hides it but keeps old bookings readable', async () => {
  const cat = (await ceo.get('/api/public/catalog')).json;
  const c = await customer();
  const { id } = (await c.post('/api/requests', { type: 'order', pay: 'resort', deliverTo: 'Pool', lines: [{ id: 'beer', qty: 1 }] })).json;
  assert.equal((await ceo.put('/api/admin/catalog', { units: cat.units, roomTypes: cat.roomTypes, menu: cat.menu.filter(m => m.id !== 'beer'), pool: cat.pool })).status, 200);
  assert.ok(!(await client().get('/api/public/catalog')).json.menu.some(m => m.id === 'beer'));
  assert.equal((await c.post('/api/requests', { type: 'order', pay: 'resort', deliverTo: 'Pool', lines: [{ id: 'beer', qty: 1 }] })).status, 400);
  assert.equal((await c.get('/api/requests/mine')).json.requests.find(r => r.id === id).lines[0].name, 'Beer');
});

test('switched-off staff lose access at once; reset links work one time only', async () => {
  const made = await ceo.post('/api/admin/users', { email: 'temp@test.gh', name: 'Temp', role: 'manager' });
  const token = made.json.url.split('#')[1];
  assert.equal((await client().post('/api/auth/reset', { token, password: 'temp-password-1' })).status, 200);
  assert.equal((await client().post('/api/auth/reset', { token, password: 'another-pass-22' })).status, 400);
  const temp = client();
  assert.equal((await temp.post('/api/auth/login', { email: 'temp@test.gh', password: 'temp-password-1' })).status, 200);
  assert.equal((await temp.get('/api/stock')).status, 200);
  assert.equal((await ceo.post(`/api/admin/users/${made.json.id}/active`, { active: false })).status, 200);
  assert.equal((await temp.get('/api/stock')).status, 401);
  assert.equal((await client().post('/api/auth/login', { email: 'temp@test.gh', password: 'temp-password-1' })).status, 401);
});

test('pool capacity is enforced', async () => {
  const c = await customer();
  const date = day(70);
  assert.equal((await c.post('/api/requests', { type: 'pool', date, adults: 4, kids: 0, pay: 'online' })).status, 200);
  assert.equal((await c.post('/api/requests', { type: 'pool', date, adults: 2, kids: 0, pay: 'online' })).status, 409);
});

test('the CEO can download a working database backup', async () => {
  const res = await fetch(`${base}/api/admin/backup`, { headers: { cookie: ceo.rawCookie() } });
  assert.equal(res.status, 200);
  const buf = Buffer.from(await res.arrayBuffer());
  assert.equal(buf.subarray(0, 15).toString(), 'SQLite format 3');
});

test('date and money helpers', () => {
  assert.equal(L.isDate('2026-02-30'), false); assert.equal(L.isDate('2028-02-29'), true);
  assert.equal(L.nightsBetween('2026-12-30', '2027-01-02'), 3);
  assert.equal(L.shiftMonth('2026-01', -1), '2025-12');
  assert.equal(L.daysIn('2028-02'), 29);
});

/* ---------- messages ---------- */
test('Ghana phone numbers are converted correctly and bad ones are refused', () => {
  assert.equal(M.toMsisdn('024 123 4567'), '233241234567');
  assert.equal(M.toMsisdn('+233 24 123 4567'), '233241234567');
  assert.equal(M.toMsisdn('233241234567'), '233241234567');
  assert.equal(M.toMsisdn('+44 7700 900123'), '447700900123');
  assert.equal(M.toMsisdn('00447700900123'), '447700900123');
  for (const bad of ['12345', '', 'hello', '024123']) assert.equal(M.toMsisdn(bad), null, bad);
});

test('every text fits one plain SMS, even with long names and special characters', () => {
  const ctx = { resort: 'APIJOS RESORT', slogan: 'x', currency: 'GH₵', phone: '0240000000', appUrl: 'https://x.gh', policy: '' };
  const stayR = { id: 'abcdefghi', type: 'stay', room_name: 'Présidentielle “Grand” Lagoon Executive Suite', check_in: '2026-12-01', check_out: '2026-12-05', guests: 2, guest_name: 'A', total: 123456789, paid: 1, paid_method: 'Cash' };
  const order = { id: 'abcdefghi', type: 'order', lines: JSON.stringify([{ qty: 1, name: 'Rice' }]), deliver_to: 'Room 1', guest_name: 'A', total: 5000 };
  const pool = { id: 'abcdefghi', type: 'pool', pool_date: '2026-12-01', adults: 1, kids: 1, guest_name: 'A', total: 5000 };
  for (const r of [stayR, order, pool]) for (const ev of ['received', 'paid', 'confirmed', 'accepted', 'declined', 'cancelled', 'desk_paid', 'review', 'reminder']) {
    const m = M.bookingMessage(ev, r, 'An Extremely Long Hotel Name For Testing Purposes', ctx);
    assert.ok(m.subject && m.text && m.html, ev);
    if (m.sms) { assert.ok(m.sms.length <= 160, `${ev}: ${m.sms.length}`); assert.match(m.sms, /^[\x20-\x7e]+$/, ev); assert.ok(!m.sms.includes('₵')); }
  }
  assert.match(M.bookingMessage('confirmed', stayR, 'H', ctx).sms, /GH|Ref APJ-ABCDEF/);
});

test('a paid booking sends one email and one text, however often Paystack repeats itself', async () => {
  const c = await customer(); await clearSent();
  const { id } = (await c.post('/api/requests', stay({ checkIn: day(80), checkOut: day(81) }))).json;
  await flush(); assert.equal(sentEmail.length, 0, 'nothing is sent before payment');
  const reference = await paid(c, id);
  for (let i = 0; i < 3; i++) await webhook({ event: 'charge.success', data: { reference } });
  await c.get(`/api/payments/${reference}/confirm`);
  await flush();
  assert.equal(sentEmail.filter(e => e.to[0] === c.email).length, 1);
  assert.equal(sentSms.length, 1);
  assert.deepEqual(sentSms[0].recipients, ['233240000000']);
  assert.equal(sentSms[0].sender, 'APIJOS');
  assert.match(sentEmail[0].subject, /confirmed/);
  assert.match(sentEmail[0].text, new RegExp(M.refOf({ id })));
});

test('pay-at-resort sends a receipt email, alerts the desk, and keeps alert contacts private', async () => {
  const c = await customer();
  const cat = (await ceo.get('/api/public/catalog')).json;
  assert.equal((await ceo.put('/api/admin/settings', { resortName: cat.resortName, approvalLimit: 500000, deskEmail: 'desk@test.gh', deskPhone: '0209999999' })).status, 200);
  await clearSent();
  const { id } = (await c.post('/api/requests', stay({ pay: 'resort', checkIn: day(82), checkOut: day(83) }))).json;
  await flush();
  assert.ok(sentEmail.some(e => e.to[0] === c.email && /received your request/.test(e.subject)));
  assert.ok(sentEmail.some(e => e.to[0] === 'desk@test.gh'));
  assert.equal(sentSms.length, 0, 'no text until confirmed');
  await clearSent();
  assert.equal((await manager.post(`/api/desk/requests/${id}/move`, { to: 'confirmed' })).status, 200);
  await flush();
  assert.equal(sentSms.length, 1); assert.match(sentSms[0].message, /confirmed/);
  const pub = JSON.stringify((await client().get('/api/public/catalog')).json);
  assert.ok(!pub.includes('desk@test.gh') && !pub.includes('0209999999'));
  assert.equal((await manager.get('/api/admin/settings')).json.deskEmail, undefined);
  assert.equal((await manager.get('/api/admin/messages')).status, 403);
  assert.equal((await manager.post('/api/admin/messages/test', { channel: 'email', to: 'a@b.gh' })).status, 403);
});

test('text messages respect the customer choice and walk-in consent', async () => {
  const c = await customer();
  assert.equal((await c.get('/api/me')).json.user.smsOn, true);
  await c.post('/api/me/sms', { on: false });
  assert.equal((await c.get('/api/me')).json.user.smsOn, false);
  const a = (await c.post('/api/requests', stay({ pay: 'resort', checkIn: day(84), checkOut: day(85) }))).json.id;
  await clearSent();
  await manager.post(`/api/desk/requests/${a}/move`, { to: 'confirmed' }); await flush();
  assert.equal(sentSms.length, 0); assert.ok(sentEmail.some(e => e.to[0] === c.email));
  const walk = (extra = {}) => manager.post('/api/desk/requests', { type: 'stay', roomType: 'many', checkIn: day(86), checkOut: day(87), guests: 1, guestName: 'Walk', guestPhone: '0241111111', ...extra });
  const no = (await walk()).json.id; const yes = (await walk({ smsOk: true })).json.id;
  await clearSent();
  await manager.post(`/api/desk/requests/${no}/move`, { to: 'confirmed' }); await flush();
  assert.equal(sentSms.length, 0);
  await manager.post(`/api/desk/requests/${yes}/move`, { to: 'confirmed' }); await flush();
  assert.deepEqual(sentSms[0].recipients, ['233241111111']);
  // Customers cannot switch this on for a booking themselves or set consent on someone else.
  assert.equal(JSON.stringify((await c.get('/api/requests/mine')).json).includes('0241111111'), false);
});

test('a provider outage retries with the same key; a rejected message stops', async () => {
  await clearSent();
  const row = id => app.db.prepare('SELECT * FROM outbox WHERE id=?').get(id);
  failNext.email.push(500);
  assert.ok(app.notifier.enqueue({ channel: 'email', to: 'r@test.gh', subject: 's', text: 't', html: '<p>t</p>', kind: 'test_retry' }));
  await flush();
  const m = app.db.prepare("SELECT * FROM outbox WHERE kind='test_retry'").get();
  assert.equal(m.status, 'pending'); assert.equal(m.attempts, 1); assert.ok(m.next_try > Date.now());
  assert.equal(sentEmail.length, 0);
  app.db.prepare('UPDATE outbox SET next_try=0 WHERE id=?').run(m.id);
  await flush();
  assert.equal(row(m.id).status, 'sent'); assert.equal(row(m.id).body, '', 'sent content is not kept');
  assert.equal(keysSeen[0], keysSeen[1]); assert.equal(keysSeen[0], m.id); assert.equal(sentEmail.length, 1);
  failNext.sms.push(400);
  app.notifier.enqueue({ channel: 'sms', to: '0241234567', text: 'x', kind: 'test_reject' }); await flush();
  const f = app.db.prepare("SELECT * FROM outbox WHERE kind='test_reject'").get();
  assert.equal(f.status, 'failed'); assert.match(f.last_error, /400/);
  assert.equal((await ceo.get('/api/admin/messages')).json.failed >= 1, true);
  assert.equal(app.notifier.enqueue({ channel: 'sms', to: 'nonsense', text: 'x', kind: 'test_bad' }), false);
});

test('a refused action sends nothing', async () => {
  const mk = () => manager.post('/api/desk/requests', { type: 'stay', roomType: 'few', checkIn: day(90), checkOut: day(91), guests: 1, guestName: 'W', guestPhone: '0241111111', smsOk: true });
  const ids = [(await mk()).json.id, (await mk()).json.id, (await mk()).json.id];
  await manager.post(`/api/desk/requests/${ids[0]}/move`, { to: 'confirmed' }); await manager.post(`/api/desk/requests/${ids[1]}/move`, { to: 'confirmed' });
  await clearSent();
  assert.equal((await manager.post(`/api/desk/requests/${ids[2]}/move`, { to: 'confirmed' })).status, 409);
  await flush(); assert.equal(sentSms.length, 0);
});

test('guest names cannot inject code into emails', async () => {
  const c = client(); await clearSent();
  const r = await c.post('/api/auth/register', { email: 'xss@test.gh', name: '<img src=x onerror=alert(1)>', phone: '0240000000', password: 'guest-password-1', consent: true });
  assert.equal(r.status, 200);
  await c.post('/api/requests', stay({ pay: 'resort', checkIn: day(92), checkOut: day(93) })); await flush();
  const m = sentEmail.find(e => e.to[0] === 'xss@test.gh');
  assert.ok(!m.html.includes('<img')); assert.ok(m.html.includes('&lt;img'));
});

test('reminders go once, the day before, and skip bookings made today', async () => {
  const old = (await manager.post('/api/desk/requests', { type: 'stay', roomType: 'many', checkIn: day(1), checkOut: day(2), guests: 1, guestName: 'Old', guestPhone: '0242222222', smsOk: true })).json.id;
  const fresh = (await manager.post('/api/desk/requests', { type: 'stay', roomType: 'many', checkIn: day(1), checkOut: day(2), guests: 1, guestName: 'New', guestPhone: '0243333333', smsOk: true })).json.id;
  await manager.post(`/api/desk/requests/${old}/move`, { to: 'confirmed' }); await manager.post(`/api/desk/requests/${fresh}/move`, { to: 'confirmed' });
  app.db.prepare('UPDATE requests SET created_at=? WHERE id=?').run(`${day(-3)}T08:00:00.000Z`, old);
  await clearSent();
  const realHours = Date.prototype.getHours; Date.prototype.getHours = () => 10;
  try { app.sendReminders(); app.sendReminders(); } finally { Date.prototype.getHours = realHours; }
  await flush();
  const to = sentSms.filter(s => /See you tomorrow/.test(s.message)).map(s => s.recipients[0]);
  assert.deepEqual(to, ['233242222222']);
});

test('forgot password: private, one-time, and tells nobody who has an account', async () => {
  const c = await customer(); await clearSent();
  const unknown = await client().post('/api/auth/forgot', { email: 'nobody@test.gh' });
  const known = await client().post('/api/auth/forgot', { email: c.email });
  assert.equal(unknown.status, 200); assert.equal(known.status, 200); assert.deepEqual(unknown.json, known.json);
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sentEmail.length, 1); assert.equal(sentEmail[0].to[0], c.email);
  const token1 = sentEmail[0].text.match(/\/reset#(\S+)/)[1];
  const stored = app.db.prepare("SELECT * FROM outbox WHERE kind='password_reset' ORDER BY created_at DESC").get();
  assert.equal(stored.body, ''); assert.equal(JSON.stringify(app.db.prepare('SELECT * FROM reset_tokens').all()).includes(token1), false);
  // A newer link cancels an older one.
  await client().post('/api/auth/forgot', { email: c.email }); await new Promise(r => setTimeout(r, 60));
  const token2 = sentEmail[1].text.match(/\/reset#(\S+)/)[1];
  assert.equal((await client().post('/api/auth/reset', { token: token1, password: 'brand-new-pass-1' })).status, 400);
  assert.equal((await c.get('/api/me')).json.user.email, c.email);
  assert.equal((await client().post('/api/auth/reset', { token: token2, password: 'brand-new-pass-1' })).status, 200);
  assert.equal((await client().post('/api/auth/reset', { token: token2, password: 'brand-new-pass-2' })).status, 400);
  assert.equal((await c.get('/api/me')).json.user, null, 'old sessions end');
  assert.equal((await client().post('/api/auth/login', { email: c.email, password: 'guest-password-1' })).status, 401);
  assert.equal((await client().post('/api/auth/login', { email: c.email, password: 'brand-new-pass-1' })).status, 200);
  await flush(); assert.ok(sentEmail.some(e => /password was changed/.test(e.subject)));
  // Expired links fail, and one mailbox can't be flooded.
  await clearSent();
  const d = await customer();
  for (let i = 0; i < 6; i++) await client().post('/api/auth/forgot', { email: d.email });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(sentEmail.filter(e => e.to[0] === d.email).length, 3);
  const last = sentEmail.filter(e => e.to[0] === d.email).pop().text.match(/\/reset#(\S+)/)[1];
  app.db.prepare('UPDATE reset_tokens SET expires_at=1').run();
  assert.equal((await client().post('/api/auth/reset', { token: last, password: 'brand-new-pass-3' })).status, 400);
});

test('new staff get their invitation by email', async () => {
  await clearSent();
  const r = await ceo.post('/api/admin/users', { email: 'invite@test.gh', name: 'Invited', role: 'manager' });
  assert.equal(r.json.emailed, true);
  assert.ok(sentEmail.some(e => e.to[0] === 'invite@test.gh' && e.text.includes('/reset#')));
});

test('large expenses email the CEO; CEO test messages work', async () => {
  await clearSent();
  await manager.post('/api/ledger', { kind: 'expense', date: '2020-06-01', cat: 'Maintenance', amt: 700000, unit: 'bar1', method: 'Cash', note: 'New roof' }); await flush();
  assert.ok(sentEmail.some(e => e.to[0] === CEO.email && /approval/.test(e.subject) && e.text.includes('New roof')));
  assert.equal((await ceo.post('/api/admin/messages/test', { channel: 'sms', to: '0241234567' })).status, 200);
  failNext.email.push(401);
  const bad2 = await ceo.post('/api/admin/messages/test', { channel: 'email', to: 'a@b.gh' });
  assert.equal(bad2.status, 400); assert.match(bad2.json.error, /did not send/);
});

test('with no message keys set the site still works and says so', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apj-nokeys-'));
  const plain = createApp({ dataDir: dir, appUrl: 'http://localhost:1', paystackKey: '', trustProxy: false });
  assert.equal(plain.notifier.enabled.email, false); assert.equal(plain.notifier.enabled.sms, false);
  assert.equal(plain.notifier.enqueue({ channel: 'email', to: 'a@b.gh', subject: 's', text: 't' }), false);
  assert.equal(plain.db.prepare('SELECT COUNT(*) n FROM outbox').get().n, 0);
  plain.close();
});

test('a database from the first version upgrades without losing data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apj-old-'));
  const old = new DatabaseSync(path.join(dir, 'apijos.db'));
  old.exec(`CREATE TABLE users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL, pw TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
    CREATE TABLE requests(id TEXT PRIMARY KEY, type TEXT NOT NULL, user_id TEXT, source TEXT NOT NULL, guest_name TEXT NOT NULL, guest_phone TEXT NOT NULL, unit_id TEXT NOT NULL, room_type_id TEXT, room_name TEXT, check_in TEXT, check_out TEXT, guests INTEGER, pool_date TEXT, adults INTEGER, kids INTEGER, deliver_to TEXT, lines TEXT, total INTEGER NOT NULL, status TEXT NOT NULL, pay_choice TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0, paid_method TEXT, hold_expires INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO users(id,email,name,role,pw,created_at) VALUES('u1','a@b.gh','Old','customer','x','2026-01-01');`);
  old.close();
  for (let i = 0; i < 2; i++) { const db = openDb(dir); const u = db.prepare('SELECT * FROM users WHERE id=?').get('u1'); assert.equal(u.name, 'Old'); assert.equal(u.sms_on, 1); assert.ok(db.prepare('PRAGMA table_info(requests)').all().some(c => c.name === 'reminder_sent')); db.close(); }
});
