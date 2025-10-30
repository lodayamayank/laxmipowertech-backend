import express from 'express';
import User from '../models/User.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import authMiddleware from '../middleware/authMiddleware.js';
import mongoose from 'mongoose';

const router = express.Router();

/**
 * Calculate salary for a user based on CTC, attendance, and leaves
 * Formula:
 * - Monthly Salary = CTC / 12 (for monthly)
 * - Daily Salary = Monthly Salary / Working Days in Month
 * - Deductions = (Absent Days + Unpaid Leave Days) * Daily Salary
 * - Net Salary = Gross Salary - Deductions
 */

// Helper function to calculate working days in a month (excluding Sundays)
function getWorkingDaysInMonth(year, month) {
  const daysInMonth = new Date(year, month, 0).getDate();
  let workingDays = 0;
  
  for (let day = 1; day <= daysInMonth; day++) {
    const date = new Date(year, month - 1, day);
    if (date.getDay() !== 0) { // Exclude Sundays
      workingDays++;
    }
  }
  
  return workingDays;
}

// Helper function to get attendance summary for a user
async function getAttendanceSummary(userId, year, month) {
  const startDate = new Date(year, month - 1, 1);
  startDate.setHours(0, 0, 0, 0);
  
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);

  // Get all attendance records for the month
  const attendanceRecords = await Attendance.find({
    user: userId,
    date: { $gte: startDate, $lte: endDate }
  }).populate('leaveId', 'type').lean();

  // Get approved leaves for the month
  const leaves = await Leave.find({
    user: userId,
    status: 'approved',
    $or: [
      { startDate: { $gte: startDate, $lte: endDate } },
      { endDate: { $gte: startDate, $lte: endDate } },
      { $and: [{ startDate: { $lte: startDate } }, { endDate: { $gte: endDate } }] }
    ]
  }).lean();

  // Calculate days
  const daysInMonth = new Date(year, month, 0).getDate();
  const workingDays = getWorkingDaysInMonth(year, month);
  
  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  let sickLeaveDays = 0;
  let casualLeaveDays = 0;
  let weekOffs = 0;

  // Create a map of dates for quick lookup
  const attendanceByDate = {};
  attendanceRecords.forEach(record => {
    const dateKey = new Date(record.date).toISOString().split('T')[0];
    if (!attendanceByDate[dateKey]) {
      attendanceByDate[dateKey] = [];
    }
    attendanceByDate[dateKey].push(record);
  });

  
  for (let day = 1; day <= daysInMonth; day++) {
    const currentDate = new Date(year, month - 1, day);
    const dateKey = currentDate.toISOString().split('T')[0];
    const dayOfWeek = currentDate.getDay();

    // Check if it's a Sunday (week off)
    if (dayOfWeek === 0) {
      weekOffs++;
      continue;
    }

    const dayRecords = attendanceByDate[dateKey] || [];

    // Check for leave
    const isOnLeave = leaves.some(leave => {
      const leaveStart = new Date(leave.startDate);
      const leaveEnd = new Date(leave.endDate);
      return currentDate >= leaveStart && currentDate <= leaveEnd;
    });

    if (isOnLeave) {
      const leave = leaves.find(l => {
        const leaveStart = new Date(l.startDate);
        const leaveEnd = new Date(l.endDate);
        return currentDate >= leaveStart && currentDate <= leaveEnd;
      });
      
      if (leave.type === 'paid') paidLeaveDays++;
      else if (leave.type === 'unpaid') unpaidLeaveDays++;
      else if (leave.type === 'sick') sickLeaveDays++;
      else if (leave.type === 'casual') casualLeaveDays++;
      continue;
    }

    // Check attendance punches
    const punchIns = dayRecords.filter(r => r.punchType === 'in');
    const punchOuts = dayRecords.filter(r => r.punchType === 'out');

    if (punchIns.length === 0 && punchOuts.length === 0) {
      absentDays++;
    } else if (punchIns.length > 0 && punchOuts.length > 0) {
      // Calculate work duration
      const firstIn = new Date(punchIns[0].createdAt);
      const lastOut = new Date(punchOuts[punchOuts.length - 1].createdAt);
      const duration = (lastOut - firstIn) / (1000 * 60); // minutes

      if (duration >= 480) { // 8 hours
        presentDays++;
      } else if (duration >= 240) { // 4 hours
        halfDays++;
      } else {
        absentDays++;
      }
    } else {
      halfDays++;
    }
  }

  return {
    workingDays,
    presentDays,
    absentDays,
    halfDays,
    paidLeaveDays,
    unpaidLeaveDays,
    sickLeaveDays,
    casualLeaveDays,
    weekOffs,
    totalDays: daysInMonth
  };
}

// Helper function to calculate attendance summary from pre-loaded data
function calculateAttendanceFromData(year, month, attendanceRecords, leaves) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const workingDays = getWorkingDaysInMonth(year, month);
  
  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  let sickLeaveDays = 0;
  let casualLeaveDays = 0;
  let weekOffs = 0;

  // Create a map of dates for quick lookup
  const attendanceByDate = {};
  attendanceRecords.forEach(record => {
    const dateKey = new Date(record.date).toISOString().split('T')[0];
    if (!attendanceByDate[dateKey]) {
      attendanceByDate[dateKey] = [];
    }
    attendanceByDate[dateKey].push(record);
  });

  
  for (let day = 1; day <= daysInMonth; day++) {
    const currentDate = new Date(year, month - 1, day);
    const dateKey = currentDate.toISOString().split('T')[0];
    const dayOfWeek = currentDate.getDay();

    // Check if it's a Sunday (week off)
    if (dayOfWeek === 0) {
      weekOffs++;
      continue;
    }

    const dayRecords = attendanceByDate[dateKey] || [];

    // Check for leave
    const isOnLeave = leaves.some(leave => {
      const leaveStart = new Date(leave.startDate);
      const leaveEnd = new Date(leave.endDate);
      return currentDate >= leaveStart && currentDate <= leaveEnd;
    });

    if (isOnLeave) {
      const leave = leaves.find(l => {
        const leaveStart = new Date(l.startDate);
        const leaveEnd = new Date(l.endDate);
        return currentDate >= leaveStart && currentDate <= leaveEnd;
      });
      
      if (leave.type === 'paid') paidLeaveDays++;
      else if (leave.type === 'unpaid') unpaidLeaveDays++;
      else if (leave.type === 'sick') sickLeaveDays++;
      else if (leave.type === 'casual') casualLeaveDays++;
      continue;
    }

    // Check attendance punches
    const punchIns = dayRecords.filter(r => r.punchType === 'in');
    const punchOuts = dayRecords.filter(r => r.punchType === 'out');

    if (punchIns.length === 0 && punchOuts.length === 0) {
      absentDays++;
    } else if (punchIns.length > 0 && punchOuts.length > 0) {
      // Calculate work duration
      const firstIn = new Date(punchIns[0].createdAt);
      const lastOut = new Date(punchOuts[punchOuts.length - 1].createdAt);
      const duration = (lastOut - firstIn) / (1000 * 60); // minutes

      if (duration >= 480) { // 8 hours
        presentDays++;
      } else if (duration >= 240) { // 4 hours
        halfDays++;
      } else {
        absentDays++;
      }
    } else {
      halfDays++;
    }
  }

  return {
    workingDays,
    presentDays,
    absentDays,
    halfDays,
    paidLeaveDays,
    unpaidLeaveDays,
    sickLeaveDays,
    casualLeaveDays,
    weekOffs,
    totalDays: daysInMonth
  };
}

// GET /api/salary/calculate - OPTIMIZED: Bulk-fetch version (3 queries instead of 44+)
router.get('/calculate', authMiddleware, async (req, res) => {
  try {
    // Only admin can access salary data
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admin only.' });
    }

    const { month, year, role, userId } = req.query;
    
    const currentDate = new Date();
    const monthNum = parseInt(month) || currentDate.getMonth() + 1;
    const yearNum = parseInt(year) || currentDate.getFullYear();

    // Build user query
    const userQuery = {};
    if (role) userQuery.role = role.toLowerCase();
    if (userId) userQuery._id = userId;

    const users = await User.find(userQuery)
      .populate('project', 'name')
      .populate('assignedBranches', 'name')
      .lean();

    if (users.length === 0) {
      return res.json([]);
    }

    // 🚀 STEP 1: Fetch ALL attendance & leave data in bulk (2 queries)
    const startDate = new Date(yearNum, monthNum - 1, 1);
    startDate.setHours(0, 0, 0, 0);
    const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
    const userIds = users.map(u => u._id);

    const [allAttendance, allLeaves] = await Promise.all([
      Attendance.find({
        user: { $in: userIds },
        date: { $gte: startDate, $lte: endDate }
      }).populate('leaveId', 'type').lean(),
      
      Leave.find({
        user: { $in: userIds },
        status: 'approved',
        $or: [
          { startDate: { $gte: startDate, $lte: endDate } },
          { endDate: { $gte: startDate, $lte: endDate } },
          { $and: [{ startDate: { $lte: startDate } }, { endDate: { $gte: endDate } }] }
        ]
      }).lean()
    ]);

    // 🚀 STEP 2: Group by user for O(1) lookup
    const attendanceByUser = {};
    const leavesByUser = {};

    allAttendance.forEach(record => {
      const uid = record.user.toString();
      if (!attendanceByUser[uid]) attendanceByUser[uid] = [];
      attendanceByUser[uid].push(record);
    });

    allLeaves.forEach(leave => {
      const uid = leave.user.toString();
      if (!leavesByUser[uid]) leavesByUser[uid] = [];
      leavesByUser[uid].push(leave);
    });

    const salaryData = [];

    // 🚀 STEP 3: Process each user WITHOUT database queries
    for (const user of users) {
      const uid = user._id.toString();
      const userAttendance = attendanceByUser[uid] || [];
      const userLeaves = leavesByUser[uid] || [];
      
      // Calculate attendance from pre-loaded data
      const attendanceSummary = calculateAttendanceFromData(
        yearNum, monthNum, userAttendance, userLeaves
      );
      
      // Calculate salary based on CTC and salary type
      let grossSalary = 0;
      let perDaySalary = 0;

      if (user.ctcAmount && user.ctcAmount > 0) {
        switch (user.salaryType) {
          case 'monthly':
            grossSalary = user.ctcAmount / 12;
            perDaySalary = grossSalary / attendanceSummary.workingDays;
            break;
          case 'weekly':
            grossSalary = (user.ctcAmount / 52) * 4.33;
            perDaySalary = grossSalary / attendanceSummary.workingDays;
            break;
          case 'daily':
            perDaySalary = user.ctcAmount;
            grossSalary = perDaySalary * attendanceSummary.workingDays;
            break;
          default:
            grossSalary = user.ctcAmount / 12;
            perDaySalary = grossSalary / attendanceSummary.workingDays;
        }
      }

      // Calculate deductions
      const absentDeduction = attendanceSummary.absentDays * perDaySalary;
      const halfDayDeduction = attendanceSummary.halfDays * (perDaySalary * 0.5);
      const unpaidLeaveDeduction = attendanceSummary.unpaidLeaveDays * perDaySalary;
      
      const totalDeductions = absentDeduction + halfDayDeduction + unpaidLeaveDeduction;
      const netSalary = grossSalary - totalDeductions;

      // Calculate payable days
      const payableDays = attendanceSummary.presentDays + 
                         (attendanceSummary.halfDays * 0.5) + 
                         attendanceSummary.paidLeaveDays +
                         attendanceSummary.sickLeaveDays +
                         attendanceSummary.casualLeaveDays;

      salaryData.push({
        userId: user._id,
        name: user.name,
        username: user.username,
        employeeId: user.employeeId || '-',
        role: user.role,
        department: user.department || '-',
        ctcAmount: user.ctcAmount || 0,
        salaryType: user.salaryType || 'monthly',
        grossSalary: Math.round(grossSalary),
        perDaySalary: Math.round(perDaySalary),
        attendance: attendanceSummary,
        payableDays: Math.round(payableDays * 10) / 10,
        deductions: {
          absent: Math.round(absentDeduction),
          halfDay: Math.round(halfDayDeduction),
          unpaidLeave: Math.round(unpaidLeaveDeduction),
          total: Math.round(totalDeductions)
        },
        netSalary: Math.round(netSalary),
        month: monthNum,
        year: yearNum
      });
    }

    res.json(salaryData);
  } catch (err) {
    console.error('Error calculating salary:', err);
    res.status(500).json({ message: 'Failed to calculate salary', error: err.message });
  }
});

// GET /api/salary/user/:userId - Get salary calculation for a specific user
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { month, year } = req.query;

    // Users can only view their own salary unless they're admin
    if (req.user.role !== 'admin' && req.user.id !== userId) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const currentDate = new Date();
    const monthNum = parseInt(month) || currentDate.getMonth() + 1;
    const yearNum = parseInt(year) || currentDate.getFullYear();

    const user = await User.findById(userId)
      .populate('project', 'name')
      .populate('assignedBranches', 'name')
      .lean();

    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const attendanceSummary = await getAttendanceSummary(userId, yearNum, monthNum);
    
    let grossSalary = 0;
    let perDaySalary = 0;

    if (user.ctcAmount && user.ctcAmount > 0) {
      switch (user.salaryType) {
        case 'monthly':
          grossSalary = user.ctcAmount / 12;
          perDaySalary = grossSalary / attendanceSummary.workingDays;
          break;
        case 'weekly':
          grossSalary = (user.ctcAmount / 52) * 4.33;
          perDaySalary = grossSalary / attendanceSummary.workingDays;
          break;
        case 'daily':
          perDaySalary = user.ctcAmount;
          grossSalary = perDaySalary * attendanceSummary.workingDays;
          break;
        default:
          grossSalary = user.ctcAmount / 12;
          perDaySalary = grossSalary / attendanceSummary.workingDays;
      }
    }

    const absentDeduction = attendanceSummary.absentDays * perDaySalary;
    const halfDayDeduction = attendanceSummary.halfDays * (perDaySalary * 0.5);
    const unpaidLeaveDeduction = attendanceSummary.unpaidLeaveDays * perDaySalary;
    
    const totalDeductions = absentDeduction + halfDayDeduction + unpaidLeaveDeduction;
    const netSalary = grossSalary - totalDeductions;

    const payableDays = attendanceSummary.presentDays + 
                       (attendanceSummary.halfDays * 0.5) + 
                       attendanceSummary.paidLeaveDays +
                       attendanceSummary.sickLeaveDays +
                       attendanceSummary.casualLeaveDays;

    res.json({
      userId: user._id,
      name: user.name,
      username: user.username,
      employeeId: user.employeeId || '-',
      role: user.role,
      department: user.department || '-',
      ctcAmount: user.ctcAmount || 0,
      salaryType: user.salaryType || 'monthly',
      grossSalary: Math.round(grossSalary),
      perDaySalary: Math.round(perDaySalary),
      attendance: attendanceSummary,
      payableDays: Math.round(payableDays * 10) / 10,
      deductions: {
        absent: Math.round(absentDeduction),
        halfDay: Math.round(halfDayDeduction),
        unpaidLeave: Math.round(unpaidLeaveDeduction),
        total: Math.round(totalDeductions)
      },
      netSalary: Math.round(netSalary),
      month: monthNum,
      year: yearNum
    });
  } catch (err) {
    console.error('Error fetching user salary:', err);
    res.status(500).json({ message: 'Failed to fetch salary', error: err.message });
  }
});

export default router;