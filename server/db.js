'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL, phone TEXT NOT NULL DEFAULT '', role TEXT NOT NULL CHECK(role IN('customer','manager','ceo')), pw TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS reset_tokens(token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS units(id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS room_types(id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id), name TEXT NOT NULL, rate INTEGER NOT NULL, count INTEGER NOT NULL, sleeps INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS menu_items(id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES units(id), section TEXT NOT NULL, name TEXT NOT NULL, price INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY, type TEXT NOT NULL, user_id TEXT REFERENCES users(id), source TEXT NOT NULL, guest_name TEXT NOT NULL, guest_phone TEXT NOT NULL, unit_id TEXT NOT NULL, room_type_id TEXT, room_name TEXT, check_in TEXT, check_out TEXT, guests INTEGER, pool_date TEXT, adults INTEGER, kids INTEGER, deliver_to TEXT, lines TEXT, total INTEGER NOT NULL, status TEXT NOT NULL, pay_choice TEXT NOT NULL, paid INTEGER NOT NULL DEFAULT 0, paid_method TEXT, hold_expires INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS requests_user ON requests(user_id);
CREATE INDEX IF NOT EXISTS requests_status ON requests(status);
CREATE TABLE IF NOT EXISTS payments(reference TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), amount INTEGER NOT NULL, currency TEXT NOT NULL, status TEXT NOT NULL, reason TEXT, channel TEXT, resolved_note TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, date TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('income','expense')), unit_id TEXT NOT NULL, cat TEXT NOT NULL, amt INTEGER NOT NULL CHECK(amt >= 0), method TEXT, status TEXT NOT NULL, note TEXT, by_user TEXT, by_label TEXT, nights INTEGER NOT NULL DEFAULT 0, ref TEXT UNIQUE, voided_by TEXT, decided_by TEXT, created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_date ON ledger(date);
CREATE TABLE IF NOT EXISTS stock(id TEXT PRIMARY KEY, name TEXT NOT NULL, unit_id TEXT NOT NULL, uom TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0, reorder REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS staff(id TEXT PRIMARY KEY, name TEXT NOT NULL, unit_id TEXT NOT NULL, people INTEGER NOT NULL DEFAULT 1, pay INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY, channel TEXT NOT NULL, recipient TEXT NOT NULL, subject TEXT, body TEXT NOT NULL DEFAULT '', html TEXT, kind TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_try INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_at TEXT NOT NULL, sent_at TEXT);
CREATE INDEX IF NOT EXISTS outbox_status ON outbox(status,next_try);
CREATE TABLE IF NOT EXISTS audit(id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, user_id TEXT, action TEXT NOT NULL, detail TEXT);
`;

const DEFAULT_UNITS = [
  ['hotel1', 'Hotel 1', 'hotel'], ['hotel2', 'Hotel 2', 'hotel'], ['hotel3', 'Hotel 3', 'hotel'],
  ['bar1', 'Bar 1', 'bar'], ['bar2', 'Bar 2', 'bar'], ['bar3', 'Bar 3', 'bar'],
  ['restaurant', 'Restaurant', 'restaurant'], ['pool', 'Swimming Pool', 'pool'],
];
const DEFAULT_SETTINGS = {
  resortName: 'APIJOS RESORT', slogan: 'Home Away From Home', currency: 'GH₵', approvalLimit: '500000',
  poolAdult: '0', poolChild: '0', poolMax: '0', contactPhone: '', contactEmail: '', address: '', cancelPolicy: '', deskEmail: '', deskPhone: '',
};

function openDb(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const file = path.join(dataDir, 'apijos.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec(SCHEMA);
  // Safe upgrades for a website that is already running: add new columns, never remove anything.
  const addColumn = (table, column, definition) => {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  };
  addColumn('users', 'sms_on', 'INTEGER NOT NULL DEFAULT 1');
  addColumn('requests', 'sms_ok', 'INTEGER NOT NULL DEFAULT 0');
  addColumn('requests', 'reminder_sent', 'INTEGER NOT NULL DEFAULT 0');
  db.file = file;
  db.tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
  };
  const setIfMissing = db.prepare('INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)');
  Object.entries(DEFAULT_SETTINGS).forEach(([k, v]) => setIfMissing.run(k, v));
  if (!db.prepare('SELECT 1 FROM units LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO units(id,name,kind,sort) VALUES(?,?,?,?)');
    DEFAULT_UNITS.forEach((u, i) => ins.run(u[0], u[1], u[2], i));
  }
  return db;
}
module.exports = { openDb };
