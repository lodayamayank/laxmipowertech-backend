import express from 'express';
import User from '../models/User.js';
import Project from '../models/Project.js';
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

// GET /overview — branch-based labour overview
router.get('/overview', authMiddleware, async (req, res) => {
  try {
    const now = new Date();
    const targetMonth = toNumber(req.query.month, now.getMonth() + 1);
    const targetYear = toNumber(req.query.year, now.getFullYear());
    const branchId = req.query.branchId || null;
    const projectId = req.query.projectId || null;
    const historyMonths = (() => {
      const parsed = toNumber(req.query.historyMonths, 6);
      if (!parsed || parsed < 1) return 6;
      return Math.min(parsed, 12);
    })();

    // Build query — branch is primary filter, project is secondary
    const labourQuery = { role: 'labour' };
    if (branchId) {
      labourQuery.assignedBranches = branchId;
    }
    if (projectId) {
      labourQuery.project = projectId;
    }

    const labourDocs = await User.find(labourQuery)
      .populate('project', 'name _id')
      .populate('assignedBranches', 'name _id')
      .lean();

    if (!labourDocs.length) {
      return res.json({
        success: true,
        data: [],
        summary: {
          totalLabours: 0,
          totalSalary: 0,
          totalPaid: 0,
          totalPending: 0,
        },
        filters: { month: targetMonth, year: targetYear, branchId, projectId },
      });
    }

    const labourIds = labourDocs.map((l) => l._id);
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
      if (!slipsByUser.has(key)) slipsByUser.set(key, []);
      slipsByUser.get(key).push(slip);
    });

    const summary = { totalLabours: labourDocs.length, totalSalary: 0, totalPaid: 0, totalPending: 0 };

    // Group by branch (primary key)
    const groupMap = new Map();

    labourDocs.forEach((labour) => {
      const userId = labour._id.toString();
      const monthlySalary = toNumber(labour.ctcAmount);
      const workingHours = labour.standardDailyHours || null;
      const jobRole = labour.jobTitle || 'Labour';
      const projectDoc = labour.project;
      const projectName = projectDoc?.name || 'Unassigned';
      const projectIdVal = projectDoc?._id?.toString?.() || null;
      const joiningDate = labour.dateOfJoining || labour.createdAt || null;

      // Salary slip for this period
      const userSlips = slipsByUser.get(userId) || [];
      const monthlySlip = userSlips.find(
        (s) => s.month === targetMonth && s.year === targetYear,
      );

      let paidAmount = 0;
      let pendingAmount = 0;
      let paymentStatus = 'not_generated';

      if (monthlySlip) {
        const netSalary = toNumber(monthlySlip.netSalary, monthlySalary);
        if (monthlySlip.paymentStatus === 'paid') {
          paidAmount = netSalary;
          paymentStatus = 'paid';
        } else {
          pendingAmount = netSalary;
          paymentStatus = monthlySlip.paymentStatus || 'pending';
        }
      } else {
        pendingAmount = monthlySalary;
        paymentStatus = monthlySalary ? 'pending' : 'not_configured';
      }

      summary.totalSalary += monthlySalary;
      summary.totalPaid += paidAmount;
      summary.totalPending += pendingAmount;

      const labourEntry = {
        id: labour._id,
        name: labour.name,
        username: labour.username,
        role: jobRole,
        projectName,
        projectId: projectIdVal,
        workingHours,
        monthlySalary,
        paidAmount,
        pendingAmount,
        paymentStatus,
        dateOfJoining: joiningDate,
        salaryHistory: formatHistory(userSlips, historyMonths),
      };

      // A labour may belong to multiple branches — create an entry in each branch group
      const branches = Array.isArray(labour.assignedBranches) && labour.assignedBranches.length > 0
        ? labour.assignedBranches
        : [null];

      branches.forEach((branchDoc) => {
        const bId = branchDoc?._id?.toString?.() || 'unassigned';
        const bName = branchDoc?.name || 'Unassigned Branch';

        if (!groupMap.has(bId)) {
          groupMap.set(bId, {
            branchId: branchDoc?._id || null,
            branchName: bName,
            totalLabours: 0,
            totalSalary: 0,
            totalPaid: 0,
            totalPending: 0,
            labours: [],
          });
        }

        const group = groupMap.get(bId);
        group.totalLabours += 1;
        group.totalSalary += monthlySalary;
        group.totalPaid += paidAmount;
        group.totalPending += pendingAmount;
        group.labours.push({ ...labourEntry, branchName: bName });
      });
    });

    const groups = Array.from(groupMap.values());

    res.json({
      success: true,
      data: groups,
      summary,
      filters: { month: targetMonth, year: targetYear, branchId, projectId },
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

// GET /projects-by-branch/:branchId — projects linked to a specific branch
router.get('/projects-by-branch/:branchId', authMiddleware, async (req, res) => {
  try {
    const { branchId } = req.params;
    const projects = await Project.find({ branches: branchId }).select('name _id').lean();
    res.json({ success: true, data: projects });
  } catch (error) {
    console.error('Projects by branch error:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch projects for branch' });
  }
});

export default router;
