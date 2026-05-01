import User from '../models/User.js';
import Attendance from '../models/Attendance.js';
import Leave from '../models/Leave.js';
import Reimbursement from '../models/Reimbursement.js';
import HolidayCalendar from '../models/HolidayCalendar.js';
import SalaryPolicy from '../models/SalaryPolicy.js';

// Returns Set of 'YYYY-MM-DD' strings for ACTIVE holidays in the given month.
// DB is the single source of truth — system holidays are synced into DB by the
// holiday API on first admin view, so salary respects admin deactivations.
async function getHolidaySet(year, month) {
  const startDate = new Date(year, month - 1, 1);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);

  const dbHolidays = await HolidayCalendar.find({
    date: { $gte: startDate, $lte: endDate },
    isActive: true,
  }).lean();

  return new Set(dbHolidays.map(h => new Date(h.date).toISOString().split('T')[0]));
}

// Salary policy (singleton — get first doc or return defaults)
async function getSalaryPolicy() {
  const policy = await SalaryPolicy.findOne().lean();
  return policy || {
    holidayPaidLeaveEligibleRoles: ['staff', 'supervisor'],
    sundayHolidayExcludedRoles: ['labour'],
    overtimeEligibleRoles: ['staff', 'supervisor', 'subcontractor', 'labour'],
  };
}

// Returns total working days (excluding Sundays for non-labour, all days for labour)
function getWorkingDaysInMonth(year, month, isLabour, holidaySet) {
  const daysInMonth = new Date(year, month, 0).getDate();
  let workingDays = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(year, month - 1, day);
    const dayOfWeek = d.getDay();
    const dateKey = d.toISOString().split('T')[0];
    if (!isLabour && dayOfWeek === 0) continue; // Sunday off for non-labour
    if (!isLabour && holidaySet.has(dateKey)) continue; // holidays off for non-labour
    workingDays++;
  }
  return workingDays;
}

// Calculate gross monthly salary regardless of salary type (needed for overtime formula)
function getGrossMonthly(user) {
  if (!user.ctcAmount || user.ctcAmount <= 0) return 0;
  switch (user.salaryType) {
    case 'monthly': return user.ctcAmount / 12;
    case 'weekly': return (user.ctcAmount / 52) * 4.33;
    case 'daily': return user.ctcAmount * 30; // normalized monthly for overtime
    default: return user.ctcAmount / 12;
  }
}

// Compute attendance summary for a single user from pre-loaded data
function computeAttendance({ year, month, userAttendance, userLeaves, isLabour, holidaySet, holidayPaidLeave, policy }) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const workingDays = getWorkingDaysInMonth(year, month, isLabour, holidaySet);

  let presentDays = 0;
  let absentDays = 0;
  let halfDays = 0;
  let paidLeaveDays = 0;
  let unpaidLeaveDays = 0;
  let sickLeaveDays = 0;
  let casualLeaveDays = 0;
  let weekOffs = 0;
  let publicHolidayDays = 0;
  let totalHoursWorked = 0;
  let totalOvertimeHours = 0;
  let travelEligibleDays = 0; // present + half days (full travel for half-day)

  const attendanceByDate = {};
  userAttendance.forEach(record => {
    const dateKey = new Date(record.date).toISOString().split('T')[0];
    if (!attendanceByDate[dateKey]) attendanceByDate[dateKey] = [];
    attendanceByDate[dateKey].push(record);
  });

  for (let day = 1; day <= daysInMonth; day++) {
    const currentDate = new Date(year, month - 1, day);
    const dateKey = currentDate.toISOString().split('T')[0];
    const dayOfWeek = currentDate.getDay();

    // Sunday logic
    if (dayOfWeek === 0 && !isLabour) {
      weekOffs++;
      continue;
    }

    // Public holiday logic
    if (holidaySet.has(dateKey) && !isLabour) {
      publicHolidayDays++;
      if (holidayPaidLeave) {
        paidLeaveDays++; // eligible role gets paid holiday
      } else {
        // Not eligible — treat as absent for deduction purposes
        absentDays++;
      }
      continue;
    }

    const dayRecords = attendanceByDate[dateKey] || [];

    // Check for leave
    const leave = userLeaves.find(l => {
      const leaveStart = new Date(l.startDate);
      const leaveEnd = new Date(l.endDate);
      return currentDate >= leaveStart && currentDate <= leaveEnd;
    });

    if (leave) {
      if (leave.type === 'paid') paidLeaveDays++;
      else if (leave.type === 'unpaid') unpaidLeaveDays++;
      else if (leave.type === 'sick') sickLeaveDays++;
      else if (leave.type === 'casual') casualLeaveDays++;
      continue;
    }

    // Attendance punches
    const punchIns = dayRecords.filter(r => r.punchType === 'in');
    const punchOuts = dayRecords.filter(r => r.punchType === 'out');

    if (punchIns.length === 0 && punchOuts.length === 0) {
      absentDays++;
    } else if (punchIns.length > 0 && punchOuts.length > 0) {
      const firstIn = new Date(punchIns[0].createdAt);
      const lastOut = new Date(punchOuts[punchOuts.length - 1].createdAt);
      const durationMinutes = (lastOut - firstIn) / (1000 * 60);
      const durationHours = durationMinutes / 60;

      totalHoursWorked += durationHours;
      const dailyOvertimeHours = Math.max(0, durationHours - 9);
      totalOvertimeHours += dailyOvertimeHours;

      if (durationMinutes >= 480) {
        presentDays++;
        travelEligibleDays++; // full travel
      } else if (durationMinutes >= 240) {
        halfDays++;
        travelEligibleDays++; // full travel even for half day (per spec 11.4)
      } else {
        absentDays++;
      }
    } else {
      halfDays++;
      travelEligibleDays++; // half day still gets travel
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
    publicHolidayDays,
    totalDays: daysInMonth,
    totalHoursWorked: Math.round(totalHoursWorked * 100) / 100,
    totalOvertimeHours: Math.round(totalOvertimeHours * 100) / 100,
    travelEligibleDays,
  };
}

// Main exported function
export async function calculateSalaryForPeriod({ month, year, role, userId }) {
  const monthNum = parseInt(month);
  const yearNum = parseInt(year);

  // Admins are never on payroll — excluded unconditionally
  const userQuery = { role: { $ne: 'admin' } };
  if (role && role.toLowerCase() !== 'admin') userQuery.role = role.toLowerCase();
  if (userId) userQuery._id = userId;

  const users = await User.find(userQuery)
    .populate('project', 'name')
    .populate('assignedBranches', 'name')
    .lean();

  if (users.length === 0) return [];

  const startDate = new Date(yearNum, monthNum - 1, 1);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59, 999);
  const userIds = users.map(u => u._id);

  // Bulk load all data
  const [allAttendance, allLeaves, allReimbursements, holidaySet, policy] = await Promise.all([
    Attendance.find({
      user: { $in: userIds },
      date: { $gte: startDate, $lte: endDate },
    }).lean(),
    Leave.find({
      user: { $in: userIds },
      status: 'approved',
      $or: [
        { startDate: { $gte: startDate, $lte: endDate } },
        { endDate: { $gte: startDate, $lte: endDate } },
        { $and: [{ startDate: { $lte: startDate } }, { endDate: { $gte: endDate } }] },
      ],
    }).lean(),
    Reimbursement.find({
      user: { $in: userIds },
      status: { $in: ['approved', 'paid'] },
      submittedAt: { $gte: startDate, $lte: endDate },
    }).lean(),
    getHolidaySet(yearNum, monthNum),
    getSalaryPolicy(),
  ]);

  // Group by user
  const attendanceByUser = {};
  const leavesByUser = {};
  const reimbursementsByUser = {};

  allAttendance.forEach(r => {
    const uid = r.user.toString();
    if (!attendanceByUser[uid]) attendanceByUser[uid] = [];
    attendanceByUser[uid].push(r);
  });

  allLeaves.forEach(l => {
    const uid = l.user.toString();
    if (!leavesByUser[uid]) leavesByUser[uid] = [];
    leavesByUser[uid].push(l);
  });

  allReimbursements.forEach(r => {
    const uid = r.user.toString();
    if (!reimbursementsByUser[uid]) {
      reimbursementsByUser[uid] = { total: 0, count: 0, details: [] };
    }
    reimbursementsByUser[uid].total += r.totalAmount;
    reimbursementsByUser[uid].count += 1;
    reimbursementsByUser[uid].details.push({
      id: r._id,
      amount: r.totalAmount,
      status: r.status,
      submittedAt: r.submittedAt,
    });
  });

  const salaryData = [];

  for (const user of users) {
    const uid = user._id.toString();
    const isLabour = user.role === 'labour';
    const holidayPaidLeave = policy.holidayPaidLeaveEligibleRoles.includes(user.role);
    const overtimeEligible = (policy.overtimeEligibleRoles || []).includes(user.role);

    const userAttendance = attendanceByUser[uid] || [];
    const userLeaves = leavesByUser[uid] || [];

    const attendance = computeAttendance({
      year: yearNum,
      month: monthNum,
      userAttendance,
      userLeaves,
      isLabour,
      holidaySet,
      holidayPaidLeave,
      policy,
    });

    // Paid leave cap (max 4 per month)
    const MAX_PAID_LEAVES = 4;
    const totalPaidType = attendance.paidLeaveDays + attendance.sickLeaveDays + attendance.casualLeaveDays;
    const extraPaid = Math.max(0, totalPaidType - MAX_PAID_LEAVES);
    const effectivePaidLeaveDays = totalPaidType - extraPaid;
    const effectiveUnpaidLeaveDays = attendance.unpaidLeaveDays + extraPaid;

    // Gross salary
    let grossSalary = 0;
    let perDaySalary = 0;
    const grossMonthly = getGrossMonthly(user); // always monthly equivalent

    if (user.ctcAmount && user.ctcAmount > 0) {
      switch (user.salaryType) {
        case 'monthly':
          grossSalary = user.ctcAmount / 12;
          perDaySalary = attendance.workingDays > 0 ? grossSalary / attendance.workingDays : 0;
          break;
        case 'weekly':
          grossSalary = (user.ctcAmount / 52) * 4.33;
          perDaySalary = attendance.workingDays > 0 ? grossSalary / attendance.workingDays : 0;
          break;
        case 'daily':
          perDaySalary = user.ctcAmount;
          grossSalary = perDaySalary * attendance.workingDays;
          break;
        default:
          grossSalary = user.ctcAmount / 12;
          perDaySalary = attendance.workingDays > 0 ? grossSalary / attendance.workingDays : 0;
      }
    }

    // Travel allowance — full travel for present + half days, no travel on holidays (11.4)
    const travelAllowance = (user.perDayTravelAllowance || 0) * attendance.travelEligibleDays;
    const railwayPass = user.railwayPassAmount || 0;
    const totalTravelAllowance = travelAllowance + railwayPass;

    // Reimbursements from bulk map
    const reimbSummary = reimbursementsByUser[uid] || { total: 0, count: 0, details: [] };

    // Overtime — only for eligible roles per policy
    const overtimeMultiplier = user.overtimeRateMultiplier || 1.0;
    const overtimeBaseHourly = (overtimeEligible && grossMonthly > 0) ? grossMonthly / 30 / 9 : 0;
    const overtimeTotal = overtimeEligible ? Math.round(attendance.totalOvertimeHours * overtimeBaseHourly * overtimeMultiplier) : 0;
    const perHourRate = Math.round(overtimeBaseHourly);

    // Deductions
    const absentDeduction = attendance.absentDays * perDaySalary;
    const halfDayDeduction = attendance.halfDays * (perDaySalary * 0.5);
    const unpaidLeaveDeduction = effectiveUnpaidLeaveDays * perDaySalary;
    const totalDeductions = absentDeduction + halfDayDeduction + unpaidLeaveDeduction;

    // Other amount (11.3)
    const otherAmount = user.otherAmount || 0;
    const otherAmountType = user.otherAmountType || 'earning';
    const otherAdjustment = otherAmountType === 'deduction' ? -otherAmount : otherAmount;

    // Net salary
    const netSalary =
      grossSalary
      - totalDeductions
      + reimbSummary.total
      + totalTravelAllowance
      + overtimeTotal
      + otherAdjustment;

    const payableDays =
      attendance.presentDays +
      attendance.halfDays * 0.5 +
      effectivePaidLeaveDays;

    salaryData.push({
      userId: user._id,
      name: user.name,
      username: user.username,
      employeeId: user.employeeId || '-',
      role: user.role,
      department: user.department || '-',
      jobTitle: user.jobTitle || '',
      ctcAmount: user.ctcAmount || 0,
      salaryType: user.salaryType || 'monthly',
      perDayTravelAllowance: user.perDayTravelAllowance || 0,
      railwayPassAmount: user.railwayPassAmount || 0,
      standardDailyHours: user.standardDailyHours || 9,
      overtimeRateMultiplier: overtimeMultiplier,
      otherAmount,
      otherAmountType,
      grossSalary: Math.round(grossSalary),
      perDaySalary: Math.round(perDaySalary),
      perHourRate,
      attendance: {
        ...attendance,
        effectivePaidLeaveDays,
        effectiveUnpaidLeaveDays,
      },
      payableDays: Math.round(payableDays * 10) / 10,
      deductions: {
        absent: Math.round(absentDeduction),
        halfDay: Math.round(halfDayDeduction),
        unpaidLeave: Math.round(unpaidLeaveDeduction),
        total: Math.round(totalDeductions),
      },
      reimbursements: {
        total: Math.round(reimbSummary.total),
        count: reimbSummary.count,
        details: reimbSummary.details,
      },
      travel: {
        perDayAllowance: Math.round(travelAllowance),
        railwayPass: Math.round(railwayPass),
        total: Math.round(totalTravelAllowance),
      },
      overtime: {
        hours: attendance.totalOvertimeHours,
        rate: perHourRate,
        multiplier: overtimeMultiplier,
        total: overtimeTotal,  // KEY FIX: use 'total' not 'pay'
      },
      netSalary: Math.round(netSalary),
      month: monthNum,
      year: yearNum,
    });
  }

  return salaryData;
}
