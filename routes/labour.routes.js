import express from 'express';
import User from '../models/User.js';
import SalarySlip from '../models/SalarySlip.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

const toNumber = (value, fallback = 0) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const formatHistory = (slips, limit) => {
  return slips
    .sort((a, b) => {
      if (a.year === b.year) return b.month - a.month;
      return b.year - a.year;
    })
    .slice(0, limit)
    .map((slip) => ({
      id: slip._id,
      month: slip.month,
      year: slip.year,
      netSalary: toNumber(slip.netSalary),
      paymentStatus: slip.paymentStatus || 'pending',
      paymentDate: slip.paymentDate || null,
      generatedAt: slip.generatedAt || null,
    }));
};

router.get('/overview', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const targetMonth = toNumber(req.query.month, now.getMonth() + 1);
    const targetYear = toNumber(req.query.year, now.getFullYear());
    const projectId = req.query.projectId || null;
    const historyMonths = (() => {
      const parsed = toNumber(req.query.historyMonths, 6);
      if (!parsed || parsed < 1) return 6;
      return Math.min(parsed, 12);
    })();

    const labourQuery = { role: 'labour' };
    if (projectId) {
      labourQuery.project = projectId;
    }

    const labourDocs = await User.find(labourQuery)
      .populate('project', 'name _id')
      .populate('assignedBranches', 'name')
      .lean();

    if (!labourDocs.length) {
      return res.json({
        success: true,
        data: {
          summary: {
            totalLabours: 0,
            totalMonthlySalary: 0,
            paidThisPeriod: 0,
            pendingThisPeriod: 0,
          },
          filters: {
            month: targetMonth,
            year: targetYear,
            projectId,
          },
          labours: [],
        },
      });
    }

    const labourIds = labourDocs.map((labour) => labour._id);
    const minimumYear = targetYear - 1;

    const salarySlips = await SalarySlip.find({
      user: { $in: labourIds },
      year: { $gte: minimumYear },
    })
      .sort({ year: -1, month: -1 })
      .lean();

    const slipsByUser = new Map();
    salarySlips.forEach((slip) => {
      const key = (slip.user?._id || slip.user).toString();
      if (!slipsByUser.has(key)) {
        slipsByUser.set(key, []);
      }
      slipsByUser.get(key).push(slip);
    });

    const summary = {
      totalLabours: labourDocs.length,
      totalMonthlySalary: 0,
      paidThisPeriod: 0,
      pendingThisPeriod: 0,
    };

    const labours = labourDocs.map((labour) => {
      const userId = labour._id.toString();
      const salaryType = labour.salaryType || 'monthly';
      const monthlySalary = toNumber(labour.ctcAmount);
      const workingHours = labour.standardDailyHours || null;
      const jobRole = labour.jobTitle || (labour.role === 'labour' ? 'Labour' : labour.role);
      const project = labour.project
        ? { id: labour.project._id, name: labour.project.name }
        : null;
      const branchNames = Array.isArray(labour.assignedBranches)
        ? labour.assignedBranches.map((branch) => branch?.name).filter(Boolean)
        : [];
      const joiningDate = labour.dateOfJoining || labour.createdAt || null;

      const userSlips = slipsByUser.get(userId) || [];
      const monthlySlip = userSlips.find(
        (slip) => slip.month === targetMonth && slip.year === targetYear,
      );

      let paidThisPeriod = 0;
      let pendingThisPeriod = 0;
      let paymentStatus = 'not_generated';

      if (monthlySlip) {
        const netSalary = toNumber(monthlySlip.netSalary, monthlySalary);
        if (monthlySlip.paymentStatus === 'paid') {
          paidThisPeriod = netSalary;
          pendingThisPeriod = 0;
          paymentStatus = 'paid';
        } else {
          paidThisPeriod = 0;
          pendingThisPeriod = netSalary;
          paymentStatus = monthlySlip.paymentStatus || 'pending';
        }
      } else {
        paidThisPeriod = 0;
        pendingThisPeriod = monthlySalary;
        paymentStatus = monthlySalary ? 'pending' : 'not_configured';
      }

      summary.totalMonthlySalary += monthlySalary;
      summary.paidThisPeriod += paidThisPeriod;
      summary.pendingThisPeriod += pendingThisPeriod;

      return {
        id: labour._id,
        name: labour.name,
        username: labour.username,
        role: jobRole,
        project,
        branchNames,
        salaryType,
        workingHours,
        monthlySalary,
        paidThisPeriod,
        pendingThisPeriod,
        paymentStatus,
        dateOfJoining: joiningDate,
        salaryHistory: formatHistory(userSlips, historyMonths),
      };
    });

    res.json({
      success: true,
      data: {
        summary,
        filters: {
          month: targetMonth,
          year: targetYear,
          projectId,
        },
        labours,
      },
    });
  } catch (error) {
    console.error('Labour overview error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch labour overview',
      error: error.message,
    });
  }
});

export default router;
