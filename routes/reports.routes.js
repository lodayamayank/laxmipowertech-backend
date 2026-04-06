import express from 'express';
import mongoose from 'mongoose';
import protect from '../middleware/authMiddleware.js';
import Project from '../models/Project.js';
import WorkOrder from '../models/WorkOrder.js';
import Bill from '../models/Bill.js';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import User from '../models/User.js';
import SalarySlip from '../models/SalarySlip.js';

const router = express.Router();

const LABOUR_ROLES = ['labour', 'subcontractor'];

const parseMonthYear = (month, year) => {
  const now = new Date();
  const monthNum = Number.parseInt(month, 10);
  const yearNum = Number.parseInt(year, 10);

  const safeMonth = Number.isInteger(monthNum) && monthNum >= 1 && monthNum <= 12
    ? monthNum
    : now.getMonth() + 1;
  const safeYear = Number.isInteger(yearNum) && yearNum >= 2000
    ? yearNum
    : now.getFullYear();

  return { month: safeMonth, year: safeYear };
};

const getPeriodRange = (month, year) => {
  const startDate = new Date(year, month - 1, 1);
  startDate.setHours(0, 0, 0, 0);
  const endDate = new Date(year, month, 0, 23, 59, 59, 999);
  return { startDate, endDate };
};

const getWorkingDaysInMonth = (month, year) => {
  const days = new Date(year, month, 0).getDate();
  return days;
};

const estimateMonthlySalary = (user, month, year) => {
  const workingDays = getWorkingDaysInMonth(month, year);
  const ctcAmount = user.ctcAmount || 0;
  const salaryType = user.salaryType || 'monthly';

  let baseSalary = 0;
  switch (salaryType) {
    case 'daily':
      baseSalary = ctcAmount * workingDays;
      break;
    case 'weekly':
      baseSalary = (ctcAmount / 7) * workingDays;
      break;
    case 'monthly':
    default:
      baseSalary = ctcAmount / 12;
      break;
  }

  const travelAllowance = (user.perDayTravelAllowance || 0) * workingDays;
  const railwayPass = user.railwayPassAmount || 0;
  const total = Math.round(baseSalary + travelAllowance + railwayPass);

  return {
    baseSalary: Math.round(baseSalary),
    travelAllowance: Math.round(travelAllowance),
    railwayPass: Math.round(railwayPass),
    total,
  };
};

router.get('/project/:projectId', protect, async (req, res) => {
  try {
    const { projectId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(projectId)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid project ID',
      });
    }

    const { month, year } = parseMonthYear(req.query.month, req.query.year);
    const { startDate, endDate } = getPeriodRange(month, year);

    const project = await Project.findById(projectId).lean();
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found',
      });
    }

    // Work Order aggregation
    const workOrders = await WorkOrder.find({ project: projectId })
      .populate('createdBy', 'name email role')
      .sort({ workOrderDate: 1 })
      .lean();

    const workOrderIds = workOrders.map((wo) => wo._id);

    let bills = [];
    if (workOrderIds.length) {
      bills = await Bill.find({
        workOrder: { $in: workOrderIds },
        billDate: { $gte: startDate, $lte: endDate },
      })
        .sort({ billDate: 1 })
        .lean();
    }

    const billsByWorkOrder = new Map();
    bills.forEach((bill) => {
      const key = bill.workOrder.toString();
      if (!billsByWorkOrder.has(key)) {
        billsByWorkOrder.set(key, []);
      }
      billsByWorkOrder.get(key).push(bill);
    });

    const workOrderRows = workOrders.map((wo) => {
      const periodBills = billsByWorkOrder.get(wo._id.toString()) || [];
      const periodBilled = periodBills.reduce((sum, bill) => sum + (bill.totalBillValue || 0), 0);
      const retentionTotal = periodBills.reduce((sum, bill) => sum + (bill.retentionAmount || 0), 0);
      const holdingTotal = periodBills.reduce((sum, bill) => sum + (bill.holdingAmount || 0), 0);

      return {
        id: wo._id,
        workOrderNo: wo.workOrderNo,
        name: wo.workOrderName,
        workOrderDate: wo.workOrderDate,
        totalValue: wo.totalValue || 0,
        lifetimeBilled: wo.totalBillsAmount || 0,
        billedInPeriod: periodBilled,
        retentionInPeriod: retentionTotal,
        holdingInPeriod: holdingTotal,
        outstandingLifetime: Math.max((wo.totalValue || 0) - (wo.totalBillsAmount || 0), 0),
        status: wo.status,
        isTriggered: wo.isTriggered,
        createdBy: wo.createdBy
          ? {
              name: wo.createdBy.name,
              email: wo.createdBy.email,
              role: wo.createdBy.role,
            }
          : null,
        bills: periodBills.map((bill) => ({
          id: bill._id,
          billNo: bill.billNo,
          billDate: bill.billDate,
          totalBillValue: bill.totalBillValue || 0,
          retentionAmount: bill.retentionAmount || 0,
          holdingAmount: bill.holdingAmount || 0,
        })),
      };
    });

    const workOrderReportTotals = {
      totalWorkOrders: workOrders.length,
      totalWorkOrderValue: workOrders.reduce((sum, wo) => sum + (wo.totalValue || 0), 0),
      totalBilledInPeriod: bills.reduce((sum, bill) => sum + (bill.totalBillValue || 0), 0),
      totalBilledLifetime: workOrders.reduce((sum, wo) => sum + (wo.totalBillsAmount || 0), 0),
      totalRetentionInPeriod: bills.reduce((sum, bill) => sum + (bill.retentionAmount || 0), 0),
      totalHoldingInPeriod: bills.reduce((sum, bill) => sum + (bill.holdingAmount || 0), 0),
    };

    workOrderReportTotals.outstandingLifetime = Math.max(
      workOrderReportTotals.totalWorkOrderValue - workOrderReportTotals.totalBilledLifetime,
      0,
    );

    // Material (GRN) aggregation
    const deliveries = await UpcomingDelivery.find({
      project: projectId,
      'billing.finalAmount': { $gt: 0 },
    })
      .sort({ 'billing.billDate': -1, updatedAt: -1 })
      .lean();

    const materialRows = [];
    let totalMaterialPrice = 0;
    let totalMaterialDiscount = 0;
    let totalMaterialCost = 0;
    let totalMaterialQuantity = 0;

    deliveries.forEach((delivery) => {
      const billing = delivery.billing || {};
      const billDate = billing.billDate ? new Date(billing.billDate) : null;
      const referenceDate = billDate || delivery.updatedAt || delivery.createdAt;

      if (referenceDate < startDate || referenceDate > endDate) {
        return;
      }

      const totalPrice = billing.totalPrice || 0;
      const totalDiscount = billing.totalDiscount || 0;
      const finalAmount = billing.finalAmount || 0;

      totalMaterialPrice += totalPrice;
      totalMaterialDiscount += totalDiscount;
      totalMaterialCost += finalAmount;

      const itemsIndex = new Map();
      (delivery.items || []).forEach((item) => {
        if (!item) return;
        const key = item.itemId?.toString?.() || item.materialId?.toString?.();
        if (!key) return;
        itemsIndex.set(key, item);
      });

      const materialBilling = billing.materialBilling || [];

      if (materialBilling.length === 0) {
        materialRows.push({
          id: `${delivery._id}-summary`,
          materialName: '-',
          quantity: null,
          rate: null,
          totalAmount: finalAmount,
          invoiceNumber: billing.invoiceNumber || '-',
          billDate,
          transferNumber: delivery.transfer_number || delivery.st_id,
          companyName: billing.companyName || '',
          status: delivery.status,
        });
        return;
      }

      materialBilling.forEach((material) => {
        const itemRef = material.materialId ? itemsIndex.get(material.materialId.toString()) : null;
        const quantity = Number(itemRef?.quantity || itemRef?.st_quantity || 0) || null;
        const totalAmount = material.totalAmount ?? material.price ?? 0;
        const ratePerUnit = quantity ? totalAmount / quantity : null;

        if (quantity) {
          totalMaterialQuantity += quantity;
        }

        materialRows.push({
          id: `${delivery._id}_${material.materialId || material.materialName || Math.random().toString(36).slice(2)}`,
          materialName: material.materialName || itemRef?.name || 'Material',
          quantity,
          rate: ratePerUnit,
          grossAmount: material.price ?? 0,
          discount: material.discount ?? 0,
          discountType: material.discountType || 'flat',
          totalAmount,
          invoiceNumber: billing.invoiceNumber || '-',
          billDate,
          transferNumber: delivery.transfer_number || delivery.st_id,
          companyName: billing.companyName || '',
          status: delivery.status,
        });
      });
    });

    // Labour aggregation
    const labourUsers = await User.find({
      project: projectId,
      role: { $in: LABOUR_ROLES },
    })
      .select('name role employeeId ctcAmount salaryType perDayTravelAllowance railwayPassAmount')
      .lean();

    let labourRows = [];
    let totalLabourCost = 0;
    let labourDataSource = 'none';

    if (labourUsers.length) {
      const userIds = labourUsers.map((u) => u._id);
      const salarySlips = await SalarySlip.find({
        user: { $in: userIds },
        month,
        year,
      })
        .populate('user', 'name role employeeId salaryType ctcAmount perDayTravelAllowance railwayPassAmount')
        .lean();

      const slipByUser = new Map();
      salarySlips.forEach((slip) => {
        const key = (slip.user?._id || slip.user).toString();
        slipByUser.set(key, slip);
      });

      labourRows = labourUsers.map((user) => {
        const userId = user._id.toString();
        const slip = slipByUser.get(userId);

        if (slip) {
          labourDataSource = labourDataSource === 'estimated' ? 'mixed' : 'salarySlip';
          const netSalary = slip.netSalary || 0;
          totalLabourCost += netSalary;
          const attendance = slip.attendance || {};

          return {
            id: slip._id,
            userId: user._id,
            name: slip.employeeDetails?.name || user.name,
            role: slip.employeeDetails?.role || user.role,
            employeeId: slip.employeeDetails?.employeeId || user.employeeId || '-',
            salaryType: user.salaryType || 'monthly',
            grossSalary: slip.grossSalary || 0,
            netSalary,
            deductions: slip.deductions?.total || 0,
            reimbursements: slip.reimbursements?.total || 0,
            travelAllowance: slip.travel?.total || 0,
            overtimePay: slip.overtime?.pay || 0,
            presentDays: attendance.presentDays ?? null,
            payableDays: slip.payableDays ?? null,
            dataSource: 'salarySlip',
          };
        }

        const estimate = estimateMonthlySalary(user, month, year);
        totalLabourCost += estimate.total;
        labourDataSource = labourDataSource === 'salarySlip' ? 'mixed' : labourDataSource;

        return {
          id: user._id,
          userId: user._id,
          name: user.name,
          role: user.role,
          employeeId: user.employeeId || '-',
          salaryType: user.salaryType || 'monthly',
          grossSalary: estimate.baseSalary,
          netSalary: estimate.total,
          deductions: 0,
          reimbursements: 0,
          travelAllowance: estimate.travelAllowance + estimate.railwayPass,
          overtimePay: 0,
          presentDays: null,
          payableDays: null,
          dataSource: 'estimated',
        };
      });

      if (!salarySlips.length) {
        labourDataSource = 'estimated';
      } else if (salarySlips.length && labourRows.some((row) => row.dataSource === 'estimated')) {
        labourDataSource = 'mixed';
      } else {
        labourDataSource = 'salarySlip';
      }
    }

    const totalBilling = workOrderReportTotals.totalBilledInPeriod;
    const totalExpenses = totalMaterialCost + totalLabourCost;
    const profitOrLoss = totalBilling - totalExpenses;

    const responseData = {
      projectId: project._id,
      projectName: project.name,
      projectCode: project.projectCode || project.code || null,
      location: project.location || null,
      period: {
        month,
        year,
        startDate,
        endDate,
      },
      totalBilling,
      totalMaterialCost,
      totalMaterialQuantity,
      totalLabourCost,
      totalExpenses,
      profitOrLoss,
      finalAmount: profitOrLoss,
      woSummary: {
        ...workOrderReportTotals,
        period: { startDate, endDate },
      },
      materialSummary: {
        deliveriesCount: materialRows.length,
        totalMaterialPrice,
        totalMaterialDiscount,
        totalMaterialCost,
        totalMaterialQuantity,
        period: { startDate, endDate },
      },
      labourSummary: {
        labourCount: labourUsers.length,
        totalLabourCost,
        dataSource: labourDataSource,
        period: { startDate, endDate },
      },
      woData: workOrderRows,
      materialData: materialRows,
      labourData: labourRows,
    };

    res.json({ success: true, data: responseData });
  } catch (error) {
    console.error('Reports aggregation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to generate report',
      error: error.message,
    });
  }
});

export default router;
