// db.js
const Database = require('better-sqlite3');
const db = new Database('cards.db');

// init tables
db.prepare(`
  CREATE TABLE IF NOT EXISTS cards (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER,
    pan TEXT,
    cvv TEXT,
    exp TEXT,
    balance REAL DEFAULT 0,
    status TEXT DEFAULT 'active', -- active|frozen
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`).run();

module.exports = db;
