const express = require('express');
const { db } = require('../database');
const { asyncHandler } = require('../utils/helpers');
const auth = require('../middleware/auth');

const router = express.Router();

// All account routes require auth
router.use(auth);

// Get full dashboard data in one call
router.get('/me', asyncHandler(async (req, res) => {
  const userId = req.user.id;

  // 1. Get user profile
  const user = db.prepare(`
    SELECT id, email, first_name as firstName, last_name as lastName, 
           account_type as accountType, account_label as accountLabel, 
           balance, created_at as createdAt,
           is_joint as isJoint, joint_first_name as jointFirstName, joint_last_name as jointLastName
    FROM users WHERE id = ?
  `).get(userId);

  // Send masked account number in regular payload
  const fullAccountNumber = db.prepare('SELECT account_number FROM users WHERE id = ?').get(userId).account_number;
  user.accountMask = fullAccountNumber.slice(-4);

  // 2. Get cards
  const cards = db.prepare(`
    SELECT id, name, mask, network, status, frozen, spend, card_limit as cardLimit, theme, nickname, holder 
    FROM cards WHERE user_id = ?
  `).all(userId);

  // Convert SQLite integers (0/1) to booleans
  cards.forEach(card => card.frozen = !!card.frozen);

  // 3. Get spending categories
  const spending = db.prepare(`
    SELECT id, label, amount, budget 
    FROM spending WHERE user_id = ?
  `).all(userId);

  res.json({
    user,
    accounts: [
      {
        id: 'acc_1',
        name: user.accountLabel,
        label: user.accountLabel,
        type: user.accountType,
        mask: fullAccountNumber.slice(-4),
        balance: user.balance,
        trend: 'Active',
        currency: 'USD',
        isJoint: !!user.isJoint,
        jointFirstName: user.jointFirstName,
        jointLastName: user.jointLastName
      }
    ],
    cards,
    spending
  });
}));

// Reveal full account number
router.get('/number', asyncHandler(async (req, res) => {
  const user = db.prepare('SELECT account_number FROM users WHERE id = ?').get(req.user.id);
  res.json({ accountNumber: user.account_number });
}));

// Freeze/Unfreeze card
router.put('/cards/:id/freeze', asyncHandler(async (req, res) => {
  const cardId = req.params.id;
  
  // Verify ownership
  const card = db.prepare('SELECT id, frozen FROM cards WHERE id = ? AND user_id = ?').get(cardId, req.user.id);
  if (!card) {
    return res.status(404).json({ error: 'Card not found' });
  }

  const newFrozenState = card.frozen ? 0 : 1;
  const newStatus = newFrozenState ? 'Frozen' : 'Active';

  db.prepare('UPDATE cards SET frozen = ?, status = ? WHERE id = ?').run(newFrozenState, newStatus, cardId);

  // Return updated card
  const updatedCard = db.prepare(`
    SELECT id, name, mask, network, status, frozen, spend, card_limit as cardLimit, theme, nickname, holder 
    FROM cards WHERE id = ?
  `).get(cardId);
  updatedCard.frozen = !!updatedCard.frozen;

  res.json({ card: updatedCard });
}));

// Update card (theme, nickname)
router.put('/cards/:id', asyncHandler(async (req, res) => {
  const cardId = req.params.id;
  const { theme, nickname, cardLimit } = req.body;

  // Verify ownership
  const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(cardId, req.user.id);
  if (!card) {
    return res.status(404).json({ error: 'Card not found' });
  }

  const updates = [];
  const params = [];

  if (theme !== undefined) {
    updates.push('theme = ?');
    params.push(theme);
  }
  if (nickname !== undefined) {
    updates.push('nickname = ?');
    params.push(nickname);
  }
  if (cardLimit !== undefined) {
    updates.push('card_limit = ?');
    params.push(cardLimit);
  }

  if (updates.length > 0) {
    params.push(cardId);
    db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updatedCard = db.prepare(`
    SELECT id, name, mask, network, status, frozen, spend, card_limit as cardLimit, theme, nickname, holder 
    FROM cards WHERE id = ?
  `).get(cardId);
  updatedCard.frozen = !!updatedCard.frozen;

  res.json({ card: updatedCard });
}));

module.exports = router;
