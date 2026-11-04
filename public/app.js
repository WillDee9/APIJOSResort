'use strict';
/* ---------- helpers ---------- */
const METHODS = ['Cash', 'Mobile money', 'Card', 'Bank transfer'];
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = () => iso(new Date());
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00`); d.setDate(d.getDate() + n); return iso(d); };
const nightsBetween = (a, b) => Math.round((new Date(`${b}T12:00:00`) - new Date(`${a}T12:00:00`)) / 864e5);
const nightsLabel = n => `${n} night${n === 1 ? '' : 's'}`;
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(y, mo - 1 + n, 1); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`; };
const monthName = (m, opt = { month: 'long', year: 'numeric' }) => { const [y, mo] = m.split('-').map(Number); return new Date(y, mo - 1, 1).toLocaleDateString('en-GB', opt); };
const niceDate = s => new Date(`${s}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const toMinor = v => { const n = parseFloat(v); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
const clone = o => JSON.parse(JSON.stringify(o));
const cur = () => (S.cat && S.cat.currency) || 'GH₵';
const money = p => `${p < 0 ? '−' : ''}${cur()} ${(Math.abs(p || 0) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const whole = p => `${p < 0 ? '−' : ''}${cur()} ${(Math.abs(p || 0) / 100).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`;
const short = p => { const a = Math.abs(p) / 100; const t = a >= 1e6 ? `${(a / 1e6).toFixed(1)}m` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : String(Math.round(a)); return (p < 0 ? '−' : '') + t; };

async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, { method, credentials: 'same-origin', headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  } catch { throw new Error('No connection. Check your internet and try again.'); }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(json.error || 'Something went wrong. Try again.'); e.status = res.status; throw e; }
  return json;
}

/* ---------- state ---------- */
const S = {
  user: null, cat: null, tab: null, d: {}, cart: {}, modal: null, toast: null, busy: false, ready: false, err: null, after: null,
  month: shiftMonth(today().slice(0, 7), -1), avail: { rooms: {}, poolLeft: null },
  settings: {}, msgs: null, reqs: [], issues: [], mine: [], report: null, entries: [], pendingEntries: [], stock: [], teams: [], posted: [], users: [], audit: [], limit: 0,
  reqFilter: 'open', bookFilter: 'all', sub: 'stay', cd: null, payResult: null, link: null, found: null,
};
const val = (id, def) => (id in S.d ? S.d[id] : def);
const isStaff = () => S.user && S.user.role !== 'customer';
const isCeo = () => S.user && S.user.role === 'ceo';
const unitName = id => (id === 'shared' ? 'Resort-wide costs' : ((S.cat.units.find(u => u.id === id) || {}).name || 'Removed unit'));
const unitKind = id => (S.cat.units.find(u => u.id === id) || {}).kind;
const unitOpts = incl => [...S.cat.units.map(u => [u.id, u.name]), ...(incl ? [['shared', 'Resort-wide costs']] : [])];
const INCOME_CATS = ['Rooms', 'Food', 'Drinks', 'Pool tickets', 'Events', 'Other income'];
const EXPENSE_CATS = ['Cost of sales', 'Payroll', 'Utilities', 'Maintenance', 'Marketing', 'Licences & insurance', 'Payment fees', 'Refunds', 'Other costs'];

function toast(msg, err) { S.toast = { msg, err }; schedule(); clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = null; schedule(); }, err ? 7000 : 3500); }
function fail(msg) { throw new Error(msg); }
async function act(fn, ok) {
  if (S.busy) return;
  S.busy = true; schedule();
  try { await fn(); if (ok) toast(ok); } catch (e) {
    if (e.status === 401 && S.user) { S.user = null; S.tab = 'stay'; toast('Your session ended. Please sign in again.', true); } else toast(e.message, true);
  } finally { S.busy = false; schedule(); }
}

/* ---------- loading ---------- */
const NAV_CEO = [['report', 'Month report'], ['approvals', 'Approvals'], ['today', 'Today'], ['requests', 'Bookings and orders'], ['walkin', 'New walk-in'], ['book', 'Cash book'], ['stock', 'Stock'], ['team', 'Staff and payroll'], ['rates', 'Rates and menu'], ['people', 'Accounts'], ['settings', 'Resort settings'], ['account', 'My password']];
const NAV_MGR = [['today', 'Today'], ['requests', 'Bookings and orders'], ['walkin', 'New walk-in'], ['book', 'Cash book'], ['stock', 'Stock'], ['team', 'Staff and payroll'], ['report', 'Month report'], ['rates', 'Rates and menu'], ['people', 'Customer help'], ['account', 'My password']];
const NAV_PUB = [['stay', 'Book a room'], ['food', 'Food and drinks'], ['pool', 'Swimming pool'], ['mine', 'My bookings'], ['account', 'My account']];
const nav = () => (isCeo() ? NAV_CEO : isStaff() ? NAV_MGR : NAV_PUB.filter(n => S.user || !['mine', 'account'].includes(n[0])));

async function refreshAvail() {
  const from = val('checkIn', addDays(today(), 1)); const to = val('checkOut', addDays(today(), 2)); const date = val('poolDate', today());
  const ok = to > from && nightsBetween(from, to) <= 60;
  S.avail = await api('GET', `/api/public/availability?${ok ? `from=${from}&to=${to}&` : ''}date=${date}`);
}
async function load() {
  const t = S.tab; const m = S.month;
  const J = (u, k) => api('GET', u).then(x => { S[k] = x; });
  if (t === 'stay' || t === 'pool' || t === 'walkin') await refreshAvail();
  if (t === 'mine') S.mine = (await api('GET', '/api/requests/mine')).requests;
  if (t === 'today' || t === 'requests') {
    const [a, b, c] = await Promise.all([api('GET', '/api/desk/requests'), api('GET', '/api/desk/payment-issues'), api('GET', '/api/stock')]);
    S.reqs = a.requests; S.issues = b.issues; S.stock = c.items;
  }
  if (t === 'report') await J(`/api/reports/month?month=${m}`, 'report');
  if (t === 'book') { S.entries = (await api('GET', `/api/ledger?month=${m}`)).entries; S.limit = (await api('GET', '/api/admin/settings')).approvalLimit; }
  if (t === 'approvals') S.pendingEntries = (await api('GET', '/api/approvals')).entries;
  if (t === 'stock') S.stock = (await api('GET', '/api/stock')).items;
  if (t === 'team') { S.teams = (await api('GET', '/api/staff')).teams; S.posted = (await api('GET', `/api/payroll?month=${m}`)).posted; }
  if (t === 'people' && isCeo()) { S.users = (await api('GET', '/api/admin/users')).users; S.audit = (await api('GET', '/api/admin/audit')).rows; S.msgs = await api('GET', '/api/admin/messages'); }
  if (t === 'settings') { S.settings = await api('GET', '/api/admin/settings'); S.limit = S.settings.approvalLimit; }
  if (isCeo() && t !== 'approvals') S.pendingEntries = (await api('GET', '/api/approvals')).entries;
}
const refresh = () => load().then(schedule).catch(e => { if (e.status === 401) { S.user = null; S.tab = 'stay'; schedule(); } else toast(e.message, true); });
function go(tab) { S.tab = tab; S.modal = null; S.link = null; if (tab !== 'rates') S.cd = null; if (window.location.pathname !== '/') history.replaceState(null, '', isStaff() ? '/portal' : '/'); window.scrollTo(0, 0); schedule(); refresh(); }
const reloadCat = async () => { S.cat = await api('GET', '/api/public/catalog'); };

/* ---------- actions ---------- */
function needLogin(retry) { S.after = retry; S.modal = { k: 'auth', mode: 'login' }; schedule(); }
const A = {
  tab: d => go(d.t),
  sub: d => { S.sub = d.s; schedule(); },
  month: d => { S.month = shiftMonth(S.month, +d.n); schedule(); refresh(); },
  setMonth: d => { S.month = d.m; schedule(); refresh(); },
  filter: d => { S[d.k] = d.v; schedule(); },
  close: () => { S.modal = null; S.after = null; schedule(); },
  signin: () => { S.modal = { k: 'auth', mode: 'login' }; schedule(); },
  authMode: d => { S.modal = { k: 'auth', mode: d.m }; schedule(); },
  privacy: () => { S.tab = 'privacy'; S.modal = null; schedule(); window.scrollTo(0, 0); },
  home: () => go(isStaff() ? (isCeo() ? 'report' : 'today') : 'stay'),
  outlet: d => { S.d.outlet = d.id; schedule(); },
  pickRoom: d => { S.d.roomType = d.id; schedule(); },
  qty: d => { const n = (S.cart[d.id] || 0) + (+d.n); if (n <= 0) delete S.cart[d.id]; else S.cart[d.id] = n; schedule(); },
  login: () => act(async () => {
    const r = await api('POST', '/api/auth/login', { email: val('aEmail', ''), password: val('aPass', '') });
    delete S.d.aPass; signedIn(r.user);
  }),
  register: () => act(async () => {
    const r = await api('POST', '/api/auth/register', { email: val('aEmail', ''), name: val('aName', ''), phone: val('aPhone', ''), password: val('aPass', ''), consent: S.d.aConsent === true });
    delete S.d.aPass; signedIn(r.user);
  }, 'Your account is ready.'),
  logout: () => act(async () => { await api('POST', '/api/auth/logout', {}); S.user = null; S.d = {}; S.cart = {}; S.tab = 'stay'; history.replaceState(null, '', '/'); await refresh(); }, 'You are signed out.'),
  changePw: () => act(async () => {
    await api('POST', '/api/auth/password', { current: val('pwOld', ''), password: val('pwNew', '') });
    delete S.d.pwOld; delete S.d.pwNew;
  }, 'Password changed. Other devices have been signed out.'),
  doReset: () => act(async () => {
    await api('POST', '/api/auth/reset', { token: S.resetToken, password: val('pwNew', '') });
    S.resetToken = null; delete S.d.pwNew; history.replaceState(null, '', '/'); S.tab = 'stay'; S.modal = { k: 'auth', mode: 'login' }; await refresh();
  }, 'Password set. You can sign in now.'),
  bookStay: () => { const retry = () => A.bookStay(); if (!S.user) return needLogin(retry); return act(async () => {
    const pay = val('stayPay', S.cat.paystack ? 'online' : 'resort');
    await submit({ type: 'stay', roomType: S.d.roomType, checkIn: val('checkIn', addDays(today(), 1)), checkOut: val('checkOut', addDays(today(), 2)), guests: +val('guests', 2) }, pay, () => { delete S.d.roomType; });
  }); },
  bookOrder: () => { const retry = () => A.bookOrder(); if (!S.user) return needLogin(retry); return act(async () => {
    const ids = Object.keys(S.cart); if (!ids.length) fail('Add something to your order first.');
    const groups = {}; ids.forEach(id => { const m = S.cat.menu.find(x => x.id === id); if (m) (groups[m.unit] = groups[m.unit] || []).push({ id, qty: S.cart[id] }); });
    const pay = val('foodPay', 'resort'); const keys = Object.keys(groups);
    if (pay === 'online' && keys.length > 1) fail('To pay online, order from one place at a time. Or choose pay on delivery.');
    for (const unit of keys) await submit({ type: 'order', lines: groups[unit], deliverTo: val('deliverTo', '') }, pay, () => {});
    S.cart = {}; delete S.d.deliverTo;
  }); },
  bookPool: () => { const retry = () => A.bookPool(); if (!S.user) return needLogin(retry); return act(async () => {
    await submit({ type: 'pool', date: val('poolDate', today()), adults: +val('poolAdults', 2), kids: +val('poolKids', 0) }, val('poolPay', S.cat.paystack ? 'online' : 'resort'), () => {});
  }); },
  payNow: d => act(() => startPayment(d.id)),
  cancelMine: d => act(async () => { await api('POST', `/api/requests/${d.id}/cancel`, {}); await load(); }, 'Request cancelled.'),
  move: d => act(async () => { await api('POST', `/api/desk/requests/${d.id}/move`, { to: d.to }); await load(); }, { confirmed: 'Confirmed.', preparing: 'Order accepted.', declined: 'Declined.', cancelled: 'Cancelled.', checked_in: 'Guest checked in.', checked_out: 'Guest checked out.', served: 'Marked as served.', used: 'Pass marked as used.' }[d.to]),
  payOpen: d => { S.modal = { k: 'pay', id: d.id }; schedule(); },
  payDo: () => act(async () => { await api('POST', `/api/desk/requests/${S.modal.id}/payment`, { method: val('payMethod', 'Cash') }); S.modal = null; await load(); }, 'Payment recorded in the cash book.'),
  resolveOpen: d => { S.modal = { k: 'resolve', ref: d.ref }; schedule(); },
  resolveDo: () => act(async () => { await api('POST', `/api/desk/payment-issues/${S.modal.ref}/resolve`, { note: val('resolveNote', '') }); delete S.d.resolveNote; S.modal = null; await load(); }, 'Marked as sorted.'),
  addEntry: () => act(async () => {
    const kind = val('eKind', 'income'); const cats = kind === 'income' ? INCOME_CATS : EXPENSE_CATS; let cat = val('eCat', cats[0]); if (!cats.includes(cat)) cat = cats[0];
    const date = val('eDate', today()); const unit = val('eUnit', S.cat.units[0].id);
    const r = await api('POST', '/api/ledger', { kind, date, unit, cat, amt: toMinor(val('eAmt', '')), method: val('eMethod', 'Cash'), note: val('eNote', ''), nights: +val('eNights', 0) || 0 });
    delete S.d.eAmt; delete S.d.eNote; delete S.d.eNights; S.month = date.slice(0, 7); await load();
    toast(r.status === 'pending' ? 'Saved. It waits for CEO approval because it is at or above the limit.' : 'Saved to the cash book.');
  }),
  voidOpen: d => { S.modal = { k: 'void', id: d.id }; schedule(); },
  voidDo: () => act(async () => { await api('POST', `/api/ledger/${S.modal.id}/void`, {}); S.modal = null; await load(); }, 'Entry voided. It stays on record but no longer counts.'),
  decide: d => act(async () => { await api('POST', `/api/ledger/${d.id}/decide`, { to: d.to }); await load(); }, d.to === 'approved' ? 'Approved. It now counts in the accounts.' : 'Rejected.'),
  modalStock: d => { S.modal = { k: d.m, id: d.id || null }; ['sQty', 'sCost', 'sName', 'sUom', 'sReorder', 'sUnit'].forEach(k => delete S.d[k]); schedule(); },
  stockIn: () => act(async () => { await api('POST', `/api/stock/${S.modal.id}/in`, { qty: +val('sQty', 0), cost: toMinor(val('sCost', '')), method: val('sMethod', 'Cash') }); S.modal = null; await load(); }, 'Stock updated.'),
  stockOut: () => act(async () => { await api('POST', `/api/stock/${S.modal.id}/out`, { qty: +val('sQty', 0) }); S.modal = null; await load(); }, 'Stock updated.'),
  stockSave: () => act(async () => {
    const i = S.modal.id ? S.stock.find(x => x.id === S.modal.id) : {};
    await api('POST', '/api/stock', { id: S.modal.id || undefined, name: val('sName', i.name || ''), unit: val('sUnit', i.unit_id || S.cat.units[0].id), uom: val('sUom', i.uom || 'units'), reorder: +val('sReorder', i.reorder || 0), qty: +val('sQty', 0) });
    S.modal = null; await load();
  }, 'Item saved.'),
  stockDel: () => act(async () => { await api('DELETE', `/api/stock/${S.modal.id}`); S.modal = null; await load(); }, 'Item removed.'),
  modalTeam: d => { S.modal = { k: 'team', id: d.id || null }; ['tName', 'tUnit', 'tPeople', 'tPay'].forEach(k => delete S.d[k]); schedule(); },
  teamSave: () => act(async () => {
    const t = S.modal.id ? S.teams.find(x => x.id === S.modal.id) : {};
    await api('POST', '/api/staff', { id: S.modal.id || undefined, name: val('tName', t.name || ''), unit: val('tUnit', t.unit_id || S.cat.units[0].id), people: +val('tPeople', t.people || 1), pay: toMinor(val('tPay', t.pay ? t.pay / 100 : '')) });
    S.modal = null; await load();
  }, 'Saved.'),
  teamDel: () => act(async () => { await api('DELETE', `/api/staff/${S.modal.id}`); S.modal = null; await load(); }, 'Removed.'),
  payroll: () => act(async () => { const r = await api('POST', '/api/payroll', { month: S.month }); await load(); toast(`Payroll posted for ${r.posted} teams.`); }),
  rateAdd: d => { const c = S.cd; const rid = () => Math.random().toString(36).slice(2, 12);
    if (d.k === 'units') c.units.push({ id: `u${rid()}`, name: 'New unit', kind: 'other' });
    if (d.k === 'roomTypes') c.roomTypes.push({ id: `r${rid()}`, unit: (c.units.find(u => u.kind === 'hotel') || {}).id, name: 'New room type', rate: 0, count: 1, sleeps: 2 });
    if (d.k === 'menu') c.menu.push({ id: `m${rid()}`, unit: (c.units.find(u => !['hotel', 'pool'].includes(u.kind)) || {}).id, section: 'Menu', name: 'New item', price: 0 });
    schedule(); },
  rateDel: d => { S.cd[d.k].splice(+d.i, 1); schedule(); },
  rateCancel: () => { S.cd = null; schedule(); },
  rateSave: () => act(async () => { S.cat = await api('PUT', '/api/admin/catalog', S.cd); S.cd = null; }, 'Rates and menu saved. Guests see the changes now.'),
  saveSettings: () => act(async () => {
    const c = S.cat;
    await api('PUT', '/api/admin/settings', { resortName: val('cfgName', c.resortName), slogan: val('cfgSlogan', c.slogan), currency: val('cfgCur', c.currency), approvalLimit: toMinor(val('cfgLimit', S.limit / 100)), deskEmail: val('cfgDeskEmail', S.settings.deskEmail || ''), deskPhone: val('cfgDeskPhone', S.settings.deskPhone || ''), contactPhone: val('cfgPhone', c.contactPhone), contactEmail: val('cfgEmail', c.contactEmail), address: val('cfgAddr', c.address), cancelPolicy: val('cfgPolicy', c.cancelPolicy) });
    await reloadCat(); await load();
  }, 'Settings saved.'),
  addStaff: () => act(async () => {
    const r = await api('POST', '/api/admin/users', { email: val('uEmail', ''), name: val('uName', ''), role: val('uRole', 'manager'), phone: val('uPhone', '') });
    S.link = { who: val('uName', ''), url: r.url, emailed: r.emailed }; ['uEmail', 'uName', 'uPhone'].forEach(k => delete S.d[k]); await load();
  }),
  staffActive: d => act(async () => { await api('POST', `/api/admin/users/${d.id}/active`, { active: d.on === '1' }); await load(); }, 'Account updated.'),
  resetLink: d => act(async () => { const r = await api('POST', '/api/desk/reset-link', { userId: d.id }); S.link = { who: d.name, url: r.url }; }),
  forgot: () => act(async () => { await api('POST', '/api/auth/forgot', { email: val('aEmail', '') }); S.modal = { k: 'auth', mode: 'forgotSent' }; }),
  smsToggle: (d, el) => act(async () => { await api('POST', '/api/me/sms', { on: el.checked }); S.user.smsOn = el.checked; }, 'Your choice is saved.'),
  testMsg: d => act(async () => { await api('POST', '/api/admin/messages/test', { channel: d.c, to: val(d.c === 'email' ? 'tEmail' : 'tPhone', '') }); await load(); }, 'Test message sent. Check that it arrived.'),
  findCustomer: () => act(async () => { S.found = (await api('GET', `/api/desk/customers?email=${encodeURIComponent(val('fEmail', '').trim())}`)).customers; }),
  copyLink: async () => { try { await navigator.clipboard.writeText(S.link.url); toast('Link copied.'); } catch { toast('Select the link and copy it by hand.', true); } },
};
function signedIn(user) {
  S.user = user; S.modal = null; const after = S.after; S.after = null;
  if (user.role !== 'customer') { S.tab = user.role === 'ceo' ? 'report' : 'today'; history.replaceState(null, '', '/portal'); S.busy = false; refresh(); schedule(); return; }
  if (after) setTimeout(after, 0); else if (S.tab === 'privacy') S.tab = 'stay';
  refresh();
}
async function submit(body, pay, cleanup) {
  const staffDesk = isStaff();
  if (staffDesk) {
    const { id } = await api('POST', '/api/desk/requests', { ...body, guestName: val('gName', ''), guestPhone: val('gPhone', ''), smsOk: S.d.gSms === true });
    cleanup(); await load(); toast('Added to bookings and orders.'); return id;
  }
  const { id } = await api('POST', '/api/requests', { ...body, pay, guestName: S.user.name, guestPhone: S.user.phone });
  cleanup();
  if (pay === 'online') { await startPayment(id); return id; }
  S.tab = 'mine'; await load(); toast('Request sent. The front desk will confirm it.');
  return id;
}
async function startPayment(id) { const r = await api('POST', `/api/requests/${id}/pay`, {}); window.location.assign(r.url); }

/* ---------- small pieces ---------- */
function btn(a, labelText, attrs = '', cls = '') { return `<button type="button" class="btn ${cls}" data-a="${a}" ${attrs}${S.busy ? ' disabled' : ''}>${labelText}</button>`; }
function field(id, labelText, html) { return `<div class="field"><label for="${id}">${labelText}</label>${html}</div>`; }
function input(id, labelText, def, type = 'text', extra = '') { return field(id, labelText, `<input id="${id}" data-d="${id}" type="${type}" value="${esc(val(id, def ?? ''))}" ${extra}>`); }
function select(id, labelText, opts, def, rer) { const v = val(id, def); return field(id, labelText, `<select id="${id}" data-d="${id}"${rer ? ' data-rer="1"' : ''}>${opts.map(o => { const [a, b] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(a)}"${String(a) === String(v) ? ' selected' : ''}>${esc(b)}</option>`; }).join('')}</select>`); }
function monthPicker() { return `<div class="month"><button type="button" class="btn" data-a="month" data-n="-1" aria-label="Previous month">‹</button><b>${monthName(S.month)}</b><button type="button" class="btn" data-a="month" data-n="1" aria-label="Next month"${S.month >= today().slice(0, 7) ? ' disabled' : ''}>›</button></div>`; }
function payChoice(id, resortWord) {
  if (!S.cat.paystack || isStaff()) return '';
  const v = val(id, 'online'); const r = (value, title, sub) => `<label><input type="radio" name="${id}" data-d="${id}" data-rer="1" value="${value}"${v === value ? ' checked' : ''}><span>${title}<small>${sub}</small></span></label>`;
  return `<div class="choice" role="radiogroup" aria-label="How to pay">${r('online', 'Pay now', 'Mobile money or card, through Paystack')}${r('resort', resortWord, 'The front desk confirms first')}</div>`;
}
const STATUS = { awaiting_payment: ['Waiting for payment', 'warn'], pending: ['Waiting for the desk', 'warn'], confirmed: ['Confirmed', 'info'], preparing: ['Being prepared', 'info'], checked_in: ['In house', 'good'], checked_out: ['Checked out', ''], served: ['Served', ''], used: ['Used', ''], declined: ['Declined', 'bad'], cancelled: ['Cancelled', ''], expired: ['Time to pay ended', ''], payment_review: ['Payment needs review', 'bad'] };
const statusPill = r => { const s = STATUS[r.status] || [r.status, '']; return `<span class="pill ${s[1]}">${s[0]}</span>`; };
const refOf = r => `APJ-${String(r.id).slice(0, 6).toUpperCase()}`;
const smsConsent = () => `<label class="check"><input type="checkbox" id="gSms" data-check="gSms"${S.d.gSms ? ' checked' : ''}><span>The guest agreed to receive text messages about this booking</span></label>`;
const paidPill = r => (r.paid ? `<span class="pill good">Paid · ${esc(r.paid_method || '')}</span>` : '');
function describe(r) {
  if (r.type === 'stay') return { t: `${esc(r.room_name)} · ${esc(r.unit_name)}`, d: `${niceDate(r.check_in)} to ${niceDate(r.check_out)} · ${nightsLabel(nightsBetween(r.check_in, r.check_out))} · ${esc(r.guests)} ${r.guests === 1 ? 'guest' : 'guests'}` };
  if (r.type === 'pool') return { t: `Pool pass · ${niceDate(r.pool_date)}`, d: `${esc(r.adults)} adults, ${esc(r.kids)} children` };
  return { t: `Order · ${esc(r.unit_name)}`, d: `${(r.lines || []).map(l => `${esc(l.qty)} × ${esc(l.name)}`).join(', ')} · to ${esc(r.deliver_to)}` };
}
function reqActions(r) {
  const k = `data-id="${esc(r.id)}"`; const mv = (to, l, c) => btn('move', l, `${k} data-to="${to}"`, c); const o = [];
  const canCancelPaid = !r.paid || isCeo();
  if (r.status === 'pending') o.push(mv(r.type === 'order' ? 'preparing' : 'confirmed', r.type === 'order' ? 'Accept' : 'Confirm', 'primary'), mv('declined', 'Decline', 'danger'));
  if (r.status === 'payment_review') o.push(mv(r.type === 'order' ? 'preparing' : 'confirmed', 'Honour booking', 'primary'), mv('cancelled', 'Cancel and record refund', 'danger'));
  if (r.status === 'confirmed' && r.type === 'stay') { o.push(mv('checked_in', 'Check in', 'primary')); if (canCancelPaid) o.push(mv('cancelled', r.paid ? 'Cancel and record refund' : 'Cancel', 'danger')); }
  if (r.status === 'confirmed' && r.type === 'pool') { o.push(mv('used', 'Mark used', 'primary')); if (canCancelPaid) o.push(mv('cancelled', r.paid ? 'Cancel and record refund' : 'Cancel', 'danger')); }
  if (r.status === 'checked_in') o.push(mv('checked_out', 'Check out'));
  if (r.status === 'preparing') { o.push(mv('served', 'Mark served')); if (canCancelPaid) o.push(mv('cancelled', r.paid ? 'Cancel and record refund' : 'Cancel', 'danger')); }
  if (!r.paid && ['confirmed', 'preparing', 'checked_in', 'served', 'checked_out', 'used'].includes(r.status)) o.push(btn('payOpen', 'Take payment', k, 'primary'));
  return o.join('');
}
function reqRow(r, desk) {
  const de = describe(r); const k = `data-id="${esc(r.id)}"`;
  let acts = '';
  if (desk) acts = reqActions(r);
  else {
    if (r.status === 'awaiting_payment') acts += btn('payNow', 'Pay now', k, 'primary');
    if (['pending', 'awaiting_payment'].includes(r.status) && !r.paid) acts += btn('cancelMine', 'Cancel', k, 'danger');
  }
  const hold = r.status === 'awaiting_payment' && r.hold_expires ? `<span class="muted">Held until ${new Date(r.hold_expires).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</span>` : '';
  return `<div class="req"><div><div class="title">${de.t}</div><div class="small muted">${de.d}</div><div class="row small" style="margin-top:4px">${statusPill(r)}${paidPill(r)}<span class="num">${money(r.total)}</span><span class="muted">Ref ${refOf(r)}</span>${hold}${desk ? `<span class="muted">${esc(r.guest_name)} · ${esc(r.guest_phone)}</span>` : ''}</div></div><div class="acts">${acts}</div></div>`;
}

/* ---------- customer pages ---------- */
function stayTab() {
  const hotels = S.cat.units.filter(u => u.kind === 'hotel'); const hotel = val('hotel', (hotels[0] || {}).id);
  const ci = val('checkIn', addDays(today(), 1)); const co = val('checkOut', addDays(today(), 2)); const n = co > ci ? nightsBetween(ci, co) : 0;
  const types = S.cat.roomTypes.filter(t => t.unit === hotel);
  if (!S.cat.roomTypes.length) return `<div class="panel"><div class="blank">Room booking opens soon.${S.cat.contactPhone ? ` To book now, call ${esc(S.cat.contactPhone)}.` : ''}</div></div>`;
  const form = `<div class="panel"><div class="form">${select('hotel', 'Hotel', hotels.map(u => [u.id, u.name]), hotel, true)}${input('checkIn', 'Check-in', ci, 'date', `data-rer="1" data-avail="1" min="${today()}"`)}${input('checkOut', 'Check-out', co, 'date', `data-rer="1" data-avail="1" min="${today()}"`)}${input('guests', 'Guests', 2, 'number', 'min="1"')}</div></div>`;
  const rooms = n <= 0 ? '<div class="panel"><div class="blank">Check-out must be after check-in.</div></div>' : `<div class="panel" style="gap:8px"><h3>Rooms at ${esc(unitName(hotel))} for ${nightsLabel(n)}</h3>${types.map(t => { const free = S.avail.rooms[t.id] ?? 0; const on = S.d.roomType === t.id; return `<div class="room ${free < 1 ? 'off' : on ? 'on' : ''}"${free < 1 ? '' : ` data-a="pickRoom" data-id="${esc(t.id)}" role="button" tabindex="0" aria-pressed="${on}"`}><div><b>${esc(t.name)}</b><div class="small muted">Sleeps ${esc(t.sleeps)} · ${free < 1 ? 'Full on these dates' : `${free} free`}</div></div><div class="num"><b>${whole(t.rate * n)}</b><div class="small muted">${whole(t.rate)} a night</div></div></div>`; }).join('') || '<p class="muted">No rooms are listed for this hotel yet.</p>'}</div>`;
  const sel = S.cat.roomTypes.find(t => t.id === S.d.roomType);
  const pay = val('stayPay', S.cat.paystack ? 'online' : 'resort');
  const desk = isStaff() ? `<div class="form">${input('gName', 'Guest name')}${input('gPhone', 'Phone number', '', 'tel')}</div>${smsConsent()}` : '';
  const book = sel && n > 0 ? `<div class="panel"><h3>${esc(sel.name)}, ${whole(sel.rate * n)}</h3>${desk}${payChoice('stayPay', 'Pay at the resort')}${S.cat.cancelPolicy && !isStaff() ? `<p class="small muted">${esc(S.cat.cancelPolicy)}</p>` : ''}<div>${btn('bookStay', isStaff() ? 'Add booking' : pay === 'online' ? 'Continue to payment' : 'Send booking request', '', 'primary')}</div>${!S.user ? '<p class="small muted">You will be asked to sign in or create an account first.</p>' : ''}${pay === 'online' && !isStaff() ? '<p class="small muted">We hold the room for 30 minutes while you pay.</p>' : ''}</div>` : '';
  return form + rooms + book;
}
function foodTab() {
  const sellers = S.cat.units.filter(u => S.cat.menu.some(m => m.unit === u.id)); const out = val('outlet', (sellers[0] || {}).id);
  if (!sellers.length) return '<div class="panel"><div class="blank">The menu will appear here soon.</div></div>';
  const items = S.cat.menu.filter(m => m.unit === out); const secs = [...new Set(items.map(m => m.section))];
  const ids = Object.keys(S.cart); const total = ids.reduce((s, id) => { const m = S.cat.menu.find(x => x.id === id); return s + (m ? m.price * S.cart[id] : 0); }, 0);
  const seg = `<div class="row">${sellers.map(u => `<button type="button" class="btn ${u.id === out ? 'primary' : ''}" data-a="outlet" data-id="${esc(u.id)}">${esc(u.name)}</button>`).join('')}</div>`;
  const list = secs.map(s => `<div><h3 style="margin-bottom:4px">${esc(s)}</h3>${items.filter(m => m.section === s).map(m => `<div class="menu-item"><span>${esc(m.name)}</span><span class="num">${money(m.price)}</span><span class="qty"><button type="button" data-a="qty" data-id="${esc(m.id)}" data-n="-1" aria-label="Remove one ${esc(m.name)}">−</button><b>${S.cart[m.id] || 0}</b><button type="button" data-a="qty" data-id="${esc(m.id)}" data-n="1" aria-label="Add one ${esc(m.name)}">+</button></span></div>`).join('')}</div>`).join('');
  const places = new Set(ids.map(id => (S.cat.menu.find(x => x.id === id) || {}).unit));
  const side = `<div class="panel"><h3>Your order</h3>${ids.length ? `<div class="small">${ids.map(id => { const m = S.cat.menu.find(x => x.id === id); return m ? `<div class="row between"><span>${S.cart[id]} × ${esc(m.name)}</span><span class="num">${money(m.price * S.cart[id])}</span></div>` : ''; }).join('')}</div><div class="row between"><b>Total</b><b class="num">${money(total)}</b></div>${input('deliverTo', 'Bring it to', '', 'text', 'placeholder="Room 12, poolside, table 4…"')}${isStaff() ? input('gName', 'Guest name') + input('gPhone', 'Phone number', '', 'tel') + smsConsent() : ''}${places.size === 1 ? payChoice('foodPay', 'Pay on delivery') : ''}<div>${btn('bookOrder', isStaff() ? 'Add order' : val('foodPay', S.cat.paystack && places.size === 1 ? 'online' : 'resort') === 'online' && places.size === 1 ? 'Continue to payment' : 'Send order', '', 'primary')}</div>` : '<p class="small muted">Add items from any bar or the restaurant.</p>'}</div>`;
  return `<div class="cols wide-first"><div class="panel">${seg}${list}</div>${side}</div>`;
}
function poolTab() {
  const p = S.cat.pool; if (!(p.adult > 0)) return '<div class="panel"><div class="blank">Pool passes will be on sale here soon.</div></div>';
  const a = +val('poolAdults', 2) || 0; const k = +val('poolKids', 0) || 0; const d = val('poolDate', today());
  const pay = val('poolPay', S.cat.paystack ? 'online' : 'resort');
  return `<div class="panel"><div class="form">${input('poolDate', 'Date', d, 'date', `data-rer="1" data-avail="1" min="${today()}"`)}${input('poolAdults', `Adults (${whole(p.adult)} each)`, a, 'number', 'min="0" data-rer="1"')}${input('poolKids', `Children (${whole(p.child)} each)`, k, 'number', 'min="0" data-rer="1"')}</div>${S.avail.poolLeft != null ? `<p class="small muted">${S.avail.poolLeft} places left on ${niceDate(d)}</p>` : ''}</div><div class="panel"><h3>Day pass total: ${money(a * p.adult + k * p.child)}</h3>${isStaff() ? `<div class="form">${input('gName', 'Guest name')}${input('gPhone', 'Phone number', '', 'tel')}</div>${smsConsent()}` : ''}${payChoice('poolPay', 'Pay at the pool')}<div>${btn('bookPool', isStaff() ? 'Add pool pass' : pay === 'online' ? 'Continue to payment' : 'Request pool passes', '', 'primary')}</div></div>`;
}
function mineTab() { return `<div class="panel">${S.mine.length ? `<div>${S.mine.map(r => reqRow(r, false)).join('')}</div>` : '<div class="blank">You have no bookings yet. Book a room, order food or get a pool pass and it will appear here with its status.</div>'}</div>`; }
function accountTab() {
  const u = S.user;
  return `<div class="panel"><h3>${esc(u.name)}</h3><p class="small muted">${esc(u.email)}${u.phone ? ` · ${esc(u.phone)}` : ''}</p><div>${btn('logout', 'Sign out')}</div></div>${u.role === 'customer' ? `<div class="panel"><h3>Booking updates</h3><p class="small muted">We email you about your bookings, such as confirmations and receipts. We never use these messages for advertising.</p><label class="check"><input type="checkbox" id="smsOn" data-a="smsToggle"${u.smsOn ? ' checked' : ''}><span>Also send me text messages about my bookings</span></label></div>` : ''}<div class="panel"><h3>Change password</h3><div class="form">${input('pwOld', 'Current password', '', 'password', 'autocomplete="current-password"')}${input('pwNew', 'New password (10+ characters)', '', 'password', 'autocomplete="new-password"')}<div class="field">${btn('changePw', 'Change password', '', 'primary')}</div></div></div>`;
}
function privacyTab() {
  const c = S.cat; const contact = [c.contactPhone, c.contactEmail, c.address].filter(Boolean).map(esc).join(' · ');
  return `<div class="panel prose"><h2>Privacy notice</h2><p>${esc(c.resortName)} collects your name, email address and phone number to create your account, and the details of your bookings and orders to provide those services and keep accounts.</p><p>Payments are handled by Paystack. Your card and mobile money details go to Paystack, and this website does not see or store them.</p><p>We use your email address and phone number to send messages about your bookings, such as confirmations, receipts and reminders. These go through our email and text message providers. You can turn text messages off under My account. We do not use these messages for advertising.</p><p>Only resort staff who need your details can see them. We do not sell your information.</p><p>To see, correct or remove your information, contact the resort${contact ? `: ${contact}` : ' at the front desk'}.</p></div>`;
}
function payReturn() {
  const r = S.payResult;
  const msg = !r ? ['Checking your payment…', 'This takes a few seconds. Please keep this page open.', ''] :
    r.state === 'success' ? ['Payment received. Thank you!', 'Your booking is confirmed. See you soon at APIJOS RESORT.', 'good'] :
    r.state === 'conflict' || r.state === 'review' ? ['Payment received, and the desk needs to check it', 'A member of staff will contact you shortly. Your money is safe and on record.', 'warn'] :
    r.state === 'error' ? ['We could not check your payment yet', 'If money left your account, don\'t pay again. It will show in My bookings once confirmed.', 'warn'] :
    ['Payment not completed', 'No money was taken. You can try again from My bookings while the room is still held.', 'bad'];
  return `<div class="panel" style="max-width:620px"><h2 class="${msg[2]}">${msg[0]}</h2><p class="muted">${msg[1]}</p>${r ? `<div>${btn('tab', 'Go to My bookings', 'data-t="mine"', 'primary')}</div>` : ''}</div>`;
}
function resetTab() {
  return `<div class="panel" style="max-width:520px"><h2>Choose a new password</h2><div class="form">${input('pwNew', 'New password (10+ characters)', '', 'password', 'autocomplete="new-password"')}</div><div>${btn('doReset', 'Save password', '', 'primary')}</div></div>`;
}

/* ---------- staff pages ---------- */
function chart(nets, sel) {
  const vals = nets.map(n => n.net); const hi = Math.max(0, ...vals); const lo = Math.min(0, ...vals); const span = (hi - lo) || 1;
  const raw = span / 3 / 100; const pow = 10 ** Math.floor(Math.log10(raw || 1)); const nn = raw / pow; const step = (nn <= 1 ? 1 : nn <= 2 ? 2 : nn <= 5 ? 5 : 10) * pow * 100;
  const top = Math.ceil(hi / step) * step; const bot = Math.floor(lo / step) * step; const range = (top - bot) || 1; const y = v => ((top - v) / range * 100);
  let grid = ''; for (let v = bot; v <= top + 1; v += step) grid += `<div class="grid${v === 0 ? ' zero' : ''}" style="top:${y(v)}%"><span>${short(v)}</span></div>`;
  const bars = nets.map(({ m, net }) => `<button type="button" class="bar ${net < 0 ? 'neg' : 'pos'}" data-a="setMonth" data-m="${m}" aria-pressed="${m === sel}" title="${monthName(m)}: ${esc(money(net))}" aria-label="${monthName(m)}: ${esc(money(net))}"><i style="top:${y(Math.max(net, 0))}%;height:${Math.max(Math.abs(net) / range * 100, net ? 0.6 : 0)}%"></i></button>`).join('');
  return `<div class="chart">${grid}<div class="bars">${bars}</div></div><div class="xlab">${nets.map(({ m }) => `<span class="${m === sel ? 'on' : ''}">${monthName(m, { month: 'short' })}</span>`).join('')}</div>`;
}
function reportTab() {
  const R = S.report; if (!R || R.month !== S.month) return `<div class="panel"><div class="blank">Opening ${monthName(S.month)}…</div></div>`;
  const p = R.pnl; const diff = p.net - R.prevNet; const margin = p.income ? Math.round(p.net / p.income * 1000) / 10 : 0; const v = whole(Math.abs(p.net));
  const word = p.net > 0 ? (R.open ? `Profit so far: ${v}` : `Closed with a profit of ${v}`) : p.net < 0 ? (R.open ? `Loss so far: ${v}` : `Closed with a loss of ${v}`) : 'Broke even';
  const head = `<div class="head"><div class="verdict"><div class="eyebrow">${monthName(S.month)}${R.open ? ' · month still open' : ' · month-end report'}</div><h1 class="${p.net < 0 ? 'bad' : p.net > 0 ? 'good' : ''}">${R.count ? word : 'No records yet'}</h1>${R.count ? `<p class="muted">${diff === 0 ? 'Same as' : `${whole(Math.abs(diff))}${diff > 0 ? ' better than' : ' worse than'}`} ${monthName(shiftMonth(S.month, -1), { month: 'long' })}.${p.pendingN ? ` ${p.pendingN} expense${p.pendingN > 1 ? 's' : ''} worth ${whole(p.pending)} still await approval and are not counted.` : ''}</p>` : ''}</div><div class="row">${monthPicker()}${R.count ? `<a class="btn" href="/api/reports/month.csv?month=${S.month}" download>Download CSV</a>` : ''}</div></div>`;
  const chartPanel = `<div class="panel"><div class="row between"><h3>Net result, last 12 months</h3><span class="small muted">Select a bar to open that month. Values in ${esc(cur())}.</span></div>${chart(R.nets, S.month)}</div>`;
  if (!R.count) return `${head}<div class="panel"><div class="blank">Nothing is recorded for ${monthName(S.month)}. Takings and bills entered in the Cash book appear here straight away.</div></div>${chartPanel}`;
  const line = (l, val2, cl = '') => `<tr class="${cl}"><td>${esc(l)}</td><td class="num">${money(val2)}</td></tr>`;
  let st = '<table class="stmt"><tbody><tr class="sect"><td colspan="2">Revenue</td></tr>';
  INCOME_CATS.forEach(c => { if (p.inc[c]) st += line(c, p.inc[c]); });
  st += `${line('Total revenue', p.income, 'total')}<tr class="sect"><td colspan="2">Cost of sales</td></tr>${line('Food, drink and supplies', p.cogs)}${line('Gross profit', p.gross, 'total')}<tr class="sect"><td colspan="2">Running costs</td></tr>`;
  EXPENSE_CATS.forEach(c => { if (c !== 'Cost of sales' && p.exp[c]) st += line(c, p.exp[c]); });
  st += `${line(p.net < 0 ? 'Net loss' : 'Net profit', p.net, 'net')}</tbody></table>`;
  const rows = [...S.cat.units, { id: 'shared', name: 'Resort-wide costs' }].map(u => { const x = p.byUnit[u.id] || { income: 0, expense: 0, net: 0 }; if (u.id === 'shared' && !x.expense) return ''; const occ = R.occupancy[u.id]; return `<tr><td>${esc(u.name)}</td><td class="num">${whole(x.income)}</td><td class="num">${whole(x.expense)}</td><td class="num ${x.net < 0 ? 'bad' : 'good'}">${whole(x.net)}</td><td class="num">${occ == null ? '' : `${occ}%`}</td></tr>`; }).join('');
  return `${head}<div class="figs"><div class="fig"><span>Revenue</span><b>${whole(p.income)}</b></div><div class="fig"><span>Total costs</span><b>${whole(p.cogs + p.opex)}</b></div><div class="fig"><span>Gross profit</span><b>${whole(p.gross)}</b></div><div class="fig"><span>Net margin</span><b class="${p.net < 0 ? 'bad' : ''}">${margin}%</b></div></div>${chartPanel}<div class="panel"><h3>Each part of the resort</h3><div class="scroll"><table><thead><tr><th>Business unit</th><th class="num">Revenue</th><th class="num">Costs</th><th class="num">Net</th><th class="num">Occupancy</th></tr></thead><tbody>${rows}</tbody></table></div><p class="small muted">Resort-wide costs are shown on their own line and are not shared out, so each unit shows what it earns before them. Occupancy is room-nights sold divided by room-nights available.</p></div><div class="panel statement"><h3>Profit and loss statement</h3><div class="scroll">${st}</div></div>`;
}
function approvalsTab() {
  const list = S.pendingEntries;
  return `<div class="head"><div><h2>Approvals</h2><p>Large expenses count in the accounts only after you approve them.</p></div></div><div class="panel">${list.length ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Business unit</th><th>What for</th><th class="num">Amount</th><th>Decision</th></tr></thead><tbody>${list.map(e => `<tr><td>${niceDate(e.date)}</td><td>${esc(unitName(e.unit_id))}</td><td>${esc(e.cat)}${e.note ? `<div class="small muted">${esc(e.note)}</div>` : ''}</td><td class="num">${money(e.amt)}</td><td><div class="row">${btn('decide', 'Approve', `data-id="${esc(e.id)}" data-to="approved"`, 'primary')}${btn('decide', 'Reject', `data-id="${esc(e.id)}" data-to="rejected"`, 'danger')}</div></td></tr>`).join('')}</tbody></table></div>` : '<div class="blank">Nothing is waiting for your approval.</div>'}</div>`;
}
function bookTab() {
  const kind = val('eKind', 'income'); const cats = kind === 'income' ? INCOME_CATS : EXPENSE_CATS; const unit = val('eUnit', S.cat.units[0].id);
  const f = S.bookFilter; const E = f === 'all' ? S.entries : S.entries.filter(e => e.kind === f);
  const pills = { pending: '<span class="pill warn">Awaiting CEO</span>', void: '<span class="pill">Voided</span>', rejected: '<span class="pill bad">Rejected</span>' };
  const form = `<div class="panel"><h3>Record money in or out</h3><div class="form">${select('eKind', 'Type', [['income', 'Money in (sale)'], ['expense', 'Money out (bill)']], 'income', true)}${input('eDate', 'Date', today(), 'date', `max="${today()}"`)}${select('eUnit', 'Business unit', unitOpts(kind === 'expense'), unit, true)}${select('eCat', 'Category', cats, cats[0])}${input('eAmt', `Amount (${esc(cur())})`, '', 'number', 'min="0" step="0.01" inputmode="decimal"')}${select('eMethod', 'Paid by', METHODS, 'Cash')}${kind === 'income' && unitKind(unit) === 'hotel' ? input('eNights', 'Room-nights sold', '0', 'number', 'min="0"') : ''}${input('eNote', 'Note', '', 'text', 'placeholder="Receipt number, supplier…"')}<div class="field">${btn('addEntry', 'Save entry', '', 'primary')}</div></div>${kind === 'expense' && !isCeo() && S.limit ? `<p class="small muted">Expenses of ${whole(S.limit)} or more wait for CEO approval.</p>` : ''}</div>`;
  const seg = `<div class="seg" role="group" aria-label="Filter entries">${[['all', 'All'], ['income', 'Money in'], ['expense', 'Money out']].map(([v, l]) => `<button type="button" data-a="filter" data-k="bookFilter" data-v="${v}" aria-pressed="${f === v}">${l}</button>`).join('')}</div>`;
  const tbl = E.length ? `<div class="scroll"><table><thead><tr><th>Date</th><th>Business unit</th><th>Category</th><th>Note</th><th>Method</th><th class="num">Amount</th><th></th></tr></thead><tbody>${E.map(e => { const live = ['approved', 'pending'].includes(e.status); const canVoid = live && (isCeo() || !e.ref); return `<tr${live ? '' : ' class="muted"'}><td>${niceDate(e.date)}</td><td>${esc(unitName(e.unit_id))}</td><td>${esc(e.cat)}</td><td class="small">${esc(e.note || '')} ${pills[e.status] || ''}</td><td class="small">${esc(e.method || '')}</td><td class="num ${e.kind === 'income' ? 'good' : ''}">${e.kind === 'income' ? '+' : '−'}${money(e.amt)}</td><td>${canVoid ? btn('voidOpen', 'Void', `data-id="${esc(e.id)}"`) : ''}</td></tr>`; }).join('')}</tbody></table></div>` : `<div class="blank">No entries for ${monthName(S.month)} yet. Use the form above to record the first one.</div>`;
  return `<div class="head"><div><h2>Cash book</h2><p>Every sale, bill and payment. Entries are voided instead of deleted, so the record stays complete.</p></div>${monthPicker()}</div>${form}<div class="panel"><div class="row between"><h3>${monthName(S.month)}</h3>${seg}</div>${tbl}</div>`;
}
function issuesPanel() {
  if (!S.issues.length) return '';
  return `<div class="panel"><h3 class="bad">Payments to check</h3>${S.issues.map(i => `<div class="req"><div><div class="title">${esc(i.guest_name)} · ${esc(i.guest_phone)}</div><div class="small muted">${esc(i.reason || 'Needs review')} Reference ${esc(i.reference)} · ${money(i.amount)}</div></div><div class="acts">${btn('resolveOpen', 'Mark as sorted', `data-ref="${esc(i.reference)}"`)}</div></div>`).join('')}</div>`;
}
function todayTab() {
  const R = S.reqs; const t = today(); const wait = R.filter(r => ['pending', 'payment_review'].includes(r.status));
  const arr = R.filter(r => r.type === 'stay' && r.status === 'confirmed' && r.check_in <= t); const dep = R.filter(r => r.status === 'checked_in' && r.check_out <= t); const inh = R.filter(r => r.status === 'checked_in');
  const kit = R.filter(r => r.status === 'preparing'); const low = S.stock.filter(i => i.qty <= i.reorder);
  const tile = (n, l) => `<div class="tile"><b>${n}</b><span>${l}</span></div>`;
  const list = (title, rows, empty) => `<div class="panel"><h3>${title}</h3>${rows.length ? `<div>${rows.map(r => reqRow(r, true)).join('')}</div>` : `<p class="small muted">${empty}</p>`}</div>`;
  return `<div class="head"><div><h2>${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' })}</h2><p>What needs someone from the desk today. This page updates by itself.</p></div></div><div class="tiles">${tile(wait.length, 'Requests waiting')}${tile(arr.length, 'Arriving')}${tile(dep.length, 'Leaving')}${tile(inh.length, 'Rooms in house')}${tile(low.length, 'Items low on stock')}</div>${issuesPanel()}${list('Requests waiting for a decision', wait, 'All requests have been answered.')}<div class="cols">${list('Arrivals', arr, 'No more arrivals due today.')}${list('Departures', dep, 'No departures due today.')}</div>${kit.length ? list('Orders in progress', kit, '') : ''}${low.length ? `<div class="panel"><h3>Low on stock</h3><div class="row">${low.map(i => `<span class="pill warn">${esc(i.name)}: ${esc(i.qty)} ${esc(i.uom)}</span>`).join('')}</div></div>` : ''}`;
}
function requestsTab() {
  const f = S.reqFilter; let R = S.reqs;
  const closedOut = r => ['declined', 'cancelled', 'expired'].includes(r.status) || (['checked_out', 'served', 'used'].includes(r.status) && r.paid);
  if (f === 'open') R = R.filter(r => !closedOut(r)); else if (f !== 'all') R = R.filter(r => r.type === f);
  const seg = `<div class="seg" role="group" aria-label="Filter">${[['open', 'Open'], ['stay', 'Rooms'], ['order', 'Orders'], ['pool', 'Pool'], ['all', 'All']].map(([v, l]) => `<button type="button" data-a="filter" data-k="reqFilter" data-v="${v}" aria-pressed="${f === v}">${l}</button>`).join('')}</div>`;
  return `<div class="head"><div><h2>Bookings and orders</h2><p>Confirming a room checks availability first. Taking a payment posts it to the cash book.</p></div>${seg}</div>${issuesPanel()}<div class="panel">${R.length ? `<div>${R.map(r => reqRow(r, true)).join('')}</div>` : '<div class="blank">Nothing here yet. Guest requests appear as soon as they are sent.</div>'}</div>`;
}
function walkinTab() {
  const s = S.sub; const seg = `<div class="seg" role="group" aria-label="Type">${[['stay', 'Room'], ['food', 'Food and drinks'], ['pool', 'Pool']].map(([v, l]) => `<button type="button" data-a="sub" data-s="${v}" aria-pressed="${s === v}">${l}</button>`).join('')}</div>`;
  return `<div class="head"><div><h2>New walk-in</h2><p>Book for someone at the desk or on the phone. It joins the same queue as online requests.</p></div>${seg}</div>${s === 'stay' ? stayTab() : s === 'food' ? foodTab() : poolTab()}`;
}
function stockTab() {
  const items = [...S.stock].sort((a, b) => (a.qty / (a.reorder || 1)) - (b.qty / (b.reorder || 1)));
  return `<div class="head"><div><h2>Stock</h2><p>Recording a delivery adds it to stock and posts its cost to the cash book.</p></div>${btn('modalStock', 'Add item', 'data-m="stockEdit"', 'primary')}</div><div class="panel">${items.length ? `<div class="scroll"><table><thead><tr><th>Item</th><th>Business unit</th><th class="num">In stock</th><th class="num">Reorder at</th><th>State</th><th></th></tr></thead><tbody>${items.map(i => { const k = `data-id="${esc(i.id)}"`; return `<tr><td>${esc(i.name)}</td><td>${esc(unitName(i.unit_id))}</td><td class="num">${esc(i.qty)} ${esc(i.uom)}</td><td class="num">${esc(i.reorder)}</td><td>${i.qty <= i.reorder ? '<span class="pill warn">Reorder</span>' : '<span class="pill good">OK</span>'}</td><td><div class="row">${btn('modalStock', 'Delivery', `${k} data-m="stockIn"`)}${btn('modalStock', 'Used', `${k} data-m="stockOut"`)}${btn('modalStock', 'Edit', `${k} data-m="stockEdit"`)}</div></td></tr>`; }).join('')}</tbody></table></div>` : '<div class="blank">No stock items yet. Add the first item to start tracking it.</div>'}</div>`;
}
function teamTab() {
  const T = S.teams; const billT = T.reduce((s, t) => s + t.pay * t.people, 0); const postedN = T.filter(t => S.posted.includes(`payroll-${S.month}-${t.id}`)).length;
  return `<div class="head"><div><h2>Staff and payroll</h2><p>Posting payroll adds each team's pay to its business unit. A team is never posted twice in one month.</p></div>${btn('modalTeam', 'Add team or person', '', 'primary')}</div><div class="panel"><div class="row between"><div><h3>Monthly pay bill: ${whole(billT)}</h3><p class="small muted">${monthName(S.month)}: ${postedN} of ${T.length} posted</p></div><div class="row">${monthPicker()}${btn('payroll', 'Post payroll', postedN === T.length ? 'disabled' : '', 'primary')}</div></div></div><div class="panel">${T.length ? `<div class="scroll"><table><thead><tr><th>Team or person</th><th>Business unit</th><th class="num">People</th><th class="num">Pay each</th><th class="num">Monthly</th><th></th></tr></thead><tbody>${T.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(unitName(t.unit_id))}</td><td class="num">${esc(t.people)}</td><td class="num">${money(t.pay)}</td><td class="num">${money(t.pay * t.people)}</td><td>${btn('modalTeam', 'Edit', `data-id="${esc(t.id)}"`)}</td></tr>`).join('')}</tbody></table></div>` : '<div class="blank">No staff added yet. Add a team or person to build the pay bill.</div>'}</div>`;
}
function ratesTab() {
  if (!S.cd) S.cd = clone({ units: S.cat.units, roomTypes: S.cat.roomTypes, menu: S.cat.menu, pool: S.cat.pool });
  const c = S.cd;
  const t = (p, v, kind, w) => `<input id="cd-${p}" aria-label="${p}" data-cd="${p}"${kind === 'money' ? ` data-money="1" type="number" step="0.01" min="0" value="${(v || 0) / 100}"` : kind === 'n' ? ` data-n="1" type="number" min="0" value="${esc(v)}"` : ` value="${esc(v)}"`}${w ? ` style="min-width:${w}px"` : ''}>`;
  const u = (p, v, list) => `<select id="cd-${p}" aria-label="${p}" data-cd="${p}">${list.map(([a, b]) => `<option value="${esc(a)}"${a === v ? ' selected' : ''}>${esc(b)}</option>`).join('')}</select>`;
  const hotels = c.units.filter(x => x.kind === 'hotel').map(x => [x.id, x.name]); const selling = c.units.filter(x => !['hotel', 'pool'].includes(x.kind)).map(x => [x.id, x.name]);
  const del = (k, i) => btn('rateDel', 'Remove', `data-k="${k}" data-i="${i}"`, 'danger');
  return `<div class="head"><div><h2>Rates and menu</h2><p>Name your hotels, bars and other units, then set what guests pay. Add units here as the resort grows, such as a spa or event hall.</p></div><div class="row">${btn('rateCancel', 'Discard changes')}${btn('rateSave', 'Save changes', '', 'primary')}</div></div>
  <div class="panel"><div class="row between"><h3>Business units</h3>${btn('rateAdd', 'Add unit', 'data-k="units"')}</div><div class="scroll"><table><thead><tr><th>Name</th><th>Kind</th></tr></thead><tbody>${c.units.map((x, i) => `<tr><td>${t(`units.${i}.name`, x.name, '', 180)}</td><td>${u(`units.${i}.kind`, x.kind, [['hotel', 'Hotel'], ['bar', 'Bar'], ['restaurant', 'Restaurant'], ['pool', 'Pool'], ['other', 'Other']])}</td></tr>`).join('')}</tbody></table></div></div>
  <div class="panel"><div class="row between"><h3>Rooms</h3>${btn('rateAdd', 'Add room type', 'data-k="roomTypes"')}</div>${c.roomTypes.length ? `<div class="scroll"><table><thead><tr><th>Hotel</th><th>Room type</th><th>Rate per night</th><th>Rooms</th><th>Sleeps</th><th></th></tr></thead><tbody>${c.roomTypes.map((x, i) => `<tr><td>${u(`roomTypes.${i}.unit`, x.unit, hotels)}</td><td>${t(`roomTypes.${i}.name`, x.name, '', 150)}</td><td>${t(`roomTypes.${i}.rate`, x.rate, 'money')}</td><td>${t(`roomTypes.${i}.count`, x.count, 'n')}</td><td>${t(`roomTypes.${i}.sleeps`, x.sleeps, 'n')}</td><td>${del('roomTypes', i)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">Add your first room type so guests can book.</p>'}</div>
  <div class="panel"><h3>Swimming pool</h3><div class="form" style="max-width:560px"><div class="field"><label for="cd-pool.adult">Adult day pass</label>${t('pool.adult', c.pool.adult, 'money')}</div><div class="field"><label for="cd-pool.child">Child day pass</label>${t('pool.child', c.pool.child, 'money')}</div><div class="field"><label for="cd-pool.maxPerDay">Places per day (0 = no limit)</label>${t('pool.maxPerDay', c.pool.maxPerDay, 'n')}</div></div></div>
  <div class="panel"><div class="row between"><h3>Food and drinks</h3>${btn('rateAdd', 'Add item', 'data-k="menu"')}</div>${c.menu.length ? `<div class="scroll"><table><thead><tr><th>Sold at</th><th>Section</th><th>Item</th><th>Price</th><th></th></tr></thead><tbody>${c.menu.map((x, i) => `<tr><td>${u(`menu.${i}.unit`, x.unit, selling)}</td><td>${t(`menu.${i}.section`, x.section, '', 100)}</td><td>${t(`menu.${i}.name`, x.name, '', 160)}</td><td>${t(`menu.${i}.price`, x.price, 'money')}</td><td>${del('menu', i)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">Add your first menu item so guests can order.</p>'}</div>`;
}
function linkPanel() { if (!S.link) return ''; return `<div class="panel"><h3>One-time link for ${esc(S.link.who)}</h3><p class="small">${S.link.emailed ? 'We also emailed this link to them. ' : ''}If you send it yourself, send it privately, such as by WhatsApp. It lets them choose a password, works once, and ends in 24 hours.</p><div class="copybox">${esc(S.link.url)}</div><div>${btn('copyLink', 'Copy link')}</div></div>`; }
function messagesPanel() {
  const x = S.msgs; if (!x) return '';
  const pill = (on, l) => `<span class="pill ${on ? 'good' : 'warn'}">${l}: ${on ? 'on' : 'not set up'}</span>`;
  const st = { sent: 'good', failed: 'bad', pending: 'warn' };
  return `<div class="panel"><div class="row between"><h3>Email and text messages</h3><div class="row">${pill(x.email, 'Email')}${pill(x.sms, 'Text messages')}</div></div>${x.failed ? `<p class="small bad"><b>${x.failed} message${x.failed > 1 ? 's' : ''} failed in the last 7 days.</b> Check your provider balance and settings.</p>` : ''}<div class="form">${input('tEmail', 'Test email to', '', 'email')}<div class="field">${btn('testMsg', 'Send test email', 'data-c="email"')}</div>${input('tPhone', 'Test text message to', '', 'tel')}<div class="field">${btn('testMsg', 'Send test text', 'data-c="sms"')}</div></div>${x.rows.length ? `<div class="scroll"><table><thead><tr><th>When</th><th>Type</th><th>To</th><th>What</th><th>State</th></tr></thead><tbody>${x.rows.slice(0, 40).map(r => `<tr><td class="small">${esc(new Date(r.created_at).toLocaleString('en-GB'))}</td><td class="small">${r.channel === 'sms' ? 'Text' : 'Email'}</td><td class="small">${esc(r.recipient)}</td><td class="small">${esc(r.kind.replace(/_/g, ' '))}${r.last_error ? `<div class="muted">${esc(r.last_error)}</div>` : ''}</td><td><span class="pill ${st[r.status] || ''}">${esc(r.status)}</span></td></tr>`).join('')}</tbody></table></div>` : '<p class="small muted">Messages will be listed here as they go out.</p>'}</div>`;
}
function peopleTab() {
  const found = S.found ? (S.found.length ? S.found.map(c => `<div class="req"><div><div class="title">${esc(c.name)}</div><div class="small muted">${esc(c.email)} · ${esc(c.phone)}</div></div><div class="acts">${btn('resetLink', 'Create password link', `data-id="${esc(c.id)}" data-name="${esc(c.name)}"`)}</div></div>`).join('') : '<p class="small muted">No customer has that email address.</p>') : '';
  const help = `<div class="panel"><h3>Customer who forgot a password</h3><div class="form">${input('fEmail', 'Customer email')}<div class="field">${btn('findCustomer', 'Find customer')}</div></div>${found}</div>`;
  if (!isCeo()) return `<div class="head"><div><h2>Customer help</h2><p>Check who you are speaking to before creating a link.</p></div></div>${linkPanel()}${help}`;
  return `<div class="head"><div><h2>Accounts</h2><p>Who can sign in as staff, and a record of important actions.</p></div></div>${linkPanel()}<div class="panel"><h3>Staff accounts</h3><div class="scroll"><table><thead><tr><th>Name</th><th>Email</th><th>Role</th><th>State</th><th></th></tr></thead><tbody>${S.users.map(u => `<tr${u.active ? '' : ' class="muted"'}><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${u.role === 'ceo' ? 'CEO' : 'Manager'}</td><td>${u.active ? '<span class="pill good">Active</span>' : '<span class="pill">Switched off</span>'}</td><td><div class="row">${u.id === S.user.id ? '' : btn('resetLink', 'Password link', `data-id="${esc(u.id)}" data-name="${esc(u.name)}"`)}${u.id === S.user.id ? '' : btn('staffActive', u.active ? 'Switch off' : 'Switch on', `data-id="${esc(u.id)}" data-on="${u.active ? 0 : 1}"`, u.active ? 'danger' : '')}</div></td></tr>`).join('')}</tbody></table></div><h3>Add a staff member</h3><div class="form">${input('uName', 'Name')}${input('uEmail', 'Email', '', 'email')}${input('uPhone', 'Phone', '', 'tel')}${select('uRole', 'Role', [['manager', 'Manager'], ['ceo', 'CEO']], 'manager')}<div class="field">${btn('addStaff', 'Create account', '', 'primary')}</div></div></div>${help}${messagesPanel()}<div class="panel"><div class="row between"><h3>Backup</h3><a class="btn" href="/api/admin/backup" download>Download database backup</a></div><p class="small muted">Keep a copy somewhere safe at least once a week. It contains customer details and accounts, so treat it as confidential.</p></div><div class="panel"><h3>Recent activity</h3><div class="scroll"><table><thead><tr><th>When</th><th>Who</th><th>What</th></tr></thead><tbody>${S.audit.slice(0, 60).map(a => `<tr><td class="small">${esc(new Date(a.at).toLocaleString('en-GB'))}</td><td class="small">${esc(a.who || 'System')}</td><td class="small">${esc(a.action.replace(/_/g, ' '))}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">No activity yet.</td></tr>'}</tbody></table></div></div>`;
}
function settingsTab() {
  const c = S.cat;
  return `<div class="head"><div><h2>Resort settings</h2><p>These appear on the public website and across the portal.</p></div></div><div class="panel"><div class="form">${input('cfgName', 'Resort name', c.resortName)}${input('cfgSlogan', 'Slogan', c.slogan)}${input('cfgCur', 'Currency symbol', c.currency)}${input('cfgLimit', `Approval limit (${esc(c.currency)})`, S.limit / 100, 'number', 'min="0" step="1"')}${input('cfgPhone', 'Contact phone', c.contactPhone, 'tel')}${input('cfgEmail', 'Contact email', c.contactEmail, 'email')}${input('cfgAddr', 'Address', c.address)}${input('cfgDeskEmail', 'Email for new request alerts', S.settings.deskEmail || '', 'email')}${input('cfgDeskPhone', 'Phone for urgent payment alerts', S.settings.deskPhone || '', 'tel')}</div>${field('cfgPolicy', 'Cancellation and refund policy shown to guests', `<textarea id="cfgPolicy" data-d="cfgPolicy" rows="3">${esc(val('cfgPolicy', c.cancelPolicy))}</textarea>`)}<div>${btn('saveSettings', 'Save settings', '', 'primary')}</div><p class="small muted">Expenses a manager records at or above the approval limit wait for you. Set it to 0 to turn approvals off.</p></div>`;
}

/* ---------- dialogs ---------- */
function modal() {
  const m = S.modal; if (!m) return ''; let b = '';
  if (m.k === 'auth') {
    if (m.mode === 'login') b = `<h3>Sign in</h3><div class="form">${input('aEmail', 'Email', '', 'email', 'autocomplete="email"')}${input('aPass', 'Password', '', 'password', 'autocomplete="current-password"')}</div><div class="row">${btn('login', 'Sign in', '', 'primary')}${btn('close', 'Close')}</div><p class="small">New here? <button type="button" class="linkish" data-a="authMode" data-m="register">Create an account</button></p>${S.cat.selfReset ? '<p class="small"><button type="button" class="linkish" data-a="authMode" data-m="forgot">Forgot your password?</button></p>' : `<p class="small muted">Forgot your password? Call the front desk${S.cat.contactPhone ? ` on ${esc(S.cat.contactPhone)}` : ''} for a new link.</p>`}`;
    else if (m.mode === 'forgot') b = `<h3>Reset your password</h3><p class="small muted">Enter your account's email address and we'll send you a link to choose a new password.</p>${input('aEmail', 'Email', '', 'email', 'autocomplete="email"')}<div class="row">${btn('forgot', 'Send link', '', 'primary')}${btn('close', 'Close')}</div><p class="small"><button type="button" class="linkish" data-a="authMode" data-m="login">Back to sign in</button></p>`;
    else if (m.mode === 'forgotSent') b = `<h3>Check your email</h3><p class="small">If that address has an account, a link is on its way. It works once and ends in 1 hour. If it doesn't arrive, check your spam folder or call the front desk${S.cat.contactPhone ? ` on ${esc(S.cat.contactPhone)}` : ''}.</p><div>${btn('close', 'Close')}</div>`;
    else b = `<h3>Create your account</h3><div class="form">${input('aName', 'Full name', '', 'text', 'autocomplete="name"')}${input('aPhone', 'Phone number', '', 'tel', 'autocomplete="tel"')}${input('aEmail', 'Email', '', 'email', 'autocomplete="email"')}${input('aPass', 'Password (10+ characters)', '', 'password', 'autocomplete="new-password"')}</div><label class="check"><input type="checkbox" id="aConsent" data-check="aConsent"${S.d.aConsent ? ' checked' : ''}><span>I agree to the <button type="button" class="linkish" data-a="privacy">privacy notice</button>.</span></label><div class="row">${btn('register', 'Create account', '', 'primary')}${btn('close', 'Close')}</div><p class="small">Already have an account? <button type="button" class="linkish" data-a="authMode" data-m="login">Sign in</button></p>`;
  }
  if (m.k === 'pay') { const r = S.reqs.find(x => x.id === m.id); if (!r) return ''; b = `<h3>Take payment</h3><div><b class="num">${money(r.total)}</b><div class="small muted">${describe(r).t} · ${esc(r.guest_name)}</div></div>${select('payMethod', 'Paid by', METHODS, 'Cash')}<div class="row">${btn('payDo', 'Record payment', '', 'primary')}${btn('close', 'Close')}</div>`; }
  if (m.k === 'resolve') b = `<h3>Mark as sorted</h3>${input('resolveNote', 'What was done?', '', 'text', 'placeholder="Refunded on Paystack dashboard"')}<div class="row">${btn('resolveDo', 'Save', '', 'primary')}${btn('close', 'Close')}</div>`;
  if (m.k === 'void') b = `<h3>Void this entry?</h3><p class="small">It stays in the cash book, marked as voided, and stops counting in the accounts.</p><div class="row">${btn('voidDo', 'Void entry', '', 'danger')}${btn('close', 'Keep it')}</div>`;
  const it = S.stock.find(x => x.id === m.id) || {};
  if (m.k === 'stockIn') b = `<h3>Delivery: ${esc(it.name)}</h3><div class="form">${input('sQty', `Quantity (${esc(it.uom)})`, '', 'number', 'min="0"')}${input('sCost', `Total cost (${esc(cur())})`, '', 'number', 'min="0" step="0.01"')}${select('sMethod', 'Paid by', METHODS, 'Cash')}</div><div class="row">${btn('stockIn', 'Save delivery', '', 'primary')}${btn('close', 'Close')}</div>`;
  if (m.k === 'stockOut') b = `<h3>Used: ${esc(it.name)}</h3>${input('sQty', `Quantity used (${esc(it.uom)}). ${esc(it.qty)} in stock`, '', 'number', 'min="0"')}<div class="row">${btn('stockOut', 'Save', '', 'primary')}${btn('close', 'Close')}</div>`;
  if (m.k === 'stockEdit') b = `<h3>${m.id ? 'Edit item' : 'Add stock item'}</h3><div class="form">${input('sName', 'Item', it.name || '')}${select('sUnit', 'Business unit', unitOpts(), it.unit_id)}${input('sUom', 'Counted in', it.uom || 'bottles')}${input('sReorder', 'Reorder at', it.reorder || 0, 'number', 'min="0"')}${m.id ? '' : input('sQty', 'Quantity now', 0, 'number', 'min="0"')}</div><div class="row">${btn('stockSave', 'Save', '', 'primary')}${m.id ? btn('stockDel', 'Remove item', '', 'danger') : ''}${btn('close', 'Close')}</div>`;
  if (m.k === 'team') { const t = S.teams.find(x => x.id === m.id) || {}; b = `<h3>${m.id ? 'Edit' : 'Add team or person'}</h3><div class="form">${input('tName', 'Team or person', t.name || '')}${select('tUnit', 'Business unit', unitOpts(true), t.unit_id)}${input('tPeople', 'People', t.people || 1, 'number', 'min="1"')}${input('tPay', `Monthly pay each (${esc(cur())})`, t.pay ? t.pay / 100 : '', 'number', 'min="0" step="0.01"')}</div><div class="row">${btn('teamSave', 'Save', '', 'primary')}${m.id ? btn('teamDel', 'Remove', '', 'danger') : ''}${btn('close', 'Close')}</div>`; }
  return `<div class="overlay"><div class="dialog" role="dialog" aria-modal="true">${b}</div></div>`;
}

/* ---------- page assembly ---------- */
const PUB_HEAD = { stay: ['Book a room', "Choose your dates and we'll show what is free."], food: ['Food and drinks', 'Order from the restaurant or any bar, brought to your room or poolside.'], pool: ['Swimming pool', 'Get a day pass for you and your group.'], mine: ['My bookings', 'Follow what you have booked and ordered.'], account: ['My account', ''], privacy: ['', ''], payreturn: ['', ''], reset: ['', ''] };
function facilities() {
  const c = k => S.cat.units.filter(u => u.kind === k).length;
  const word = (n, s, p) => (n === 1 ? `1 ${s}` : `${n} ${p}`);
  const parts = [];
  if (c('hotel')) parts.push(word(c('hotel'), 'hotel', 'hotels'));
  if (c('bar')) parts.push(word(c('bar'), 'bar', 'bars'));
  if (c('restaurant')) parts.push(c('restaurant') === 1 ? 'a restaurant' : `${c('restaurant')} restaurants`);
  if (c('pool')) parts.push('a swimming pool');
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}` : parts.join('');
}
function publicPage() {
  const c = S.cat; const tab = S.tab; const h = PUB_HEAD[tab] || ['', ''];
  const body = { stay: stayTab, food: foodTab, pool: poolTab, mine: mineTab, account: accountTab, privacy: privacyTab, payreturn: payReturn, reset: resetTab }[tab]();
  const cartN = Object.values(S.cart).reduce((a, b) => a + b, 0);
  const tabs = nav().map(([k, l]) => `<button type="button" data-a="tab" data-t="${k}"${tab === k ? ' aria-current="page"' : ''}>${l}${k === 'food' && cartN ? `<span class="badge">${cartN}</span>` : ''}</button>`).join('');
  const contact = [c.contactPhone, c.contactEmail, c.address].filter(Boolean).map(x => `<span>${esc(x)}</span>`).join('');
  return `<section class="hero"><div class="hero-in"><div class="hero-top"><div class="wordmark">${esc(c.resortName)}</div>${S.user ? btn('tab', esc(S.user.name.split(' ')[0]), 'data-t="account"') : btn('signin', 'Sign in')}</div><div><h1>${esc(c.slogan)}</h1><p>${esc(c.resortName)} welcomes you with ${esc(facilities())}. Book your stay, order food and drinks, and get pool passes here.</p></div></div></section><svg class="wave" viewBox="0 0 1200 36" preserveAspectRatio="none" aria-hidden="true"><path fill="currentColor" d="M0 0h1200v12c-150 22-300 22-450 8S450-2 300 12 100 30 0 16z"/></svg><div class="shell pub"><nav class="pub-tabs" aria-label="Sections">${tabs}</nav><main class="main">${h[0] ? `<div class="head"><div><h2>${h[0]}</h2>${h[1] ? `<p>${h[1]}</p>` : ''}</div></div>` : ''}${body}</main><footer class="footer"><b>${esc(c.resortName)}</b>${contact}<button type="button" class="linkish" data-a="privacy">Privacy notice</button></footer></div>`;
}
function staffPage() {
  const body = { report: reportTab, approvals: approvalsTab, today: todayTab, requests: requestsTab, walkin: walkinTab, book: bookTab, stock: stockTab, team: teamTab, rates: ratesTab, people: peopleTab, settings: settingsTab, account: accountTab, privacy: privacyTab }[S.tab]();
  const navHtml = nav().map(([k, l]) => { let badge = ''; if (k === 'approvals' && S.pendingEntries.length) badge = `<span class="badge">${S.pendingEntries.length}</span>`; const wait = S.reqs.filter(r => ['pending', 'payment_review'].includes(r.status)).length; if (k === 'today' && wait) badge = `<span class="badge">${wait}</span>`; return `<button type="button" data-a="tab" data-t="${k}"${S.tab === k ? ' aria-current="page"' : ''}>${l}${badge}</button>`; }).join('');
  return `<div class="shell"><header class="top"><div class="brand">${esc(S.cat.resortName)}<small>${esc(S.cat.slogan)} · ${isCeo() ? 'CEO' : 'Manager'} portal</small></div><div class="row"><span class="small muted">${esc(S.user.name)}</span>${btn('logout', 'Sign out')}</div></header><div class="frame"><nav class="rail" aria-label="Sections">${navHtml}</nav><main class="main">${body}</main></div></div>`;
}
function html() {
  if (!S.ready) return S.err ? `<div class="shell"><div class="panel"><h2>We can't reach the website right now</h2><p class="muted">${esc(S.err)}</p></div></div>` : '<div class="shell"><div class="brand">APIJOS RESORT<small>Home Away From Home</small></div></div>';
  const page = isStaff() && !['reset'].includes(S.tab) ? staffPage() : publicPage();
  return page + modal() + (S.toast ? `<div class="toast ${S.toast.err ? 'err' : ''}" role="status">${esc(S.toast.msg)}</div>` : '');
}
const app = document.getElementById('app');
let queued = false;
function schedule() { if (queued) return; queued = true; setTimeout(() => { queued = false; render(); }, 0); }
function render() {
  const f = document.activeElement; const fid = f && f.id; const sel = f && ['text', 'email', 'tel', 'password', 'search'].includes(f.type) ? [f.selectionStart, f.selectionEnd] : null;
  app.innerHTML = html();
  if (S.cat) document.title = `${S.cat.resortName} | ${S.cat.slogan}`;
  if (fid) { const n = document.getElementById(fid); if (n) { n.focus(); if (sel) try { n.setSelectionRange(sel[0], sel[1]); } catch { /* not a text field */ } } }
}
function setPath(o, path, v) { const k = path.split('.'); let c = o; for (let i = 0; i < k.length - 1; i++) c = c[k[i]]; c[k[k.length - 1]] = v; }
app.addEventListener('click', ev => { const b = ev.target.closest('[data-a]'); if (!b || b.disabled) return; const fn = A[b.dataset.a]; if (fn) fn(b.dataset, b); });
app.addEventListener('keydown', ev => {
  if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.matches('.room[data-a]')) { ev.preventDefault(); ev.target.click(); }
  if (ev.key === 'Enter' && ev.target.closest('.dialog') && ev.target.tagName === 'INPUT' && ev.target.type !== 'checkbox') { const p = ev.target.closest('.dialog').querySelector('.btn.primary'); if (p) p.click(); }
});
function onField(ev) {
  const e = ev.target;
  if (e.dataset.check) { S.d[e.dataset.check] = e.checked; return; }
  if (e.dataset.d) { S.d[e.dataset.d] = e.value; if (e.dataset.rer && ev.type === 'change') { if (e.dataset.avail) refreshAvail().then(schedule).catch(() => {}); schedule(); } }
  if (e.dataset.cd && S.cd) { let v = e.value; if (e.dataset.money) v = toMinor(v) || 0; else if (e.dataset.n) v = +v || 0; setPath(S.cd, e.dataset.cd, v); }
}
app.addEventListener('input', onField); app.addEventListener('change', onField);

/* ---------- start ---------- */
async function start() {
  try {
    const [me, cat] = await Promise.all([api('GET', '/api/me'), api('GET', '/api/public/catalog')]);
    S.user = me.user; S.cat = cat;
  } catch (e) { S.err = e.message; schedule(); setTimeout(start, 8000); return; }
  S.ready = true;
  const p = window.location.pathname;
  if (p === '/reset' && window.location.hash.length > 1) { S.resetToken = window.location.hash.slice(1); history.replaceState(null, '', '/reset'); S.tab = 'reset'; schedule(); return; }
  if (p === '/privacy') { S.tab = 'privacy'; schedule(); return; }
  if (p === '/payment/return') {
    S.tab = 'payreturn'; schedule();
    const ref = new URLSearchParams(window.location.search).get('reference') || new URLSearchParams(window.location.search).get('trxref');
    if (!S.user || !ref) { S.payResult = { state: 'error' }; schedule(); return; }
    for (let i = 0; i < 5; i++) {
      try { const r = await api('GET', `/api/payments/${encodeURIComponent(ref)}/confirm`); S.payResult = r; if (r.state !== 'not_paid' || i === 4) break; } catch { S.payResult = { state: 'error' }; }
      await new Promise(res => setTimeout(res, 2500));
    }
    schedule(); return;
  }
  S.tab = isStaff() ? (isCeo() ? 'report' : 'today') : 'stay';
  if (isStaff() && p !== '/portal') history.replaceState(null, '', '/portal');
  schedule(); await refresh();
  setInterval(() => { if (document.visibilityState === 'visible' && ['today', 'requests'].includes(S.tab) && !S.modal) refresh(); }, 20000);
}
start();
