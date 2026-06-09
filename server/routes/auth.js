const express = require('express');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { db } = require('../database');
const config = require('../config');
const { asyncHandler, generateAccountNumber } = require('../utils/helpers');
const { validateRegistration, validateLogin } = require('../middleware/validate');
const { authLimiter } = require('../middleware/rateLimiter');

const router = express.Router();

// Apply strict rate limiting to auth routes
router.use(authLimiter);

// Register
router.post('/register', validateRegistration, asyncHandler(async (req, res) => {
  const { email, password, firstName, lastName, phone, dob, accountType } = req.body;

  // Check if email exists
  const existingUser = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existingUser) {
    return res.status(409).json({ error: 'Email already in use' });
  }

  const hashedPassword = await bcrypt.hash(password, 12);
  const accountLabel = accountType === 'business' ? 'Business Checking' : 
                       accountType === 'student' ? 'Student Checking' : 'Personal Checking';

  // Generate unique account number
  let accountNumber;
  let isUnique = false;
  while (!isUnique) {
    accountNumber = generateAccountNumber();
    const existing = db.prepare('SELECT id FROM users WHERE account_number = ?').get(accountNumber);
    if (!existing) isUnique = true;
  }

  // Use database transaction for creating user + initial card + spending categories
  const createAccount = db.transaction(() => {
    // 1. Create User
    const userResult = db.prepare(`
      INSERT INTO users (email, password_hash, first_name, last_name, phone, dob, account_type, account_label, account_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(email, hashedPassword, firstName, lastName, phone || '', dob || '', accountType, accountLabel, accountNumber);
    
    const userId = userResult.lastInsertRowid;

    // 2. Create default card
    db.prepare(`
      INSERT INTO cards (user_id, mask, holder)
      VALUES (?, ?, ?)
    `).run(userId, accountNumber.slice(-4), `${firstName} ${lastName}`);

    // 3. Create default spending categories
    const stmt = db.prepare('INSERT INTO spending (user_id, label, amount, budget) VALUES (?, ?, ?, ?)');
    stmt.run(userId, 'Groceries & Dining', 0, 400);
    stmt.run(userId, 'Subscriptions', 0, 150);
    stmt.run(userId, 'Transport', 0, 100);

    return { id: userId, email, firstName, lastName, accountNumber, role: 'user' };
  });

  const newUser = createAccount();

  // Generate JWT
  const token = jwt.sign(
    { id: newUser.id, email: newUser.email, role: newUser.role },
    config.JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.status(201).json({ token, user: newUser });
}));

// Login
router.post('/login', validateLogin, asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  if (user.suspended) {
    return res.status(403).json({ error: 'Your account has been suspended. Please contact support.' });
  }

  const validPassword = await bcrypt.compare(password, user.password_hash);
  if (!validPassword) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Generate JWT
  const token = jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    config.JWT_SECRET,
    { expiresIn: '24h' }
  );

  const userResponse = {
    id: user.id,
    email: user.email,
    firstName: user.first_name,
    lastName: user.last_name,
    accountNumber: user.account_number,
    role: user.role
  };

  res.json({ token, user: userResponse });
}));

module.exports = router;
