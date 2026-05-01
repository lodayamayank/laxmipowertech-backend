import express from 'express';
import SalarySlip from '../models/SalarySlip.js';
import authMiddleware from '../middleware/authMiddleware.js';
import { calculateSalaryForPeriod } from '../services/salary.service.js';

const router = express.Router();

// GET all salary slips (admin only, with filters)
router.get('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { month, year, userId, paymentStatus, page = 1, limit = 50 } = req.query;
    const cappedLimit = Math.min(parseInt(limit), 100);

    const filter = {};
    if (month) filter.month = parseInt(month);
    if (year) filter.year = parseInt(year);
    if (userId) filter.user = userId;
    if (paymentStatus) filter.paymentStatus = paymentStatus;

    const skip = (parseInt(page) - 1) * cappedLimit;

    const [slips, total] = await Promise.all([
      SalarySlip.find(filter)
        .populate('user', 'name username employeeId role department')
        .populate('generatedBy', 'name username')
        .sort({ year: -1, month: -1, createdAt: -1 })
        .skip(skip)
        .limit(cappedLimit)
        .lean(),
      SalarySlip.countDocuments(filter),
    ]);

    res.json({
      slips,
      pagination: {
        page: parseInt(page),
        limit: cappedLimit,
        total,
        pages: Math.ceil(total / cappedLimit),
      },
    });
  } catch (err) {
    console.error('Error fetching salary slips:', err);
    res.status(500).json({ message: 'Failed to fetch salary slips', error: err.message });
  }
});

// GET salary slips for current user (employee view)
router.get('/my-slips', authMiddleware, async (req, res) => {
  try {
    const { year, limit = 12 } = req.query;
    const filter = { user: req.user.id };
    if (year) filter.year = parseInt(year);

    const slips = await SalarySlip.find(filter)
      .sort({ year: -1, month: -1 })
      .limit(parseInt(limit))
      .lean();

    res.json(slips);
  } catch (err) {
    console.error('Error fetching my salary slips:', err);
    res.status(500).json({ message: 'Failed to fetch salary slips', error: err.message });
  }
});

// GET single salary slip by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const slip = await SalarySlip.findById(req.params.id)
      .populate('user', 'name username employeeId role department jobTitle')
      .populate('generatedBy', 'name username')
      .lean();

    if (!slip) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    if (req.user.role !== 'admin' && slip.user._id.toString() !== req.user.id) {
      return res.status(403).json({ message: 'Access denied' });
    }

    res.json(slip);
  } catch (err) {
    console.error('Error fetching salary slip:', err);
    res.status(500).json({ message: 'Failed to fetch salary slip', error: err.message });
  }
});

// POST - Generate salary slips (bulk, no internal HTTP call)
router.post('/generate', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { month, year, userId, overwrite = false } = req.body;

    if (!month || !year) {
      return res.status(400).json({ message: 'Month and year are required' });
    }

    const monthNum = parseInt(month);
    const yearNum = parseInt(year);

    // Use service directly — no internal HTTP call
    const salaryData = await calculateSalaryForPeriod({ month: monthNum, year: yearNum, userId });

    if (!salaryData || salaryData.length === 0) {
      return res.status(404).json({ message: 'No salary data found for the specified period' });
    }

    // Preload existing slips for bulk decision
    const userIds = salaryData.map(s => s.userId);
    const existingSlips = await SalarySlip.find({
      user: { $in: userIds },
      month: monthNum,
      year: yearNum,
    }).lean();

    const existingByUser = {};
    existingSlips.forEach(s => {
      existingByUser[s.user.toString()] = s;
    });

    const bulkOps = [];
    const created = [];
    const skipped = [];
    const errors = [];

    for (const salary of salaryData) {
      const uid = salary.userId.toString();
      const existing = existingByUser[uid];

      if (existing && !overwrite) {
        skipped.push({ userId: salary.userId, name: salary.name, reason: 'Slip already exists' });
        continue;
      }
      if (existing && existing.locked) {
        skipped.push({ userId: salary.userId, name: salary.name, reason: 'Slip is locked' });
        continue;
      }

      const slipData = {
        user: salary.userId,
        month: monthNum,
        year: yearNum,
        employeeDetails: {
          name: salary.name,
          username: salary.username,
          employeeId: salary.employeeId,
          role: salary.role,
          department: salary.department,
          jobTitle: salary.jobTitle || '',
        },
        salaryConfig: {
          ctcAmount: salary.ctcAmount,
          salaryType: salary.salaryType,
          perDayTravelAllowance: salary.perDayTravelAllowance || 0,
          railwayPassAmount: salary.railwayPassAmount || 0,
          standardDailyHours: salary.standardDailyHours || 9,
          overtimeRateMultiplier: salary.overtimeRateMultiplier || 1.0,
          otherAmount: salary.otherAmount || 0,
          otherAmountType: salary.otherAmountType || 'earning',
        },
        attendance: salary.attendance,
        grossSalary: salary.grossSalary,
        perDaySalary: salary.perDaySalary,
        perHourRate: salary.perHourRate || 0,
        payableDays: salary.payableDays,
        deductions: salary.deductions,
        reimbursements: salary.reimbursements || { total: 0, count: 0, details: [] },
        travel: salary.travel || { perDayAllowance: 0, railwayPass: 0, total: 0 },
        overtime: {
          hours: salary.overtime?.hours || 0,
          rate: salary.overtime?.rate || 0,
          multiplier: salary.overtime?.multiplier || 1.0,
          total: salary.overtime?.total || 0,
        },
        otherAmount: salary.otherAmount || 0,
        otherAmountType: salary.otherAmountType || 'earning',
        netSalary: salary.netSalary,
        paymentStatus: 'pending',
        generatedBy: req.user.id,
        generatedAt: new Date(),
      };

      bulkOps.push({
        updateOne: {
          filter: { user: salary.userId, month: monthNum, year: yearNum },
          update: { $set: slipData },
          upsert: true,
        },
      });
      created.push({ userId: salary.userId, name: salary.name });
    }

    if (bulkOps.length > 0) {
      await SalarySlip.bulkWrite(bulkOps);
    }

    res.json({
      message: `Generated ${created.length} salary slip(s)`,
      created: created.length,
      skipped: skipped.length,
      errors: errors.length,
      skippedSlips: skipped,
      errorDetails: errors,
    });
  } catch (err) {
    console.error('Error generating salary slips:', err);
    res.status(500).json({ message: 'Failed to generate salary slips', error: err.message });
  }
});

// PATCH - Update payment status
router.patch('/:id/payment', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { paymentStatus, paymentDate, paymentMethod, paymentReference, paymentNotes } = req.body;

    const updateData = {};
    if (paymentStatus) updateData.paymentStatus = paymentStatus;
    if (paymentDate) updateData.paymentDate = paymentDate;
    if (paymentMethod) updateData.paymentMethod = paymentMethod;
    if (paymentReference) updateData.paymentReference = paymentReference;
    if (paymentNotes !== undefined) updateData.paymentNotes = paymentNotes;

    if (paymentStatus === 'paid') {
      updateData.locked = true;
      if (!paymentDate) updateData.paymentDate = new Date();
    }

    const slip = await SalarySlip.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true }
    ).populate('user', 'name username employeeId');

    if (!slip) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    res.json({ message: 'Payment status updated successfully', slip });
  } catch (err) {
    console.error('Error updating payment status:', err);
    res.status(500).json({ message: 'Failed to update payment status', error: err.message });
  }
});

// PATCH - Lock/unlock slip
router.patch('/:id/lock', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { locked } = req.body;

    const slip = await SalarySlip.findByIdAndUpdate(
      req.params.id,
      { $set: { locked: locked === true } },
      { new: true }
    ).populate('user', 'name username employeeId');

    if (!slip) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    res.json({ message: `Salary slip ${locked ? 'locked' : 'unlocked'} successfully`, slip });
  } catch (err) {
    console.error('Error locking/unlocking slip:', err);
    res.status(500).json({ message: 'Failed to lock/unlock slip', error: err.message });
  }
});

// DELETE - Delete salary slip
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const slip = await SalarySlip.findById(req.params.id);

    if (!slip) {
      return res.status(404).json({ message: 'Salary slip not found' });
    }

    if (slip.locked) {
      return res.status(400).json({ message: 'Cannot delete a locked salary slip' });
    }

    if (slip.paymentStatus === 'paid') {
      return res.status(400).json({ message: 'Cannot delete a paid salary slip' });
    }

    await SalarySlip.findByIdAndDelete(req.params.id);

    res.json({ message: 'Salary slip deleted successfully' });
  } catch (err) {
    console.error('Error deleting salary slip:', err);
    res.status(500).json({ message: 'Failed to delete salary slip', error: err.message });
  }
});

export default router;
