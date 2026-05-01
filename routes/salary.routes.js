import express from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import { calculateSalaryForPeriod } from '../services/salary.service.js';
import SalaryCache from '../models/SalaryCache.js';

const router = express.Router();

// GET /api/salary/calculate
// Reads from pre-computed cache. Falls back to live calculation if no cache exists yet.
router.get('/calculate', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admin only.' });
    }

    const currentDate = new Date();
    const month = parseInt(req.query.month) || currentDate.getMonth() + 1;
    const year = parseInt(req.query.year) || currentDate.getFullYear();
    const role = req.query.role || '';
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

    const cache = await SalaryCache.findOne({ month, year }).lean();

    let employees = [];
    let computedAt = null;

    if (cache) {
      employees = cache.employees;
      computedAt = cache.computedAt;
    } else {
      // No cache yet — compute live and store it for next time
      const result = await calculateSalaryForPeriod({ month, year, page: 1, limit: 10000 });
      employees = result.data;
      computedAt = new Date();
      // Store in background — don't await so response is not delayed
      SalaryCache.findOneAndUpdate(
        { month, year },
        { $set: { employees, total: employees.length, computedAt } },
        { upsert: true }
      ).catch(err => console.error('[SalaryCache] Failed to store cache:', err.message));
    }

    // Apply role filter in memory
    if (role) employees = employees.filter(e => e.role === role.toLowerCase());

    const total = employees.length;
    const totalPages = Math.ceil(total / limit);
    const data = employees.slice((page - 1) * limit, page * limit);

    res.json({ data, total, page, limit, totalPages, computedAt });
  } catch (err) {
    console.error('Error calculating salary:', err);
    res.status(500).json({ message: 'Failed to calculate salary', error: err.message });
  }
});

// POST /api/salary/recalculate
// Forces a fresh computation for the given month/year and stores to cache.
// Admin triggers this manually when they need up-to-date data.
router.post('/recalculate', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admin only.' });
    }

    const currentDate = new Date();
    const month = parseInt(req.body.month) || currentDate.getMonth() + 1;
    const year = parseInt(req.body.year) || currentDate.getFullYear();

    const result = await calculateSalaryForPeriod({ month, year, page: 1, limit: 10000 });
    const employees = result.data;
    const computedAt = new Date();

    await SalaryCache.findOneAndUpdate(
      { month, year },
      { $set: { employees, total: employees.length, computedAt } },
      { upsert: true }
    );

    res.json({ message: 'Salary recalculated', total: employees.length, computedAt });
  } catch (err) {
    console.error('Error recalculating salary:', err);
    res.status(500).json({ message: 'Failed to recalculate salary', error: err.message });
  }
});

// GET /api/salary/user/:userId
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const { month, year } = req.query;
    const currentDate = new Date();
    const monthNum = parseInt(month) || currentDate.getMonth() + 1;
    const yearNum = parseInt(year) || currentDate.getFullYear();

    const result = await calculateSalaryForPeriod({ month: monthNum, year: yearNum, userId });
    if (!result.data || result.data.length === 0) {
      return res.status(404).json({ message: 'User not found or no salary data' });
    }
    res.json(result.data[0]);
  } catch (err) {
    console.error('Error fetching user salary:', err);
    res.status(500).json({ message: 'Failed to fetch salary', error: err.message });
  }
});

export default router;
