'use strict';
// Fills a private test copy with made-up records so you can try the site on your own computer.
// It refuses to run on the live website.
process.env.TZ = process.env.TZ || 'Africa/Accra';
const path = require('node:path');
const crypto = require('node:crypto');
const { openDb } = require('../server/db');
const { hashPassword, newId } = require('../server/auth');
const L = require('../server/logic');

if (process.env.NODE_ENV === 'production') { console.error('The demo data must never go on the live website.'); process.exit(1); }
(async () => {
  const db = openDb(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) { console.error('This database already has accounts. Delete the data folder first.'); process.exit(1); }
  const now = new Date().toISOString();
  const ins = (t, c, ...v) => db.prepare(`INSERT INTO ${t}(${c}) VALUES(${v.map(() => '?').join(',')})`).run(...v);
  const pass = crypto.randomBytes(9).toString('base64url');
  for (const [email, name, role] of [['ceo@demo.test', 'Demo CEO', 'ceo'], ['manager@demo.test', 'Demo Manager', 'manager'], ['guest@demo.test', 'Demo Guest', 'customer']]) {
    ins('users', 'id,email,name,phone,role,pw,created_at', newId(), email, name, '0240000000', role, await hashPassword(pass), now);
  }
  const names = { hotel1: 'Palm Court (demo)', hotel2: 'Lagoon Lodge (demo)', hotel3: 'Hilltop Suites (demo)', bar1: 'Poolside Bar (demo)', bar2: 'Sunset Bar (demo)', bar3: 'Garden Bar (demo)', restaurant: 'Main Restaurant (demo)' };
  Object.entries(names).forEach(([id, n]) => db.prepare('UPDATE units SET name=? WHERE id=?').run(n, id));
  [['r1', 'hotel1', 'Standard', 45000, 12, 2], ['r2', 'hotel1', 'Deluxe', 75000, 6, 2], ['r3', 'hotel2', 'Standard', 38000, 10, 2], ['r4', 'hotel2', 'Family room', 65000, 4, 4], ['r5', 'hotel3', 'Suite', 140000, 6, 2], ['r6', 'hotel3', 'Villa', 220000, 4, 5]]
    .forEach((r, i) => ins('room_types', 'id,unit_id,name,rate,count,sleeps,sort', ...r, i));
  [['restaurant', 'Mains', 'Jollof rice with grilled chicken', 9500], ['restaurant', 'Mains', 'Banku with grilled tilapia', 13000], ['restaurant', 'Starters', 'Kelewele with groundnuts', 4000], ['bar1', 'Drinks', 'Fresh coconut water', 2500], ['bar1', 'Drinks', 'Bottled lager', 3000], ['bar2', 'Cocktails', 'Sunset rum punch', 6500], ['bar3', 'Drinks', 'Palm wine', 2500]]
    .forEach((m, i) => ins('menu_items', 'id,unit_id,section,name,price,sort', `m${i}`, ...m, i));
  const put = db.prepare('UPDATE settings SET value=? WHERE key=?');
  put.run('6000', 'poolAdult'); put.run('3000', 'poolChild'); put.run('80', 'poolMax');
  put.run('0000 000 000 (demo)', 'contactPhone');
  [['t1', 'Palm Court team', 'hotel1', 12, 210000], ['t2', 'Kitchen and service', 'restaurant', 14, 195000], ['t3', 'Management', 'shared', 6, 520000]].forEach(t => ins('staff', 'id,name,unit_id,people,pay', ...t));
  [['s1', 'Bottled lager', 'bar1', 'crates', 6, 10], ['s2', 'Rice', 'restaurant', 'bags', 9, 4]].forEach(s => ins('stock', 'id,name,unit_id,uom,qty,reorder', ...s));
  const base = { hotel1: 9800000, hotel2: 6200000, hotel3: 12500000, bar1: 4600000, bar2: 3800000, bar3: 1900000, restaurant: 12800000, pool: 2100000 };
  const cats = { hotel1: 'Rooms', hotel2: 'Rooms', hotel3: 'Rooms', bar1: 'Drinks', bar2: 'Drinks', bar3: 'Drinks', restaurant: 'Food', pool: 'Pool tickets' };
  const season = [1, .95, 1, 1.05, .8, .55, .6, .9, .85, 1, 1, 1.4];
  const thisMonth = L.today().slice(0, 7);
  for (let i = 12; i >= 1; i--) {
    const m = L.shiftMonth(thisMonth, -i); const f = season[Number(m.slice(5)) - 1]; const last = `${m}-${L.pad(L.daysIn(m))}`;
    Object.entries(base).forEach(([u, b]) => {
      ins('ledger', 'id,date,kind,unit_id,cat,amt,method,status,note,by_label,nights,created_at', newId(), last, 'income', u, cats[u], Math.round(b * f), 'Cash', 'approved', 'Demo takings', 'Demo', cats[u] === 'Rooms' ? Math.round(b * f / 55000) : 0, now);
      ins('ledger', 'id,date,kind,unit_id,cat,amt,method,status,note,by_label,nights,created_at', newId(), last, 'expense', u, 'Cost of sales', Math.round(b * f * .3), 'Bank transfer', 'approved', 'Demo supplies', 'Demo', 0, now);
    });
    ins('ledger', 'id,date,kind,unit_id,cat,amt,method,status,note,by_label,nights,created_at', newId(), last, 'expense', 'shared', 'Payroll', 17000000, 'Bank transfer', 'approved', 'Demo payroll', 'Demo', 0, now);
    ins('ledger', 'id,date,kind,unit_id,cat,amt,method,status,note,by_label,nights,created_at', newId(), last, 'expense', 'shared', 'Utilities', 7500000, 'Bank transfer', 'approved', 'Demo utilities', 'Demo', 0, now);
  }
  console.log(`Demo ready. Sign in as ceo@demo.test, manager@demo.test or guest@demo.test with the password: ${pass}`);
  db.close();
})();
