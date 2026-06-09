const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  // If it's our custom validation error array from express-validator
  if (Array.isArray(err) && err[0]?.msg) {
    return res.status(400).json({ error: err[0].msg });
  }

  // Handle specific database errors (e.g. SQLite unique constraint)
  if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'Record already exists. Please use a different email.' });
  }

  // Default server error
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';

  res.status(statusCode).json({
    error: message,
    // Only send stack trace in development
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

module.exports = errorHandler;
