import express from 'express';
import auth from '../middleware/authMiddleware.js';
import WorkOrder from '../models/WorkOrder.js';
import Bill from '../models/Bill.js';

const router = express.Router();

// ─────────────────────────────────────────────
// WORK ORDER ROUTES
// ─────────────────────────────────────────────

// GET /api/work-orders — List work orders by project
router.get('/', auth, async (req, res) => {
  try {
    const { project, status, search, page = 1, limit = 50 } = req.query;

    if (!project) {
      return res.status(400).json({ success: false, message: 'project query param is required' });
    }

    const filter = { project };
    if (status) filter.status = status;
    if (search) {
      filter.$or = [
        { workOrderNo: { $regex: search, $options: 'i' } },
        { workOrderName: { $regex: search, $options: 'i' } },
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await WorkOrder.countDocuments(filter);

    const workOrders = await WorkOrder.find(filter)
      .populate('project', 'name')
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: workOrders,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / parseInt(limit)),
        totalItems: total,
        itemsPerPage: parseInt(limit),
      },
    });
  } catch (err) {
    console.error('Error fetching work orders:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch work orders', error: err.message });
  }
});

// GET /api/work-orders/:id — Get single work order
router.get('/:id', auth, async (req, res) => {
  try {
    const workOrder = await WorkOrder.findById(req.params.id)
      .populate('project', 'name')
      .populate('createdBy', 'name email');

    if (!workOrder) {
      return res.status(404).json({ success: false, message: 'Work order not found' });
    }

    res.json({ success: true, data: workOrder });
  } catch (err) {
    console.error('Error fetching work order:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch work order', error: err.message });
  }
});

// POST /api/work-orders — Create work order
router.post('/', auth, async (req, res) => {
  try {
    const { project, workOrderNo, workOrderName, workOrderDate, totalValue, description, status } = req.body;

    if (!project || !workOrderNo || !workOrderName || !workOrderDate || !totalValue) {
      return res.status(400).json({ success: false, message: 'project, workOrderNo, workOrderName, workOrderDate and totalValue are required' });
    }

    if (parseFloat(totalValue) <= 0) {
      return res.status(400).json({ success: false, message: 'totalValue must be greater than 0' });
    }

    // Ensure workOrderNo is unique within the same project
    const existing = await WorkOrder.findOne({ project, workOrderNo: workOrderNo.trim() });
    if (existing) {
      return res.status(409).json({ success: false, message: `Work Order No "${workOrderNo}" already exists for this project` });
    }

    const workOrder = new WorkOrder({
      project,
      workOrderNo: workOrderNo.trim(),
      workOrderName: workOrderName.trim(),
      workOrderDate,
      totalValue: parseFloat(totalValue),
      description: description?.trim() || '',
      status: status || 'active',
      totalBillsAmount: 0,
      billsCount: 0,
      createdBy: req.user.id,
    });

    await workOrder.save();
    await workOrder.populate('project', 'name');
    await workOrder.populate('createdBy', 'name email');

    res.status(201).json({ success: true, message: 'Work order created successfully', data: workOrder });
  } catch (err) {
    console.error('Error creating work order:', err);
    res.status(500).json({ success: false, message: 'Failed to create work order', error: err.message });
  }
});

// PATCH /api/work-orders/:id/status — Update status
router.patch('/:id/status', auth, async (req, res) => {
  try {
    const { status } = req.body;
    const validStatuses = ['active', 'completed', 'on-hold', 'cancelled'];

    if (!validStatuses.includes(status)) {
      return res.status(400).json({ success: false, message: `Invalid status. Valid values: ${validStatuses.join(', ')}` });
    }

    const workOrder = await WorkOrder.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('project', 'name').populate('createdBy', 'name email');

    if (!workOrder) {
      return res.status(404).json({ success: false, message: 'Work order not found' });
    }

    res.json({ success: true, message: 'Status updated', data: workOrder });
  } catch (err) {
    console.error('Error updating status:', err);
    res.status(500).json({ success: false, message: 'Failed to update status', error: err.message });
  }
});

// ─────────────────────────────────────────────
// BILL ROUTES (nested under work order)
// ─────────────────────────────────────────────

// GET /api/work-orders/:workOrderId/bills — List bills for a work order
router.get('/:workOrderId/bills', auth, async (req, res) => {
  try {
    const workOrder = await WorkOrder.findById(req.params.workOrderId);
    if (!workOrder) {
      return res.status(404).json({ success: false, message: 'Work order not found' });
    }

    const bills = await Bill.find({ workOrder: req.params.workOrderId })
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 });

    res.json({ success: true, data: bills });
  } catch (err) {
    console.error('Error fetching bills:', err);
    res.status(500).json({ success: false, message: 'Failed to fetch bills', error: err.message });
  }
});

// POST /api/work-orders/:workOrderId/bills — Add bill to work order
router.post('/:workOrderId/bills', auth, async (req, res) => {
  try {
    const { billNo, billDate, totalBillValue, retentionAmount, holdingAmount, notes } = req.body;

    if (!billNo || !billDate || !totalBillValue) {
      return res.status(400).json({ success: false, message: 'billNo, billDate and totalBillValue are required' });
    }

    if (parseFloat(totalBillValue) <= 0) {
      return res.status(400).json({ success: false, message: 'totalBillValue must be greater than 0' });
    }

    const workOrder = await WorkOrder.findById(req.params.workOrderId);
    if (!workOrder) {
      return res.status(404).json({ success: false, message: 'Work order not found' });
    }

    // CRITICAL BUSINESS RULE: Total bills cannot exceed Work Order total value
    const newBillValue = parseFloat(totalBillValue);
    const currentTotal = workOrder.totalBillsAmount || 0;
    const remaining = workOrder.totalValue - currentTotal;

    if (newBillValue > remaining) {
      return res.status(400).json({
        success: false,
        message: `Total bill amount cannot exceed Work Order Total Value. Work Order Total: ₹${workOrder.totalValue.toLocaleString('en-IN')}, Already Billed: ₹${currentTotal.toLocaleString('en-IN')}, Remaining: ₹${remaining.toLocaleString('en-IN')}, Your Bill: ₹${newBillValue.toLocaleString('en-IN')}`,
      });
    }

    const bill = new Bill({
      workOrder: req.params.workOrderId,
      billNo: billNo.trim(),
      billDate,
      totalBillValue: newBillValue,
      retentionAmount: parseFloat(retentionAmount) || 0,
      holdingAmount: parseFloat(holdingAmount) || 0,
      notes: notes?.trim() || '',
      createdBy: req.user.id,
    });

    await bill.save();

    // Update Work Order totals atomically
    workOrder.totalBillsAmount = currentTotal + newBillValue;
    workOrder.billsCount = (workOrder.billsCount || 0) + 1;
    await workOrder.save();

    await bill.populate('createdBy', 'name email');

    res.status(201).json({ success: true, message: 'Bill added successfully', data: bill });
  } catch (err) {
    console.error('Error adding bill:', err);
    res.status(500).json({ success: false, message: 'Failed to add bill', error: err.message });
  }
});

export default router;
