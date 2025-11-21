import express from 'express';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import SiteTransfer from '../models/SiteTransfer.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import { syncToSiteTransfer, syncToPurchaseOrder, calculateDeliveryStatus } from '../utils/syncService.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

// GET all upcoming deliveries (with user-based filtering)
router.get('/', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    // Build base query
    let query = {};

    // ✅ ROLE-BASED FILTERING
    // If user is client/user, show only their own deliveries
    // If user is admin, show all deliveries
    if (req.user.role !== 'admin') {
      query.createdBy = req.user.id || req.user._id.toString();
      console.log('👤 Client user - filtering by createdBy:', query.createdBy);
    } else {
      console.log('👑 Admin user - showing all deliveries');
    }

    // Add search filters
    if (search) {
      query.$or = [
        { transfer_number: { $regex: search, $options: 'i' } },
        { from: { $regex: search, $options: 'i' } },
        { to: { $regex: search, $options: 'i' } },
        { createdBy: { $regex: search, $options: 'i' } }
      ];
    }

    const deliveries = await UpcomingDelivery.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await UpcomingDelivery.countDocuments(query);

    console.log(`📦 Found ${deliveries.length} deliveries for user ${req.user.email}`);

    res.json({
      success: true,
      data: deliveries,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Get upcoming deliveries error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch upcoming deliveries',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// GET upcoming delivery by ID
router.get('/:id', protect, async (req, res) => {
  try {
    const delivery = await UpcomingDelivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Upcoming delivery not found'
      });
    }
    res.json({ success: true, data: delivery });
  } catch (err) {
    console.error('Get upcoming delivery error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch upcoming delivery',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// CREATE upcoming delivery (manual creation)
router.post('/', protect, async (req, res) => {
  try {
    const { st_id, transfer_number, from, to, items, type, createdBy } = req.body;

    if (!st_id || !transfer_number || !from || !to || !items || !createdBy) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields'
      });
    }

    const delivery = new UpcomingDelivery({
      st_id,
      transfer_number,
      date: new Date(),
      from,
      to,
      items,
      status: 'Pending',
      type: type || 'ST',
      createdBy
    });

    await delivery.save();

    res.status(201).json({
      success: true,
      message: 'Upcoming delivery created successfully',
      data: delivery
    });
  } catch (err) {
    console.error('Create upcoming delivery error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create upcoming delivery',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// UPDATE delivery items (batch update received quantities)
router.put('/:id/items', async (req, res) => {
  try {
    const { items } = req.body;

    if (!items || !Array.isArray(items)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid items data'
      });
    }

    const delivery = await UpcomingDelivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Upcoming delivery not found'
      });
    }

    // Update items
    items.forEach(updatedItem => {
      const itemIndex = delivery.items.findIndex(
        item => item.itemId === updatedItem.itemId
      );
      
      if (itemIndex !== -1) {
        delivery.items[itemIndex].received_quantity = updatedItem.received_quantity || 0;
        delivery.items[itemIndex].is_received = updatedItem.is_received || false;
      }
    });

    // ✅ Calculate status using sync service
    const newStatus = calculateDeliveryStatus(delivery.items);
    delivery.status = newStatus;
    console.log(`📊 Status calculated: ${delivery.status}`);

    await delivery.save();

    // ✅ Sync back to source using sync service
    if (delivery.type === 'ST') {
      await syncToSiteTransfer(delivery.st_id, {
        status: delivery.status,
        items: delivery.items
      });
      console.log(`🔄 Synced to SiteTransfer ${delivery.st_id}`);
    } else if (delivery.type === 'PO') {
      await syncToPurchaseOrder(delivery.st_id, {
        status: delivery.status,
        items: delivery.items
      });
      console.log(`🔄 Synced to PurchaseOrder ${delivery.st_id}`);
    }

    res.json({
      success: true,
      message: 'Delivery items updated successfully',
      data: delivery
    });
  } catch (err) {
    console.error('Update delivery items error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update delivery items',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// UPDATE delivery status (admin override)
router.put('/:id/status', async (req, res) => {
  try {
    const { status } = req.body;

    if (!['Pending', 'Partial', 'Transferred'].includes(status)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be: Pending, Partial, or Transferred'
      });
    }

    const delivery = await UpcomingDelivery.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true, runValidators: true }
    );

    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Upcoming delivery not found'
      });
    }

    res.json({
      success: true,
      message: 'Delivery status updated successfully',
      data: delivery
    });
  } catch (err) {
    console.error('Update delivery status error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update delivery status',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// DELETE upcoming delivery
router.delete('/:id', async (req, res) => {
  try {
    const delivery = await UpcomingDelivery.findByIdAndDelete(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Upcoming delivery not found'
      });
    }

    res.json({
      success: true,
      message: 'Upcoming delivery deleted successfully'
    });
  } catch (err) {
    console.error('Delete upcoming delivery error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete upcoming delivery',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

export default router;