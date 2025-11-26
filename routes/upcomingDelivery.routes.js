import express from 'express';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import SiteTransfer from '../models/SiteTransfer.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import { syncToSiteTransfer, syncToPurchaseOrder, calculateDeliveryStatus } from '../utils/syncService.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

// GET all upcoming deliveries (NO role-based filtering - matches demonstrated project)
router.get('/', protect, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    // Build base query - NO ROLE-BASED FILTERING
    // ✅ CRITICAL FIX: Show ALL deliveries to ALL users (admin + client)
    // This matches the demonstrated project behavior
    let query = {};

    // Add search filters
    if (search) {
      query.$or = [
        { st_id: { $regex: search, $options: 'i' } },
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

    console.log(`📦 Found ${deliveries.length} upcoming deliveries (total: ${total})`);

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

    // Store original status
    const originalStatus = delivery.status;
    
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

    // ✅ Only auto-calculate status if it becomes fully transferred
    // Otherwise keep the manually set status
    const calculatedStatus = calculateDeliveryStatus(delivery.items);
    
    // Only update status if:
    // 1. All items are fully received (Transferred)
    // 2. Or current status is Pending and some items are received (Partial)
    if (calculatedStatus === 'Transferred') {
      delivery.status = 'Transferred';
      console.log(`📊 Status auto-updated to Transferred (all items received)`);
    } else if (originalStatus === 'Pending' && calculatedStatus === 'Partial') {
      delivery.status = 'Partial';
      console.log(`📊 Status auto-updated to Partial (some items received)`);
    } else {
      // Keep original status (manually set by admin)
      delivery.status = originalStatus;
      console.log(`📊 Status kept as ${originalStatus} (manually set)`);
    }

    await delivery.save();

    // ✅ Sync back to source using sync service
    if (delivery.type === 'ST') {
      await syncToSiteTransfer(delivery.st_id, {
        status: delivery.status,
        items: delivery.items
      });
      console.log(`🔄 Synced to SiteTransfer ${delivery.st_id}`);
    } else if (delivery.type === 'PO') {
      // Try to sync to Indent first (for photo-based POs)
      try {
        const Indent = (await import('../models/Indent.js')).default;
        const indent = await Indent.findById(delivery.st_id);
        if (indent) {
          // Map UpcomingDelivery status back to Indent status
          let indentStatus = 'pending';
          if (delivery.status === 'Transferred') indentStatus = 'transferred';
          else if (delivery.status === 'Partial') indentStatus = 'approved';
          else if (delivery.status === 'Pending') indentStatus = 'pending';
          else if (delivery.status === 'Cancelled') indentStatus = 'cancelled';
          
          indent.status = indentStatus;
          await indent.save();
          console.log(`🔄 Synced to Indent ${delivery.st_id}: ${delivery.status} → ${indentStatus}`);
        } else {
          // If not an Indent, try PurchaseOrder
          await syncToPurchaseOrder(delivery.st_id, {
            status: delivery.status,
            items: delivery.items
          });
          console.log(`🔄 Synced to PurchaseOrder ${delivery.st_id}`);
        }
      } catch (indentErr) {
        console.log('⚠️ Trying PurchaseOrder sync:', indentErr.message);
        // Try PurchaseOrder sync as fallback
        await syncToPurchaseOrder(delivery.st_id, {
          status: delivery.status,
          items: delivery.items
        });
        console.log(`🔄 Synced to PurchaseOrder ${delivery.st_id}`);
      }
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
router.put('/:id/status', protect, async (req, res) => {
  try {
    const { status } = req.body;
    console.log(`📝 Status update request for delivery ${req.params.id}: ${status}`);

    // Normalize status to proper case
    const normalizedStatus = status.charAt(0).toUpperCase() + status.slice(1).toLowerCase();
    
    if (!['Pending', 'Partial', 'Transferred', 'Cancelled'].includes(normalizedStatus)) {
      console.error(`❌ Invalid status: ${status}`);
      return res.status(400).json({
        success: false,
        message: 'Invalid status. Must be: Pending, Partial, Transferred, or Cancelled'
      });
    }

    // Find and update delivery
    const delivery = await UpcomingDelivery.findByIdAndUpdate(
      req.params.id,
      { status: normalizedStatus, updatedAt: Date.now() },
      { new: true, runValidators: true }
    );

    if (!delivery) {
      console.error(`❌ Delivery not found: ${req.params.id}`);
      return res.status(404).json({
        success: false,
        message: 'Upcoming delivery not found'
      });
    }

    console.log(`✅ Delivery status updated: ${delivery.st_id} → ${normalizedStatus}`);

    // ✅ Sync status back to source (Indent or PurchaseOrder)
    try {
      if (delivery.type === 'ST') {
        await syncToSiteTransfer(delivery.st_id, {
          status: normalizedStatus
        });
        console.log(`🔄 Status synced to SiteTransfer ${delivery.st_id}`);
      } else if (delivery.type === 'PO') {
        // Try to sync to Indent first (for photo-based POs)
        try {
          const Indent = (await import('../models/Indent.js')).default;
          const indent = await Indent.findById(delivery.st_id);
          if (indent) {
            // Map UpcomingDelivery status back to Indent status
            let indentStatus = 'pending';
            if (normalizedStatus === 'Transferred') indentStatus = 'transferred';
            else if (normalizedStatus === 'Partial') indentStatus = 'approved'; // Partial = Approved
            else if (normalizedStatus === 'Pending') indentStatus = 'pending';
            else if (normalizedStatus === 'Cancelled') indentStatus = 'cancelled';
            
            indent.status = indentStatus;
            await indent.save();
            console.log(`🔄 Status synced to Indent ${delivery.st_id}: ${normalizedStatus} → ${indentStatus}`);
          } else {
            // If not an Indent, try PurchaseOrder
            await syncToPurchaseOrder(delivery.st_id, {
              status: normalizedStatus
            });
            console.log(`🔄 Status synced to PurchaseOrder ${delivery.st_id}`);
          }
        } catch (indentErr) {
          console.log('⚠️ Trying PurchaseOrder sync:', indentErr.message);
          // Try PurchaseOrder sync as fallback
          await syncToPurchaseOrder(delivery.st_id, {
            status: normalizedStatus
          });
          console.log(`🔄 Status synced to PurchaseOrder ${delivery.st_id}`);
        }
      }
    } catch (syncErr) {
      console.error('⚠️ Failed to sync status to source:', syncErr.message);
      console.error(syncErr.stack);
      // Don't fail the request if sync fails
    }

    res.json({
      success: true,
      message: 'Delivery status updated successfully',
      data: delivery
    });
  } catch (err) {
    console.error('Update delivery status error:', err.message);
    console.error(err.stack);
    res.status(500).json({
      success: false,
      message: 'Failed to update delivery status',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// DELETE ALL upcoming deliveries - MUST BE BEFORE /:id route
router.delete('/all', async (req, res) => {
  try {
    // Delete all upcoming deliveries
    const result = await UpcomingDelivery.deleteMany({});
    
    res.json({
      success: true,
      message: `Successfully deleted all ${result.deletedCount} upcoming deliveries`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error('Delete all upcoming deliveries error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete all upcoming deliveries',
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

// ✅ TEST ENDPOINT - Check sync status for a specific PO/Transfer Number
router.get('/test-sync/:transferNumber', protect, async (req, res) => {
  try {
    const { transferNumber } = req.params;
    
    // Find UpcomingDelivery
    const delivery = await UpcomingDelivery.findOne({ transfer_number: transferNumber });
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: `No UpcomingDelivery found for ${transferNumber}`
      });
    }
    
    const result = {
      transferNumber,
      delivery: {
        st_id: delivery.st_id,
        status: delivery.status,
        type: delivery.type,
        from: delivery.from,
        to: delivery.to
      }
    };
    
    // Try to find Indent
    try {
      const Indent = (await import('../models/Indent.js')).default;
      const indent = await Indent.findById(delivery.st_id);
      if (indent) {
        result.indent = {
          _id: indent._id,
          indentId: indent.indentId,
          status: indent.status,
          requestedBy: indent.requestedBy
        };
      }
    } catch (err) {
      // Not an Indent, try PurchaseOrder
      try {
        const PurchaseOrder = (await import('../models/PurchaseOrder.js')).default;
        const po = await PurchaseOrder.findOne({ purchaseOrderId: delivery.st_id });
        if (po) {
          result.purchaseOrder = {
            _id: po._id,
            purchaseOrderId: po.purchaseOrderId,
            status: po.status,
            requestedBy: po.requestedBy
          };
        }
      } catch (poErr) {
        result.error = 'No source document found';
      }
    }
    
    res.json({
      success: true,
      data: result
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Test sync failed',
      error: err.message
    });
  }
});


export default router;