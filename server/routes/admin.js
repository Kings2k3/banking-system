const express = require('express');
const { db } = require('../database');
const { asyncHandler, logAuditAction } = require('../utils/helpers');
const { validateAdminAdjustment } = require('../middleware/validate');
const auth = require('../middleware/auth');
const admin = require('../middleware/admin');

const router = express.Router();

// All admin routes require auth AND admin role
router.use(auth);
router.use(admin);

// Get system stats
router.get('/stats', asyncHandler(async (req, res) => {
  const totalUsers = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'user'").get().count;
  const totalBalance = db.prepare("SELECT SUM(balance) as total FROM users WHERE role = 'user'").get().total || 0;
  const transactionCount = db.prepare("SELECT COUNT(*) as count FROM transactions").get().count;
  const suspendedCount = db.prepare("SELECT COUNT(*) as count FROM users WHERE role = 'user' AND suspended = 1").get().count;

  res.json({ totalUsers, totalBalance, transactionCount, suspendedCount });
}));

// Get all users (paginated, searchable)
router.get('/users', asyncHandler(async (req, res) => {
  const { search, status, sort = 'created_at_desc', page = 1, limit = 20 } = req.query;
  const offset = (page - 1) * limit;

  let query = "SELECT id, email, first_name, last_name, account_number, balance, suspended, created_at FROM users WHERE role = 'user'";
  let countQuery = "SELECT COUNT(*) as total FROM users WHERE role = 'user'";
  const params = [];

  if (search) {
    const searchPattern = `%${search}%`;
    const searchClause = " AND (email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR account_number LIKE ?)";
    query += searchClause;
    countQuery += searchClause;
    params.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (status === 'suspended') {
    query += " AND suspended = 1";
    countQuery += " AND suspended = 1";
  } else if (status === 'active') {
    query += " AND suspended = 0";
    countQuery += " AND suspended = 0";
  }

  if (sort === 'balance_desc') query += " ORDER BY balance DESC";
  else if (sort === 'balance_asc') query += " ORDER BY balance ASC";
  else if (sort === 'created_at_asc') query += " ORDER BY created_at ASC";
  else query += " ORDER BY created_at DESC"; // default

  query += " LIMIT ? OFFSET ?";
  
  const total = db.prepare(countQuery).get(...params).total;
  const users = db.prepare(query).all(...params, limit, offset);

  res.json({ users, total, page: parseInt(page), limit: parseInt(limit) });
}));

// Get specific user details
router.get('/users/:id', asyncHandler(async (req, res) => {
  const userId = req.params.id;

  const user = db.prepare(`
    SELECT id, email, first_name, last_name, phone, dob, account_type, account_label, account_number, balance, suspended, created_at 
    FROM users WHERE id = ? AND role = 'user'
  `).get(userId);

  if (!user) return res.status(404).json({ error: 'User not found' });

  const cards = db.prepare('SELECT id, name, mask, status, frozen, card_limit FROM cards WHERE user_id = ?').all(userId);
  const transactions = db.prepare('SELECT id, type, category, merchant, amount, status, created_at FROM transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 20').all(userId);

  res.json({ user, cards, transactions });
}));

// Suspend/Unsuspend user
router.put('/users/:id/suspend', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const adminId = req.user.id;
  const ipAddress = req.ip || req.connection.remoteAddress;

  const user = db.prepare("SELECT suspended, email FROM users WHERE id = ? AND role = 'user'").get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const newSuspendedState = user.suspended ? 0 : 1;
  db.prepare('UPDATE users SET suspended = ? WHERE id = ?').run(newSuspendedState, userId);

  const action = newSuspendedState ? 'suspend_user' : 'unsuspend_user';
  logAuditAction(db, adminId, action, 'user', userId, `Admin toggled suspension state for ${user.email}`, ipAddress);

  res.json({ success: true, suspended: !!newSuspendedState });
}));

// Delete user
router.delete('/users/:id', asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const adminId = req.user.id;
  const ipAddress = req.ip || req.connection.remoteAddress;

  const user = db.prepare("SELECT email FROM users WHERE id = ? AND role = 'user'").get(userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Database uses ON DELETE CASCADE for foreign keys, so deleting user cleans up their cards/transactions
  db.prepare('DELETE FROM users WHERE id = ?').run(userId);

  logAuditAction(db, adminId, 'delete_user', 'user', userId, `Admin deleted user ${user.email}`, ipAddress);

  res.json({ success: true });
}));

// Credit/Debit account
router.post('/users/:id/adjust', validateAdminAdjustment, asyncHandler(async (req, res) => {
  const userId = req.params.id;
  const adminId = req.user.id;
  const ipAddress = req.ip || req.connection.remoteAddress;
  const { amount, type, reason } = req.body; // type is 'credit' or 'debit'
  const adjustmentAmount = parseFloat(amount);

  const executeAdjustment = db.transaction(() => {
    const user = db.prepare('SELECT balance, account_number, email FROM users WHERE id = ?').get(userId);
    if (!user) throw { statusCode: 404, message: 'User not found' };

    let newBalance;
    let txType;
    if (type === 'credit') {
      newBalance = user.balance + adjustmentAmount;
      txType = 'income';
    } else {
      if (user.balance < adjustmentAmount) throw { statusCode: 400, message: 'Insufficient funds for debit' };
      newBalance = user.balance - adjustmentAmount;
      txType = 'spend';
    }

    db.prepare('UPDATE users SET balance = ? WHERE id = ?').run(newBalance, userId);

    const accountMask = `****${user.account_number.slice(-4)}`;
    const reference = `ADM${Math.random().toString(36).substr(2, 6).toUpperCase()}`;

    const stmt = db.prepare(`
      INSERT INTO transactions (user_id, type, category, merchant, amount, account, reference, status)
      VALUES (?, ?, 'Admin Adjustment', ?, ?, ?, ?, 'Completed')
    `);
    const txResult = stmt.run(userId, txType, reason, adjustmentAmount, accountMask, reference);

    logAuditAction(db, adminId, 'account_adjustment', 'user', userId, `Admin ${type}ed ${adjustmentAmount} to ${user.email}. Reason: ${reason}`, ipAddress);

    return { 
      balance: newBalance, 
      transactionId: txResult.lastInsertRowid 
    };
  });

  const result = executeAdjustment();
  res.json(result);
}));

// Freeze/Unfreeze any card
router.put('/cards/:id/freeze', asyncHandler(async (req, res) => {
  const cardId = req.params.id;
  const adminId = req.user.id;
  const ipAddress = req.ip || req.connection.remoteAddress;
  
  const card = db.prepare('SELECT frozen, mask, user_id FROM cards WHERE id = ?').get(cardId);
  if (!card) return res.status(404).json({ error: 'Card not found' });

  const newFrozenState = card.frozen ? 0 : 1;
  const newStatus = newFrozenState ? 'Frozen' : 'Active';

  db.prepare('UPDATE cards SET frozen = ?, status = ? WHERE id = ?').run(newFrozenState, newStatus, cardId);

  const action = newFrozenState ? 'freeze_card' : 'unfreeze_card';
  logAuditAction(db, adminId, action, 'card', cardId, `Admin ${newFrozenState ? 'froze' : 'unfroze'} card ${card.mask}`, ipAddress);

  res.json({ success: true, frozen: !!newFrozenState });
}));

// Get audit logs
router.get('/audit', asyncHandler(async (req, res) => {
  const { action, admin_id, page = 1, limit = 50 } = req.query;
  const offset = (page - 1) * limit;

  let query = `
    SELECT a.id, a.action, a.target_type, a.target_id, a.details, a.ip_address, a.created_at, u.email as admin_email 
    FROM audit_log a
    JOIN users u ON a.admin_id = u.id
    WHERE 1=1
  `;
  let countQuery = "SELECT COUNT(*) as total FROM audit_log WHERE 1=1";
  const params = [];

  if (action) {
    query += " AND a.action = ?";
    countQuery += " AND action = ?";
    params.push(action);
  }

  if (admin_id) {
    query += " AND a.admin_id = ?";
    countQuery += " AND admin_id = ?";
    params.push(admin_id);
  }

  query += " ORDER BY a.created_at DESC LIMIT ? OFFSET ?";
  
  const total = db.prepare(countQuery).get(...params).total;
  const logs = db.prepare(query).all(...params, limit, offset);

  res.json({ logs, total, page: parseInt(page), limit: parseInt(limit) });
}));

module.exports = router;
