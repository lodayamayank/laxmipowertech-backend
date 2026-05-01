import express from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import { calculateSalaryForPeriod } from '../services/salary.service.js';

const router = express.Router();

// GET /api/salary/calculate
router.get('/calculate', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admin only.' });
    }

    const { month, year, role, userId } = req.query;
    const currentDate = new Date();
    const monthNum = parseInt(month) || currentDate.getMonth() + 1;
    const yearNum = parseInt(year) || currentDate.getFullYear();

    const salaryData = await calculateSalaryForPeriod({ month: monthNum, year: yearNum, role, userId });
    res.json(salaryData);
  } catch (err) {
    console.error('Error calculating salary:', err);
    res.status(500).json({ message: 'Failed to calculate salary', error: err.message });
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

    const salaryData = await calculateSalaryForPeriod({ month: monthNum, year: yearNum, userId });
    if (!salaryData || salaryData.length === 0) {
      return res.status(404).json({ message: 'User not found or no salary data' });
    }
    res.json(salaryData[0]);
  } catch (err) {
    console.error('Error fetching user salary:', err);
    res.status(500).json({ message: 'Failed to fetch salary', error: err.message });
  }
});

export default router;
