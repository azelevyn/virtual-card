// helpers/coinpayments.js
const CoinPayments = require('coinpayments');
require('dotenv').config();

const client = new CoinPayments({
  key: process.env.CP_PUBLIC_KEY,
  secret: process.env.CP_PRIVATE_KEY
});

// create a transaction
async function createTransaction(amountUSD, currency2 = 'USDT.TRX', buyer_email='no-reply@example.com') {
  // currency1 = USD, currency2 is coin to pay in. Adjust currency2 as supported by CP.
  return new Promise((resolve, reject) => {
    client.createTransaction({
      amount: amountUSD,
      currency1: 'USD',
      currency2,
      buyer_email
    }, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });
}

module.exports = { createTransaction, client };
