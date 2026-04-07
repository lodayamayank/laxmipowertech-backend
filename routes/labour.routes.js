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
      .populate('assignedBranches', 'name _id')
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
      totalSalary: 0,
      totalPaid: 0,
      totalPending: 0,
    };

    const labours = labourDocs.map((labour) => {
      const userId = labour._id.toString();
      const salaryType = labour.salaryType || 'monthly';
      const monthlySalary = toNumber(labour.ctcAmount);
      const workingHours = labour.standardDailyHours || null;
      const jobRole = labour.jobTitle || (labour.role === 'labour' ? 'Labour' : labour.role);
      const project = labour.project
        ? { id: labour.project._id?.toString?.() || labour.project._id, name: labour.project.name }
        : null;
      const branchDocs = Array.isArray(labour.assignedBranches) ? labour.assignedBranches : [];
      const primaryBranchDoc = branchDocs.length > 0 ? branchDocs[0] : null;
      const branchNames = branchDocs.map((branch) => branch?.name).filter(Boolean);
      const branch = primaryBranchDoc
        ? {
            id: primaryBranchDoc._id?.toString?.() || primaryBranchDoc._id,
            name: primaryBranchDoc.name,
          }
        : null;
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

      summary.totalSalary += monthlySalary;
      summary.totalPaid += paidThisPeriod;
      summary.totalPending += pendingThisPeriod;

      return {
        id: labour._id,
        name: labour.name,
        username: labour.username,
        role: jobRole,
        project,
        branch,
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

    const groupMap = new Map();

    labours.forEach((labour) => {
      const projectIdKey = labour.project?.id?.toString?.() || 'unassigned-project';
      const projectName = labour.project?.name || 'Unassigned Project';
      const branchIdKey = labour.branch?.id?.toString?.() || 'unassigned-branch';
      const branchName = labour.branch?.name || 'Unassigned Branch';
      const mapKey = `${projectIdKey}::${branchIdKey}`;

      if (!groupMap.has(mapKey)) {
        groupMap.set(mapKey, {
          projectId: labour.project?.id || null,
          projectName,
          branchId: labour.branch?.id || null,
          branchName,
          totalLabours: 0,
          totalSalary: 0,
          totalPaid: 0,
          totalPending: 0,
          labours: [],
        });
      }

      const group = groupMap.get(mapKey);
      group.totalLabours += 1;
      group.totalSalary += labour.monthlySalary;
      group.totalPaid += labour.paidThisPeriod;
      group.totalPending += labour.pendingThisPeriod;
      group.labours.push({
        id: labour.id,
        name: labour.name,
        username: labour.username,
        role: labour.role,
        project: projectName,
        branch: branchName,
        workingHours: labour.workingHours,
        monthlySalary: labour.monthlySalary,
        paidAmount: labour.paidThisPeriod,
        pendingAmount: labour.pendingThisPeriod,
        paymentStatus: labour.paymentStatus,
        dateOfJoining: labour.dateOfJoining,
        salaryHistory: labour.salaryHistory,
      });
    });

    const groups = Array.from(groupMap.values()).map((group) => ({
      ...group,
      totalSalary: Number(group.totalSalary || 0),
      totalPaid: Number(group.totalPaid || 0),
      totalPending: Number(group.totalPending || 0),
    }));

    res.json({
      success: true,
      data: groups,
      summary,
      filters: {
        month: targetMonth,
        year: targetYear,
        projectId,
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
