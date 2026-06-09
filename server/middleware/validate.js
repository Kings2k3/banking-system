const { body, validationResult } = require('express-validator');

// Helper to return validation errors
const handleValidationErrors = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    // Pass errors to global error handler
    return next(errors.array());
  }
  next();
};

const validateRegistration = [
  body('email').isEmail().withMessage('Please provide a valid email address').normalizeEmail(),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters long'),
  body('firstName').notEmpty().withMessage('First name is required').trim(),
  body('lastName').notEmpty().withMessage('Last name is required').trim(),
  body('accountType').isIn(['personal', 'business', 'student']).withMessage('Invalid account type'),
  handleValidationErrors
];

const validateLogin = [
  body('email').isEmail().withMessage('Please provide a valid email address').normalizeEmail(),
  body('password').notEmpty().withMessage('Password is required'),
  handleValidationErrors
];

const validateTransfer = [
  body('amount').isFloat({ gt: 0 }).withMessage('Transfer amount must be greater than 0'),
  body('recipient').notEmpty().withMessage('Recipient is required').trim(),
  handleValidationErrors
];

const validateAdminAdjustment = [
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be greater than 0'),
  body('type').isIn(['credit', 'debit']).withMessage('Adjustment type must be credit or debit'),
  body('reason').notEmpty().withMessage('Reason for adjustment is required').trim(),
  handleValidationErrors
];

module.exports = {
  validateRegistration,
  validateLogin,
  validateTransfer,
  validateAdminAdjustment
};
