const express = require('express');
const { db } = require('../database');
const { asyncHandler } = require('../utils/helpers');
const auth = require('../middleware/auth');

const router = express.Router();

// Require authentication for all support ticket actions
router.use(auth);

// Get all support tickets for the current user
router.get('/tickets', asyncHandler(async (req, res) => {
  const userId = req.user.id;

  const tickets = db.prepare(`
    SELECT id, subject, message, status, created_at
    FROM support_tickets
    WHERE user_id = ?
    ORDER BY created_at DESC
  `).all(userId);

  res.json({ tickets });
}));

// Submit a new support ticket
router.post('/tickets', asyncHandler(async (req, res) => {
  const userId = req.user.id;
  const { subject, message } = req.body;

  if (!subject || !message) {
    return res.status(400).json({ error: 'Subject and message are required.' });
  }

  const result = db.prepare(`
    INSERT INTO support_tickets (user_id, subject, message)
    VALUES (?, ?, ?)
  `).run(userId, subject.trim(), message.trim());

  const newTicket = {
    id: result.lastInsertRowid,
    subject: subject.trim(),
    message: message.trim(),
    status: 'open',
    created_at: new Date().toISOString()
  };

  res.status(201).json({
    success: true,
    message: 'Complaint submitted successfully.',
    ticket: newTicket
  });
}));

module.exports = router;
