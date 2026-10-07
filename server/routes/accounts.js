const express = require('express');
const { db } = require('../database');
const { asyncHandler } = require('../utils/helpers');
const auth = require('../middleware/auth');
const { accountsForUser, accountForUser, publicAccount } = require('../services/ownership');
const { customerIdentityReady } = require('../migrations/004_customer_identity');

const router = express.Router();

// All account routes require auth
router.use(auth);
router.use((req, res, next) => {
  if (req.user.role !== 'user') return res.status(403).json({ error: 'Customer account access is required.' });
  next();
});

router.get('/', (req, res) => {
  const accounts = accountsForUser(db, req.user.id);
  if (!accounts) return res.status(503).json({ error: 'Account ownership migration is required.' });
  res.json({ accounts: accounts.map(publicAccount) });
});

// Get full dashboard data in one call
router.get('/me', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const verifiedColumn = customerIdentityReady(db) ? 'email_verified_at' : 'NULL';

  // 1. Get user profile
  const user = db.prepare(`
    SELECT id, email, first_name as firstName, last_name as lastName, 
           account_type as accountType, account_label as accountLabel, 
           balance, created_at as createdAt, ${verifiedColumn} as emailVerifiedAt,
           is_joint as isJoint, joint_first_name as jointFirstName, joint_last_name as jointLastName
    FROM users WHERE id = ?
  `).get(userId);

  // Send masked account number in regular payload
  const ownedAccounts = accountsForUser(db, userId);
  if (ownedAccounts && ownedAccounts.length === 0) {
    return res.status(409).json({ error: 'Account ownership requires review.' });
  }
  const fullAccountNumber = ownedAccounts?.[0]?.accountNumber ||
    db.prepare('SELECT account_number FROM users WHERE id = ?').get(userId).account_number;
  user.accountMask = fullAccountNumber.slice(-4);
  if (ownedAccounts) {
    user.balance = ownedAccounts.reduce((sum, account) => sum + account.balanceMinor, 0) / 100;
    user.isJoint = ownedAccounts.some(account => account.ownershipKind === 'joint');
  }

  // 2. Get cards
  const cards = db.prepare(`
    SELECT id, name, mask, network, status, frozen, spend, card_limit as cardLimit, theme, nickname, holder,
           contactless, online, international, atm
    FROM cards WHERE user_id = ?
  `).all(userId);

  // Convert SQLite integers (0/1) to booleans
  cards.forEach(card => {
    for (const field of ['frozen', 'contactless', 'online', 'international', 'atm']) card[field] = !!card[field];
  });

  // 3. Get spending categories
  const spending = db.prepare(`
    SELECT id, label, amount, budget 
    FROM spending WHERE user_id = ?
  `).all(userId);

  res.json({
    user,
    accounts: ownedAccounts ? ownedAccounts.map(publicAccount) : [
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
  const ownedAccounts = accountsForUser(db, req.user.id);
  if (ownedAccounts) {
    const account = req.query.accountId === undefined ? ownedAccounts[0] :
      accountForUser(db, req.user.id, req.query.accountId);
    if (!account) return res.status(404).json({ error: 'Account not found.' });
    return res.json({ accountNumber: account.accountNumber });
  }
  const user = db.prepare('SELECT account_number FROM users WHERE id = ?').get(req.user.id);
  res.json({ accountNumber: user.account_number });
}));

router.get('/:id', (req, res) => {
  const account = accountForUser(db, req.user.id, req.params.id);
  if (!account) return res.status(404).json({ error: 'Account not found.' });
  res.json({ account: publicAccount(account) });
});

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
    SELECT id, name, mask, network, status, frozen, spend, card_limit as cardLimit, theme, nickname, holder,
           contactless, online, international, atm
    FROM cards WHERE id = ?
  `).get(cardId);
  for (const field of ['frozen', 'contactless', 'online', 'international', 'atm']) updatedCard[field] = !!updatedCard[field];

  res.json({ card: updatedCard });
}));

// Update card (theme, nickname)
router.put('/cards/:id', asyncHandler(async (req, res) => {
  const cardId = req.params.id;
  const { theme, nickname, cardLimit, name, holder, contactless, online, international, atm } = req.body;

  // Verify ownership
  const card = db.prepare('SELECT id FROM cards WHERE id = ? AND user_id = ?').get(cardId, req.user.id);
  if (!card) {
    return res.status(404).json({ error: 'Card not found' });
  }

  const updates = [];
  const params = [];

  if (theme !== undefined && !['graphite', 'emerald', 'ocean', 'sunrise'].includes(theme)) {
    return res.status(400).json({ error: 'Invalid card theme' });
  }
  for (const [field, value, max] of [['nickname', nickname, 24], ['name', name, 28], ['holder', holder, 30]]) {
    if (value !== undefined && (typeof value !== 'string' || !value.trim() || value.trim().length > max)) {
      return res.status(400).json({ error: `Invalid ${field}` });
    }
  }
  if (cardLimit !== undefined && (!Number.isInteger(cardLimit) || cardLimit < 50 || cardLimit > 5000 || cardLimit % 50 !== 0)) {
    return res.status(400).json({ error: 'Card limit must be between 50 and 5000 in steps of 50' });
  }
  for (const [field, value] of Object.entries({ contactless, online, international, atm })) {
    if (value !== undefined && typeof value !== 'boolean') return res.status(400).json({ error: `Invalid ${field} setting` });
  }

  if (theme !== undefined) {
    updates.push('theme = ?');
    params.push(theme);
  }
  if (nickname !== undefined) {
    updates.push('nickname = ?');
    params.push(nickname.trim());
  }
  if (cardLimit !== undefined) {
    updates.push('card_limit = ?');
    params.push(cardLimit);
  }
  for (const [field, value] of Object.entries({ name, holder })) {
    if (value !== undefined) {
      updates.push(`${field} = ?`);
      params.push(value.trim());
    }
  }
  for (const [field, value] of Object.entries({ contactless, online, international, atm })) {
    if (value !== undefined) {
      updates.push(`${field} = ?`);
      params.push(value ? 1 : 0);
    }
  }

  if (updates.length > 0) {
    params.push(cardId);
    db.prepare(`UPDATE cards SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }

  const updatedCard = db.prepare(`
    SELECT id, name, mask, network, status, frozen, spend, card_limit as cardLimit, theme, nickname, holder,
           contactless, online, international, atm
    FROM cards WHERE id = ?
  `).get(cardId);
  for (const field of ['frozen', 'contactless', 'online', 'international', 'atm']) updatedCard[field] = !!updatedCard[field];

  res.json({ card: updatedCard });
}));

module.exports = router;
