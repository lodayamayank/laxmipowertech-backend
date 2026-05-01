import express from 'express';
import SalaryPolicy from '../models/SalaryPolicy.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// GET /api/salary-policy
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }
    const policy = await SalaryPolicy.findOne().lean();
    res.json(policy || {
      holidayPaidLeaveEligibleRoles: ['staff', 'supervisor'],
      sundayHolidayExcludedRoles: ['labour'],
      overtimeEligibleRoles: ['staff', 'supervisor', 'subcontractor', 'labour'],
    });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch salary policy', error: err.message });
  }
});

// PUT /api/salary-policy
router.put('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { holidayPaidLeaveEligibleRoles, sundayHolidayExcludedRoles, overtimeEligibleRoles } = req.body;

    const PAYROLL_ROLES = ['staff', 'supervisor', 'subcontractor', 'labour'];
    const update = {};
    if (holidayPaidLeaveEligibleRoles) {
      update.holidayPaidLeaveEligibleRoles = holidayPaidLeaveEligibleRoles.filter(r => PAYROLL_ROLES.includes(r));
    }
    if (sundayHolidayExcludedRoles) {
      update.sundayHolidayExcludedRoles = sundayHolidayExcludedRoles.filter(r => PAYROLL_ROLES.includes(r));
    }
    if (overtimeEligibleRoles !== undefined) {
      update.overtimeEligibleRoles = overtimeEligibleRoles.filter(r => PAYROLL_ROLES.includes(r));
    }

    const policy = await SalaryPolicy.findOneAndUpdate(
      {},
      { $set: update },
      { new: true, upsert: true }
    );
    res.json(policy);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update salary policy', error: err.message });
  }
});

export default router;
