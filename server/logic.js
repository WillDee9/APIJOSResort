'use strict';
// Pure rules for money and dates. No database or network here, so they are easy to test.
const INCOME_CATS = ['Rooms', 'Food', 'Drinks', 'Pool tickets', 'Events', 'Other income'];
const EXPENSE_CATS = ['Cost of sales', 'Payroll', 'Utilities', 'Maintenance', 'Marketing', 'Licences & insurance', 'Payment fees', 'Refunds', 'Other costs'];
const METHODS = ['Cash', 'Mobile money', 'Card', 'Bank transfer', 'Paystack'];

const pad = n => String(n).padStart(2, '0');
const today = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
const isMonth = s => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
const addDays = (s, n) => { const d = new Date(`${s}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 864e5);
const shiftMonth = (m, n) => { const [y, mo] = m.split('-').map(Number); const d = new Date(Date.UTC(y, mo - 1 + n, 1)); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`; };
const daysIn = m => { const [y, mo] = m.split('-').map(Number); return new Date(Date.UTC(y, mo, 0)).getUTCDate(); };

function buildPnl(entries, unitIds = []) {
  const r = { income: 0, cogs: 0, opex: 0, gross: 0, net: 0, inc: {}, exp: {}, byUnit: {}, pending: 0, pendingN: 0 };
  const blank = () => ({ income: 0, expense: 0, net: 0, nights: 0 });
  unitIds.forEach(id => { r.byUnit[id] = blank(); });
  for (const e of entries) {
    if (e.status === 'pending') { r.pending += e.amt; r.pendingN += 1; continue; }
    if (e.status !== 'approved') continue;
    const u = r.byUnit[e.unit_id] || (r.byUnit[e.unit_id] = blank());
    if (e.kind === 'income') {
      r.income += e.amt; u.income += e.amt; u.nights += e.nights || 0;
      r.inc[e.cat] = (r.inc[e.cat] || 0) + e.amt;
    } else {
      u.expense += e.amt;
      r.exp[e.cat] = (r.exp[e.cat] || 0) + e.amt;
      if (e.cat === 'Cost of sales') r.cogs += e.amt; else r.opex += e.amt;
    }
  }
  Object.values(r.byUnit).forEach(u => { u.net = u.income - u.expense; });
  r.gross = r.income - r.cogs;
  r.net = r.gross - r.opex;
  return r;
}

// Who may move a request from one status to the next.
const MOVES = {
  stay: { pending: ['confirmed', 'declined'], confirmed: ['checked_in', 'cancelled'], checked_in: ['checked_out'], payment_review: ['confirmed', 'cancelled'] },
  order: { pending: ['preparing', 'declined'], preparing: ['served', 'cancelled'], payment_review: ['preparing', 'cancelled'] },
  pool: { pending: ['confirmed', 'declined'], confirmed: ['used', 'cancelled'], payment_review: ['confirmed', 'cancelled'] },
};
const canMove = (type, from, to) => ((MOVES[type] || {})[from] || []).includes(to);
const incomeCat = (type, unitKind) => (type === 'stay' ? 'Rooms' : type === 'pool' ? 'Pool tickets' : unitKind === 'bar' ? 'Drinks' : 'Food');

module.exports = { INCOME_CATS, EXPENSE_CATS, METHODS, pad, today, isDate, isMonth, addDays, nightsBetween, shiftMonth, daysIn, buildPnl, canMove, incomeCat };
