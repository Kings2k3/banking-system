const express = require('express');
const config = require('../config');
const { asyncHandler } = require('../utils/helpers');

const router = express.Router();

// Simple in-memory cache
let cachedRates = null;
let lastFetchTime = 0;
const CACHE_DURATION_MS = 60 * 1000; // 60 seconds

// Proxy the Frankfurter API
router.get('/rates', asyncHandler(async (req, res) => {
  const now = Date.now();
  
  if (cachedRates && (now - lastFetchTime) < CACHE_DURATION_MS) {
    return res.json({ rates: cachedRates, source: 'cache' });
  }

  const response = await fetch(`${config.FRANKFURTER_API_BASE_URL}/latest?from=USD`);
  if (!response.ok) {
    throw { statusCode: response.status, message: 'Failed to fetch exchange rates from provider' };
  }

  const data = await response.json();
  
  // Update cache
  cachedRates = data.rates;
  // Ensure USD is included as base
  if (!cachedRates.USD) cachedRates.USD = 1;
  lastFetchTime = now;

  res.json({ rates: cachedRates, source: 'api' });
}));

// Convenience endpoint for direct conversion (also cached)
router.get('/convert', asyncHandler(async (req, res) => {
  const { from = 'USD', to = 'EUR', amount = 1 } = req.query;
  const numAmount = parseFloat(amount);

  if (isNaN(numAmount) || numAmount < 0) {
    return res.status(400).json({ error: 'Invalid amount' });
  }

  if (from === to) {
    return res.json({ result: numAmount, rate: 1 });
  }

  const now = Date.now();
  if (!cachedRates || (now - lastFetchTime) >= CACHE_DURATION_MS) {
    // Refresh cache
    const response = await fetch(`${config.FRANKFURTER_API_BASE_URL}/latest?from=USD`);
    if (response.ok) {
      const data = await response.json();
      cachedRates = data.rates;
      if (!cachedRates.USD) cachedRates.USD = 1;
      lastFetchTime = now;
    } else if (!cachedRates) {
      throw { statusCode: response.status, message: 'Failed to fetch exchange rates' };
    }
    // If request failed but we have stale cache, continue with stale cache
  }

  const fromRate = from === 'USD' ? 1 : cachedRates[from];
  const toRate = to === 'USD' ? 1 : cachedRates[to];

  if (!fromRate || !toRate) {
    return res.status(400).json({ error: 'Unsupported currency' });
  }

  // Convert via USD base
  const amountInUSD = from === 'USD' ? numAmount : numAmount / fromRate;
  const result = to === 'USD' ? amountInUSD : amountInUSD * toRate;
  const exchangeRate = toRate / fromRate;

  res.json({ result, rate: exchangeRate });
}));

module.exports = router;
