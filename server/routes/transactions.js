const express = require('express');
const { db } = require('../database');
const { asyncHandler, formatMoney } = require('../utils/helpers');
const { validateTransfer } = require('../middleware/validate');
const auth = require('../middleware/auth');

const router = express.Router();

// All transaction routes require auth
router.use(auth);

// Get transactions with optional filtering/search
router.get('/', asyncHandler(async (req, res) => {
  const { type, search } = req.query;
  const userId = req.user.id;

  let query = 'SELECT id, type, category, merchant, amount, account, reference, status, created_at as date FROM transactions WHERE user_id = ?';
  const params = [userId];

  if (type && type !== 'all') {
    query += ' AND type = ?';
    params.push(type);
  }

  if (search) {
    query += ' AND (merchant LIKE ? OR category LIKE ? OR reference LIKE ?)';
    const searchPattern = `%${search}%`;
    params.push(searchPattern, searchPattern, searchPattern);
  }

  query += ' ORDER BY created_at DESC LIMIT 50';

  const transactions = db.prepare(query).all(...params);
  res.json({ transactions });
}));

// Transfer money
router.post('/transfer', validateTransfer, asyncHandler(async (req, res) => {
  const { amount, recipient, category = 'Transfer' } = req.body;
  const userId = req.user.id;
  const transferAmount = parseFloat(amount);

  // Execute within a database transaction to ensure atomicity
  const executeTransfer = db.transaction(() => {
    // 1. Check current balance
    const user = db.prepare('SELECT balance, account_number FROM users WHERE id = ?').get(userId);
    if (user.balance < transferAmount) {
      throw { statusCode: 400, message: 'Insufficient funds for this transfer' };
    }

    // 2. Deduct from balance
    const newBalance = user.balance - transferAmount;
    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);

    // 3. Create transaction record
    const accountMask = `****${user.account_number.slice(-4)}`;
    const reference = `TRF${Math.random().toString(36).substr(2, 6).toUpperCase()}`;
    
    const stmt = db.prepare(`
      INSERT INTO transactions (user_id, type, category, merchant, amount, account, reference, status)
      VALUES (?, 'spend', ?, ?, ?, ?, ?, 'Completed')
    `);
    const result = stmt.run(userId, category, recipient, transferAmount, accountMask, reference);

    // 4. Return new transaction and balance
    const transaction = db.prepare(`
      SELECT id, type, category, merchant, amount, account, reference, status, created_at as date 
      FROM transactions WHERE id = ?
    `).get(result.lastInsertRowid);

    return { transaction, balance: newBalance };
  });

  const result = executeTransfer();
  res.json(result);
}));

// Generate text statement
router.get('/statement', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  
  const user = db.prepare('SELECT first_name, last_name, account_number, balance FROM users WHERE id = ?').get(userId);
  const transactions = db.prepare(`
    SELECT type, merchant, amount, created_at as date 
    FROM transactions 
    WHERE user_id = ? 
    ORDER BY created_at DESC LIMIT 30
  `).all(userId);

  let statement = `PAYVEXIS ACCOUNT STATEMENT\n`;
  statement += `==========================\n\n`;
  statement += `Account Holder : ${user.first_name} ${user.last_name}\n`;
  statement += `Account Number : ${user.account_number}\n`;
  statement += `Current Balance: ${formatMoney(user.balance)}\n`;
  statement += `Date Generated : ${new Date().toLocaleDateString('en-US')}\n\n`;
  statement += `RECENT TRANSACTIONS\n`;
  statement += `--------------------------------------------------\n`;
  statement += `DATE       | DESCRIPTION                  | AMOUNT\n`;
  statement += `--------------------------------------------------\n`;

  if (transactions.length === 0) {
    statement += `No recent transactions found.\n`;
  } else {
    transactions.forEach(tx => {
      const date = tx.date.split(' ')[0]; // Just the YYYY-MM-DD
      const desc = tx.merchant.padEnd(28, ' ').substring(0, 28);
      const sign = tx.type === 'income' ? '+' : '-';
      const amount = `${sign}${formatMoney(tx.amount)}`.padStart(10, ' ');
      statement += `${date} | ${desc} | ${amount}\n`;
    });
  }

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', `attachment; filename="Payvexis_Statement_${user.account_number.slice(-4)}.txt"`);
  res.send(statement);
}));

module.exports = router;
