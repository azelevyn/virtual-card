// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const TelegramBot = require('node-telegram-bot-api');
const db = require('./db');
const { createTransaction } = require('./helpers/coinpayments');
const axios = require('axios');

const PORT = process.env.PORT || 3000;
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
if (!TELEGRAM_TOKEN) {
  console.error('Set TELEGRAM_TOKEN in .env');
  process.exit(1);
}

// Use webhook mode:
const bot = new TelegramBot(TELEGRAM_TOKEN);
const WEBHOOK_URL = process.env.WEBHOOK_URL; // e.g. https://yourapp.sevalla.app/telegram-webhook
if (!WEBHOOK_URL) {
  console.warn('WEBHOOK_URL not set. Bot will attempt polling fallback.');
  bot.startPolling();
} else {
  const secretPath = `/telegram-webhook/${TELEGRAM_TOKEN}`;
  bot.setWebHook(`${WEBHOOK_URL}/telegram-webhook/${TELEGRAM_TOKEN}`).catch(console.error);
  app.post(`/telegram-webhook/${TELEGRAM_TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// helper: generate pseudo card (NOT real card for payments)
function genCard() {
  // simple random PAN 16 digits
  const pan = Array.from({length:16},()=>Math.floor(Math.random()*10)).join('');
  const cvv = ('00' + Math.floor(Math.random()*1000)).slice(-3);
  const exp = `${('0'+(Math.floor(Math.random()*12)+1)).slice(-2)}/${(new Date().getFullYear()+2).toString().slice(-2)}`;
  return { pan, cvv, exp };
}

// Telegram command handlers
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const name = msg.from.first_name || 'User';
  const text = `Halo ${name}!\nMenu:\n1) /newcard - Generate virtual card\n2) /mycards - Lihat kad anda\n3) /freeze <card_id> - Bekukan kad\n4) /unfreeze <card_id> - Nyahbeku\n5) /deposit <amount_usd> - Deposit via CoinPayments`;
  bot.sendMessage(chatId, text);
});

bot.onText(/\/newcard/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const {pan, cvv, exp} = genCard();
  const stmt = db.prepare('INSERT INTO cards (user_id, pan, cvv, exp) VALUES (?, ?, ?, ?)');
  const info = stmt.run(userId, pan, cvv, exp);
  bot.sendMessage(chatId, `Kad baru dicipta!\nID: ${info.lastInsertRowid}\nPAN: ${pan}\nCVV: ${cvv}\nEXP: ${exp}`);
});

bot.onText(/\/mycards/, (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const rows = db.prepare('SELECT id, pan, exp, balance, status FROM cards WHERE user_id = ?').all(userId);
  if (!rows.length) return bot.sendMessage(chatId, 'Tiada kad lagi. Gunakan /newcard untuk cipta.');
  const lines = rows.map(r=>`ID:${r.id} PAN:${r.pan} EXP:${r.exp} BAL:${r.balance} STATUS:${r.status}`);
  bot.sendMessage(chatId, lines.join('\n\n'));
});

bot.onText(/\/freeze (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const cardId = Number(match[1]);
  const r = db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('frozen', cardId);
  bot.sendMessage(chatId, r.changes ? `Kad ${cardId} dibekukan.` : `Kad ${cardId} tidak ditemui.`);
});

bot.onText(/\/unfreeze (\d+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const cardId = Number(match[1]);
  const r = db.prepare('UPDATE cards SET status = ? WHERE id = ?').run('active', cardId);
  bot.sendMessage(chatId, r.changes ? `Kad ${cardId} diaktifkan.` : `Kad ${cardId} tidak ditemui.`);
});

bot.onText(/\/deposit (\d+(\.\d+)?)/, async (msg, match) => {
  const chatId = msg.chat.id;
  const amount = Number(match[1]);
  try {
    const tx = await createTransaction(amount, process.env.CP_CURRENCY || 'USDT.TRX', msg.from.username ? `${msg.from.username}@example.com` : 'no-reply@example.com');
    // tx has e.g. checkout_url and status
    const payUrl = tx.checkout_url || tx.result?.checkout_url || tx.result?.txn_url || tx.result?.status_url;
    const paymentInfo = `Sila bayar ${amount} USD via CoinPayments.\nAlamat/URL pembayaran:\n${payUrl}\n\nNota: TP ID: ${tx.txn_id || tx.result?.txn_id || 'N/A'}`;
    bot.sendMessage(chatId, paymentInfo);
    // optional: save pending tx in DB if want to credit on IPN
    db.prepare(`CREATE TABLE IF NOT EXISTS payments (id INTEGER PRIMARY KEY AUTOINCREMENT, txid TEXT, amount REAL, user_id INTEGER, raw TEXT, status TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)`).run();
    db.prepare('INSERT INTO payments (txid, amount, user_id, raw, status) VALUES (?, ?, ?, ?, ?)').run(tx.txn_id || tx.result?.txn_id || '', amount, msg.from.id, JSON.stringify(tx), 'pending');
  } catch (e) {
    console.error(e);
    bot.sendMessage(chatId, `Ralat membuat payment: ${e.message || e}`);
  }
});

// IPN endpoint from CoinPayments (POST)
app.post('/coinpayments-ipn', (req, res) => {
  // Very important: verify IPN HMAC signature using IPN secret (CoinPayments)
  // CoinPayments sends HMAC header 'hmac' with raw body; the client library doesn't auto-verify here
  const ipnSecret = process.env.CP_IPN_SECRET;
  const hmac = req.headers['hmac'] || req.headers['HMAC'];
  const rawBody = JSON.stringify(req.body);
  const crypto = require('crypto');

  if (!ipnSecret || !hmac) {
    console.warn('IPN secret or HMAC missing');
    return res.status(400).send('missing');
  }
  const sign = crypto.createHmac('sha512', ipnSecret).update(rawBody).digest('hex');
  if (sign !== hmac) {
    console.warn('IPN signature mismatch');
    return res.status(403).send('bad sig');
  }

  const ipn = req.body;
  // Example: ipn.txn_id, ipn.status, ipn.status_text, ipn.amount1, ipn.currency1, ipn.received_confirms
  const txid = ipn.txn_id;
  const status = Number(ipn.status); // >0 means confirmed
  const amount1 = Number(ipn.amount1 || 0);
  // find payment record
  const payment = db.prepare('SELECT * FROM payments WHERE txid = ?').get(txid);
  if (!payment) {
    // optionally insert
    db.prepare('INSERT INTO payments (txid, amount, user_id, raw, status) VALUES (?, ?, ?, ?, ?)').run(txid, amount1, null, JSON.stringify(ipn), status>0 ? 'complete' : 'pending');
  } else {
    if (status > 0) {
      // mark complete and credit to user's first card (example)
      db.prepare('UPDATE payments SET status = ? WHERE txid = ?').run('complete', txid);
      // credit: here we choose to add to user's first card
      const userId = payment.user_id;
      const card = db.prepare('SELECT id FROM cards WHERE user_id = ? ORDER BY id LIMIT 1').get(userId);
      if (card) {
        db.prepare('UPDATE cards SET balance = balance + ? WHERE id = ?').run(amount1, card.id);
        // send Telegram msg to user (if known)
        // we cannot call bot.sendMessage if user_id null; handle carefully
        if (userId) {
          bot.sendMessage(userId, `Deposit processed: ${amount1} ${ipn.currency1 || ''}. Dimasukkan ke Kad ID ${card.id}.`);
        }
      }
    } else {
      // pending or failed
      db.prepare('UPDATE payments SET status = ? WHERE txid = ?').run('pending', txid);
    }
  }

  res.send('OK');
});

// health
app.get('/', (req,res)=>res.send('OK'));

app.listen(PORT, ()=> {
  console.log('Server running on port', PORT);
});
