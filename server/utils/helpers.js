// Wrapper to catch async errors and pass them to error handling middleware
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Generates a random 10-digit account number as a string
const generateAccountNumber = () => {
  return String(Math.floor(1000000000 + Math.random() * 9000000000));
};

// Formats a number to USD currency string
const formatMoney = (amount) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  }).format(amount);
};

// Utility to log actions to the audit log
const logAuditAction = (db, adminId, action, targetType, targetId, details, ipAddress) => {
  const stmt = db.prepare(`
    INSERT INTO audit_log (admin_id, action, target_type, target_id, details, ip_address)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run(adminId, action, targetType, targetId, details, ipAddress);
};

module.exports = {
  asyncHandler,
  generateAccountNumber,
  formatMoney,
  logAuditAction
};
