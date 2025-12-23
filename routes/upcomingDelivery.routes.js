import express from 'express';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import SiteTransfer from '../models/SiteTransfer.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import Indent from '../models/Indent.js';
import { syncToSiteTransfer, syncToPurchaseOrder, calculateDeliveryStatus } from '../utils/syncService.js';
import protect from '../middleware/authMiddleware.js';
import { filterByUserBranches, applyBranchFilter } from '../middleware/branchAuthMiddleware.js';
import { 
  upload, 
  uploadMultipleToCloudinary,
  deleteFromCloudinary 
} from '../middleware/cloudinaryMaterialMiddleware.js';

const router = express.Router();

// ✅ MIGRATION ENDPOINT: Sync all existing Purchase Orders and Indents to Upcoming Deliveries
// Call this once to create delivery records for old data: POST /api/material/upcoming-deliveries/migrate-sync
router.post('/migrate-sync', protect, async (req, res) => {
  try {
    let created = 0;
    let skipped = 0;
    let errors = [];

    console.log('🔄 Starting migration: Syncing APPROVED Intent POs to Upcoming Deliveries...');

    // ✅ Sync all APPROVED Purchase Orders only
    const purchaseOrders = await PurchaseOrder.find({ status: 'approved' });
    console.log(`📦 Found ${purchaseOrders.length} approved Purchase Orders`);

    for (const po of purchaseOrders) {
      try {
        // Check if delivery already exists
        const existing = await UpcomingDelivery.findOne({ st_id: po.purchaseOrderId });
        if (existing) {
          skipped++;
          continue;
        }

        // Create delivery record
        const items = po.materials.map(mat => ({
          itemId: mat._id.toString(),
          category: mat.category || '',
          sub_category: mat.subCategory || '',
          sub_category1: mat.subCategory1 || '',
          st_quantity: mat.quantity || 0,
          received_quantity: mat.received_quantity || 0,
          is_received: mat.is_received || false
        }));

        await UpcomingDelivery.create({
          st_id: po.purchaseOrderId,
          transfer_number: po.purchaseOrderId,
          date: po.requestDate || po.createdAt,
          from: 'Vendor/Supplier',
          to: po.deliverySite || 'Site',
          items: items,
          status: 'Pending',
          type: 'PO',
          createdBy: po.requestedBy || 'system'
        });

        created++;
        console.log(`✅ Created delivery for PO: ${po.purchaseOrderId}`);
      } catch (err) {
        errors.push(`PO ${po.purchaseOrderId}: ${err.message}`);
        console.error(`❌ Error syncing PO ${po.purchaseOrderId}:`, err.message);
      }
    }

    // ✅ Sync all APPROVED Indents only
    const indents = await Indent.find({ status: 'approved' }).populate('branch', 'name').populate('project', 'name').populate('requestedBy', 'name');
    console.log(`📸 Found ${indents.length} approved Indents`);

    for (const indent of indents) {
      try {
        // Check if delivery already exists
        const existing = await UpcomingDelivery.findOne({ st_id: indent._id.toString() });
        if (existing) {
          skipped++;
          continue;
        }

        // Create delivery record
        await UpcomingDelivery.create({
          st_id: indent._id.toString(),
          transfer_number: indent.indentId,
          date: indent.createdAt,
          from: 'Vendor',
          to: indent.branch?.name || indent.project?.name || 'Site',
          items: [],
          status: 'Pending',
          type: 'PO',
          createdBy: indent.requestedBy?.name || indent.requestedBy || 'system'
        });

        created++;
        console.log(`✅ Created delivery for Indent: ${indent.indentId}`);
      } catch (err) {
        errors.push(`Indent ${indent.indentId}: ${err.message}`);
        console.error(`❌ Error syncing Indent ${indent.indentId}:`, err.message);
      }
    }

    console.log(`✅ Migration complete: ${created} created, ${skipped} skipped, ${errors.length} errors`);

    res.json({
      success: true,
      message: 'Migration completed successfully',
      summary: {
        created,
        skipped,
        totalProcessed: purchaseOrders.length + indents.length,
        errors: errors.length,
        errorDetails: errors
      }
    });
  } catch (err) {
    console.error('❌ Migration error:', err);
    res.status(500).json({
      success: false,
      message: 'Migration failed',
      error: err.message
    });
  }
});

// ✅ CLEANUP ENDPOINT: Remove deliveries for pending intents (TEMPORARY - for one-time cleanup)
router.post('/cleanup-pending', protect, async (req, res) => {
  try {
    let deleted = 0;
    let errors = [];
    
    console.log('🧹 Starting cleanup: Removing deliveries for pending intents...');
    
    // Find all deliveries with source_type = 'Indent'
    const deliveries = await UpcomingDelivery.find({ source_type: 'Indent' });
    console.log(`📦 Found ${deliveries.length} indent-based deliveries`);
    
    for (const delivery of deliveries) {
      try {
        // Check if associated indent is pending
        const indent = await Indent.findById(delivery.st_id);
        if (indent && indent.status === 'pending') {
          await UpcomingDelivery.findByIdAndDelete(delivery._id);
          deleted++;
          console.log(`🗑️ Deleted delivery for pending indent: ${indent.indentId}`);
        }
      } catch (err) {
        errors.push(`Delivery ${delivery._id}: ${err.message}`);
        console.error(`❌ Error checking delivery ${delivery._id}:`, err.message);
      }
    }
    
    // Also check Purchase Orders
    const poDeliveries = await UpcomingDelivery.find({ source_type: 'PurchaseOrder' });
    console.log(`📦 Found ${poDeliveries.length} PO-based deliveries`);
    
    for (const delivery of poDeliveries) {
      try {
        const po = await PurchaseOrder.findById(delivery.st_id);
        if (po && po.status === 'pending') {
          await UpcomingDelivery.findByIdAndDelete(delivery._id);
          deleted++;
          console.log(`🗑️ Deleted delivery for pending PO: ${po.purchaseOrderId}`);
        }
      } catch (err) {
        errors.push(`Delivery ${delivery._id}: ${err.message}`);
        console.error(`❌ Error checking delivery ${delivery._id}:`, err.message);
      }
    }
    
    console.log(`✅ Cleanup complete: ${deleted} deliveries deleted, ${errors.length} errors`);
    
    res.json({
      success: true,
      message: `Cleaned up ${deleted} deliveries for pending intents/POs`,
      summary: {
        deleted,
        errors: errors.length,
        errorDetails: errors
      }
    });
  } catch (err) {
    console.error('❌ Cleanup error:', err);
    res.status(500).json({
      success: false,
      message: 'Cleanup failed',
      error: err.message
    });
  }
});

// GET all upcoming deliveries with branch-based filtering
router.get('/', protect, filterByUserBranches, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    // Build base query
    let query = {};

    // ✅ Apply branch-based filtering (admin sees all, clients see only their branches)
    query = applyBranchFilter(req, query, 'from', 'to');

    // Add search filters
    if (search) {
      const searchConditions = [
        { st_id: { $regex: search, $options: 'i' } },
        { transfer_number: { $regex: search, $options: 'i' } },
        { from: { $regex: search, $options: 'i' } },
        { to: { $regex: search, $options: 'i' } },
        { createdBy: { $regex: search, $options: 'i' } }
      ];
      
      // Combine branch filter with search
      if (query.$or) {
        query.$and = [
          { $or: query.$or },
          { $or: searchConditions }
        ];
        delete query.$or;
      } else {
        query.$or = searchConditions;
      }
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

    // ✅ Auto-calculate status based on items
    // Logic: requested == received → Transferred
    //        requested > received (received > 0) → Partial
    //        received == 0 → Pending
    const calculatedStatus = calculateDeliveryStatus(delivery.items);
    delivery.status = calculatedStatus;
    
    console.log(`📊 Status auto-calculated: ${calculatedStatus} based on item quantities`);

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

    // Find delivery first
    const delivery = await UpcomingDelivery.findById(req.params.id);

    if (!delivery) {
      console.error(`❌ Delivery not found: ${req.params.id}`);
      return res.status(404).json({
        success: false,
        message: 'Upcoming delivery not found'
      });
    }

    // ✅ CRITICAL FIX: Auto-fill material quantities when status changed to Transferred
    if (normalizedStatus === 'Transferred') {
      console.log(`🔄 Status changed to Transferred - auto-filling all material quantities`);
      
      // Validate that delivery has items
      if (!delivery.items || delivery.items.length === 0) {
        return res.status(400).json({
          success: false,
          message: 'Cannot mark as Transferred: No materials found in delivery'
        });
      }

      // Auto-fill received quantities for all materials
      delivery.items = delivery.items.map(item => {
        const approvedQty = item.st_quantity || 0;
        
        if (approvedQty === 0) {
          console.warn(`⚠️ Warning: Item ${item.category} has 0 approved quantity`);
        }

        return {
          ...item,
          received_quantity: approvedQty,  // Auto-fill: received = approved
          is_received: true                 // Mark as fully received
        };
      });

      console.log(`✅ Auto-filled ${delivery.items.length} materials with full quantities`);
    }

    // Update status and items
    delivery.status = normalizedStatus;
    delivery.updatedAt = Date.now();
    await delivery.save();

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

// UPDATE GRN billing details
router.put('/:id/billing', protect, async (req, res) => {
  try {
    const { invoiceNumber, price, billDate, discount } = req.body;
    
    // Find delivery
    const delivery = await UpcomingDelivery.findById(req.params.id);
    
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }
    
    // Calculate amount (price - discount)
    const calculatedAmount = (parseFloat(price) || 0) - (parseFloat(discount) || 0);
    
    // Update billing information
    delivery.billing = {
      invoiceNumber: invoiceNumber || '',
      price: parseFloat(price) || 0,
      billDate: billDate ? new Date(billDate) : null,
      discount: parseFloat(discount) || 0,
      amount: calculatedAmount
    };
    
    delivery.updatedAt = Date.now();
    await delivery.save();
    
    console.log(`✅ Billing updated for GRN ${delivery.st_id}:`, delivery.billing);
    
    res.json({
      success: true,
      message: 'Billing details updated successfully',
      data: delivery
    });
  } catch (err) {
    console.error('Update billing error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update billing details',
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

// ✅ UPLOAD DELIVERY RECEIPT IMAGES (Cloudinary)
router.post('/:id/upload-receipts', upload.array('receipts', 10), async (req, res) => {
  try {
    console.log('📥 Upload receipt request for delivery:', req.params.id);
    console.log('📎 Files:', req.files?.length || 0);
    
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No files uploaded'
      });
    }

    const delivery = await UpcomingDelivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    // ✅ UPLOAD TO CLOUDINARY
    console.log(`☁️ Uploading ${req.files.length} receipt images to Cloudinary...`);
    const cloudinaryResults = await uploadMultipleToCloudinary(
      req.files, 
      'material-transfer/delivery-receipts'
    );
    
    const newAttachments = cloudinaryResults.map(result => ({
      url: result.url,
      publicId: result.publicId
    }));
    
    console.log(`✅ Uploaded ${newAttachments.length} receipts to Cloudinary`);

    // ✅ ADD TO EXISTING ATTACHMENTS
    delivery.attachments = delivery.attachments || [];
    delivery.attachments.push(...newAttachments);
    await delivery.save();

    res.json({
      success: true,
      message: `${newAttachments.length} receipt(s) uploaded successfully`,
      data: delivery
    });
  } catch (err) {
    console.error('❌ Upload receipt error:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to upload receipts',
      error: err.message
    });
  }
});

// ✅ DELETE DELIVERY RECEIPT IMAGE
router.delete('/:id/attachments/:attachmentIndex', async (req, res) => {
  try {
    const delivery = await UpcomingDelivery.findById(req.params.id);
    if (!delivery) {
      return res.status(404).json({
        success: false,
        message: 'Delivery not found'
      });
    }

    const index = parseInt(req.params.attachmentIndex);
    if (index < 0 || index >= delivery.attachments.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid attachment index'
      });
    }

    // ✅ DELETE FROM CLOUDINARY
    const attachment = delivery.attachments[index];
    if (attachment.publicId) {
      try {
        await deleteFromCloudinary(attachment.publicId);
        console.log('✅ Deleted receipt from Cloudinary:', attachment.publicId);
      } catch (cloudErr) {
        console.error('⚠️ Failed to delete from Cloudinary:', cloudErr.message);
        // Continue with deletion even if Cloudinary deletion fails
      }
    }

    delivery.attachments.splice(index, 1);
    await delivery.save();

    res.json({
      success: true,
      message: 'Receipt deleted successfully',
      data: delivery
    });
  } catch (err) {
    console.error('Delete receipt error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete receipt',
      error: err.message
    });
  }
});

export default router;