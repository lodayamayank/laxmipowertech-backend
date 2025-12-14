import express from 'express';
import PurchaseOrder from '../models/PurchaseOrder.js';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import User from '../models/User.js';
import { syncToUpcomingDelivery as syncServiceToUpcomingDelivery, deleteUpcomingDeliveryBySourceId } from '../utils/syncService.js';
import { 
  upload, 
  uploadMultipleToCloudinary,
  deleteFromCloudinary,
  deleteMultipleFromCloudinary,
  extractPublicId 
} from '../middleware/cloudinaryMaterialMiddleware.js';

const router = express.Router();

// ✅ Helper function to populate requestedBy with user name
const populateRequestedBy = async (order) => {
  if (!order.requestedBy) return order;
  
  // Check if requestedBy is an ObjectId (24 hex characters)
  const isObjectId = /^[0-9a-fA-F]{24}$/.test(order.requestedBy);
  
  if (isObjectId) {
    try {
      const user = await User.findById(order.requestedBy);
      if (user) {
        return {
          ...order.toObject(),
          requestedBy: user.name || user.email || order.requestedBy
        };
      }
    } catch (err) {
      console.error('Error populating requestedBy:', err.message);
    }
  }
  
  return order;
};

// Generate unique purchaseOrderId
const generatePurchaseOrderId = async () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const ymd = `${year}${month}${day}`;
  
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const purchaseOrderId = `PO${ymd}-${suffix}`;
  
  const existing = await PurchaseOrder.findOne({ purchaseOrderId });
  if (existing) {
    return generatePurchaseOrderId();
  }
  
  return purchaseOrderId;
};

// Sync to UpcomingDelivery
const syncToUpcomingDelivery = async (purchaseOrder) => {
  try {
    console.log('🔄 Starting sync to UpcomingDelivery for PO:', purchaseOrder.purchaseOrderId);
    console.log('📊 Materials count:', purchaseOrder.materials?.length || 0);
    
    // ✅ Safety check for materials
    if (!purchaseOrder.materials || purchaseOrder.materials.length === 0) {
      console.log('⚠️ No materials to sync, skipping UpcomingDelivery creation');
      return;
    }
    
    const items = purchaseOrder.materials.map((mat, index) => {
      if (!mat._id) {
        console.error(`❌ Material ${index} is missing _id:`, mat);
        throw new Error(`Material ${index} is missing _id field`);
      }
      return {
        itemId: mat._id.toString(),
        category: mat.category || '',
        sub_category: mat.subCategory || '',
        sub_category1: mat.subCategory1 || '',
        st_quantity: mat.quantity || 0,
        received_quantity: mat.received_quantity || 0,
        is_received: mat.is_received || false
      };
    });
    
    console.log('✅ Mapped items for UpcomingDelivery:', items.length);

    // ✅ CRITICAL FIX: Map PurchaseOrder status to UpcomingDelivery status
    let deliveryStatus = 'Pending';
    if (purchaseOrder.status === 'transferred') deliveryStatus = 'Transferred';
    else if (purchaseOrder.status === 'approved') deliveryStatus = 'Partial';
    else if (purchaseOrder.status === 'pending') deliveryStatus = 'Pending';
    else if (purchaseOrder.status === 'cancelled') deliveryStatus = 'Cancelled';
    
    console.log('🆔 Delivery status:', deliveryStatus);

    const deliveryData = {
      st_id: purchaseOrder.purchaseOrderId,
      transfer_number: purchaseOrder.purchaseOrderId,
      date: purchaseOrder.requestDate,
      from: 'Vendor/Supplier',
      to: purchaseOrder.deliverySite,
      items: items,
      status: deliveryStatus,  // ✅ Use mapped status instead of hardcoded 'Pending'
      type: 'PO',
      createdBy: purchaseOrder.requestedBy,
      attachments: purchaseOrder.attachments || []  // ✅ SYNC ATTACHMENTS from Intent PO to Upcoming Deliveries
    };
    
    console.log('📎 Syncing attachments:', deliveryData.attachments.length, 'files');

    const existing = await UpcomingDelivery.findOne({ st_id: purchaseOrder.purchaseOrderId });
    
    if (existing) {
      console.log('🔄 Updating existing UpcomingDelivery:', existing._id);
      await UpcomingDelivery.findByIdAndUpdate(existing._id, deliveryData);
    } else {
      console.log('➕ Creating new UpcomingDelivery');
      await UpcomingDelivery.create(deliveryData);
    }
    
    console.log('✅ Successfully synced to UpcomingDelivery');
  } catch (err) {
    console.error('❌ SYNC TO UPCOMING DELIVERY FAILED:');
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    throw err; // Re-throw to catch in main handler
  }
};

// CREATE purchase order
router.post('/', upload.array('attachments', 10), async (req, res) => {
  try {
    console.log('📥 Received purchase order creation request');
    console.log('📦 Request body:', req.body);
    console.log('📎 Files:', req.files);
    
    let materials = req.body.materials;
    if (typeof materials === 'string') {
      try {
        materials = JSON.parse(materials);
        console.log('✅ Parsed materials:', materials);
      } catch (e) {
        console.error('❌ Materials parse error:', e);
        return res.status(400).json({ 
          success: false,
          message: 'Invalid materials format',
          error: e.message
        });
      }
    }
    
    const { requestedBy, deliverySite, status, remarks } = req.body;
    
    if (!requestedBy || !deliverySite) {
      console.error('❌ Missing required fields');
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields: requestedBy, deliverySite' 
      });
    }

    const purchaseOrderId = await generatePurchaseOrderId();
    console.log('🆔 Generated Purchase Order ID:', purchaseOrderId);
    
    // ✅ UPLOAD ATTACHMENTS TO CLOUDINARY
    let attachments = [];
    if (req.files && req.files.length > 0) {
      try {
        console.log(`☁️ Uploading ${req.files.length} attachments to Cloudinary...`);
        const cloudinaryResults = await uploadMultipleToCloudinary(
          req.files, 
          'material-transfer/purchase-orders'
        );
        attachments = cloudinaryResults.map(result => ({
          url: result.url,
          publicId: result.publicId
        }));
        console.log(`✅ Uploaded ${attachments.length} attachments to Cloudinary:`, attachments);
      } catch (uploadErr) {
        console.error('❌ Cloudinary upload error:', uploadErr);
        return res.status(500).json({
          success: false,
          message: 'Failed to upload attachments to Cloudinary',
          error: uploadErr.message
        });
      }
    } else {
      console.log('ℹ️ No attachments to upload');
    }

    // ✅ VALIDATE MATERIALS
    if (materials && materials.length > 0) {
      console.log('🔍 Validating materials...');
      for (let i = 0; i < materials.length; i++) {
        const material = materials[i];
        if (!material.itemName || material.itemName.trim() === '') {
          console.error(`❌ Material ${i + 1} missing itemName:`, material);
          return res.status(400).json({
            success: false,
            message: `Material ${i + 1} is missing itemName`,
            material: material
          });
        }
        if (!material.quantity || material.quantity <= 0) {
          console.error(`❌ Material ${i + 1} invalid quantity:`, material);
          return res.status(400).json({
            success: false,
            message: `Material ${i + 1} has invalid quantity`,
            material: material
          });
        }
      }
      console.log('✅ All materials validated successfully');
    }

    console.log('💾 Creating purchase order with data:', {
      purchaseOrderId,
      requestedBy,
      deliverySite,
      materialsCount: materials?.length || 0,
      status: status || 'pending',
      attachmentsCount: attachments.length
    });

    const purchaseOrder = new PurchaseOrder({
      purchaseOrderId,
      requestedBy,
      deliverySite,
      materials: materials || [],
      status: status || 'pending',
      attachments,
      remarks,
      requestDate: new Date()
    });

    await purchaseOrder.save();
    console.log('✅ Purchase order saved to database:', purchaseOrder._id);
    
    // ⚠️ DO NOT auto-sync to Upcoming Deliveries on creation
    // Sync only happens after admin approval with vendor selection
    // await syncToUpcomingDelivery(purchaseOrder);
    console.log('✅ PO created - waiting for admin approval before syncing to Upcoming Deliveries');

    res.status(201).json({
      success: true,
      message: 'Purchase order created successfully',
      data: purchaseOrder
    });
  } catch (err) {
    console.error('❌ CREATE PURCHASE ORDER ERROR:');
    console.error('Error message:', err.message);
    console.error('Error stack:', err.stack);
    console.error('Error name:', err.name);
    if (err.errors) {
      console.error('Validation errors:', err.errors);
    }
    
    res.status(500).json({
      success: false,
      message: 'Failed to create purchase order',
      error: err.message,
      details: err.errors ? Object.keys(err.errors).map(key => ({
        field: key,
        message: err.errors[key].message
      })) : undefined
    });
  }
});

// GET all purchase orders
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    const query = search ? {
      $or: [
        { purchaseOrderId: { $regex: search, $options: 'i' } },
        { deliverySite: { $regex: search, $options: 'i' } },
        { requestedBy: { $regex: search, $options: 'i' } }
      ]
    } : {};

    const orders = await PurchaseOrder.find(query)
      .populate('materials.vendor', 'companyName contact mobile email') // Populate vendor for each material
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await PurchaseOrder.countDocuments(query);

    // ✅ Populate requestedBy for all orders
    const populatedOrders = await Promise.all(
      orders.map(order => populateRequestedBy(order))
    );

    res.json({
      success: true,
      data: populatedOrders,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Get purchase orders error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch purchase orders',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// DELETE ALL purchase orders - MUST BE BEFORE /:id route
router.delete('/all', async (req, res) => {
  try {
    // Get all purchase order IDs before deletion
    const purchaseOrders = await PurchaseOrder.find({}, 'purchaseOrderId');
    const poIds = purchaseOrders.map(po => po.purchaseOrderId);
    
    // Delete all associated upcoming deliveries (using st_id which stores purchaseOrderId)
    const deliveryResult = await UpcomingDelivery.deleteMany({
      st_id: { $in: poIds }
    });
    
    console.log(`🗑️ Deleted ${deliveryResult.deletedCount} associated upcoming deliveries`);
    
    // Delete all purchase orders
    const result = await PurchaseOrder.deleteMany({});
    
    res.json({
      success: true,
      message: `Successfully deleted all ${result.deletedCount} purchase orders and ${deliveryResult.deletedCount} associated upcoming deliveries`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error('Delete all purchase orders error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete all purchase orders',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// GET purchase order by ID
router.get('/:id', async (req, res) => {
  try {
    const order = await PurchaseOrder.findById(req.params.id)
      .populate('materials.vendor', 'companyName contact mobile email'); // Populate vendor for each material
    
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }
    
    // ✅ Populate requestedBy with user name
    const populatedOrder = await populateRequestedBy(order);
    
    res.json({ success: true, data: populatedOrder });
  } catch (err) {
    console.error('Get purchase order error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch purchase order',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// APPROVE purchase order with vendor grouping
router.put('/:id/approve', async (req, res) => {
  try {
    const purchaseOrder = await PurchaseOrder.findById(req.params.id)
      .populate('materials.vendor', 'companyName contact mobile email');
    
    if (!purchaseOrder) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }
    
    console.log('✅ Approving Purchase order:', purchaseOrder.purchaseOrderId);
    console.log('📦 Materials count:', purchaseOrder.materials?.length || 0);
    
    // ✅ Check if materials have vendors assigned BEFORE saving approval
    const materialsWithoutVendor = purchaseOrder.materials.filter(m => !m.vendor);
    if (materialsWithoutVendor.length > 0) {
      console.warn('⚠️ Materials without vendor:', materialsWithoutVendor.length);
      console.warn('⚠️ Materials:', materialsWithoutVendor.map(m => m.itemName));
      
      // ✅ OPTION 1: Allow approval but warn that deliveries won't be created
      // Update status to approved anyway
      purchaseOrder.status = 'approved';
      await purchaseOrder.save();
      
      return res.status(200).json({
        success: true,
        message: `Purchase order approved, but ${materialsWithoutVendor.length} material(s) do not have vendors assigned. Assign vendors to create delivery entries.`,
        warning: true,
        data: purchaseOrder,
        materialsWithoutVendor: materialsWithoutVendor.map(m => m.itemName)
      });
    }
    
    // Update status to approved
    purchaseOrder.status = 'approved';
    await purchaseOrder.save();
    console.log('✅ Purchase order approved:', purchaseOrder.purchaseOrderId);
    
    // Group materials by vendor (only materials WITH vendors)
    const vendorGroups = {};
    const materialsWithVendors = purchaseOrder.materials.filter(m => m.vendor);
    
    console.log(`📊 Materials with vendors: ${materialsWithVendors.length}/${purchaseOrder.materials.length}`);
    
    materialsWithVendors.forEach((material, index) => {
      const vendorId = material.vendor._id.toString();
      
      if (!vendorGroups[vendorId]) {
        vendorGroups[vendorId] = {
          vendorInfo: material.vendor,
          materials: []
        };
      }
      
      vendorGroups[vendorId].materials.push({
        ...material.toObject(),
        originalIndex: index
      });
    });
    
    console.log('🏭 Vendor groups:', Object.keys(vendorGroups).length);
    
    // Create separate UpcomingDelivery for each vendor with derived IDs
    const createdDeliveries = [];
    const errors = [];
    const vendorEntries = Object.entries(vendorGroups);
    let vendorSequence = 1;
    
    for (const [vendorId, group] of vendorEntries) {
      try {
        const items = group.materials.map(mat => ({
          itemId: mat._id.toString(),
          name: mat.itemName,
          category: mat.category || '',
          quantity: mat.quantity,
          uom: mat.uom || 'pcs',  // Default to 'pcs' if not specified
          received_quantity: mat.received_quantity || 0,
          is_received: mat.is_received || false,
          remarks: mat.remarks || ''
        }));
        
        // ✅ Generate vendor-specific delivery ID with suffix: PO20251214-DS934-01, -02, -03
        const vendorSuffix = vendorSequence.toString().padStart(2, '0');
        const derivedDeliveryId = `${purchaseOrder.purchaseOrderId}-${vendorSuffix}`;
        
        // Create delivery entry for this vendor
        const delivery = new UpcomingDelivery({
          st_id: purchaseOrder._id.toString(),
          source_type: 'PurchaseOrder',
          source_id: purchaseOrder.purchaseOrderId,  // Base PO ID (for tracking)
          transfer_number: derivedDeliveryId,  // Vendor-specific ID with suffix
          type: 'PO',  // REQUIRED field - DO NOT REMOVE (schema validation)
          vendor_name: group.vendorInfo?.companyName || 'Unknown Vendor',
          vendor_id: vendorId,
          delivery_site: purchaseOrder.deliverySite || 'N/A',
          requested_by: purchaseOrder.requestedBy || 'Unknown',
          items: items,
          status: 'Pending',
          created_date: new Date(),
          expected_delivery: purchaseOrder.requestDate || new Date()
        });
        
        await delivery.save();
        createdDeliveries.push(delivery);
        vendorSequence++;
        
        console.log(`✅ Created delivery ${derivedDeliveryId} for vendor: ${group.vendorInfo?.companyName} (${items.length} materials)`);
      } catch (deliveryErr) {
        console.error(`❌ Failed to create delivery for vendor ${vendorId}:`, deliveryErr.message);
        errors.push({
          vendorId,
          vendorName: group.vendorInfo?.companyName,
          error: deliveryErr.message
        });
      }
    }
    
    res.json({
      success: true,
      message: `Purchase order approved and ${createdDeliveries.length} delivery entries created${errors.length > 0 ? ` (${errors.length} failed)` : ''}`,
      data: {
        purchaseOrder,
        deliveries: createdDeliveries,
        errors: errors.length > 0 ? errors : undefined
      }
    });
  } catch (err) {
    console.error('❌ Approve purchase order error:', err.message);
    console.error('❌ Stack trace:', err.stack);
    console.error('❌ Error details:', err);
    res.status(500).json({
      success: false,
      message: 'Failed to approve purchase order',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined,
      details: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
});

// UPDATE purchase order
router.put('/:id', upload.array('attachments', 10), async (req, res) => {
  try {
    let materials = req.body.materials;
    if (typeof materials === 'string') {
      materials = JSON.parse(materials);
    }

    const updateData = {
      requestedBy: req.body.requestedBy,
      deliverySite: req.body.deliverySite,
      materials: materials,
      status: req.body.status,
      remarks: req.body.remarks
    };

    if (req.files && req.files.length > 0) {
      // ✅ Use absolute URLs with backend domain for images
      const baseURL = process.env.BACKEND_URL || 'https://laxmipowertech-backend.onrender.com';
      const newAttachments = req.files.map(f => `${baseURL}/uploads/purchaseOrders/${f.filename}`);
      const existingOrder = await PurchaseOrder.findById(req.params.id);
      updateData.attachments = [...(existingOrder.attachments || []), ...newAttachments];
    }

    const order = await PurchaseOrder.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('materials.vendor', 'companyName contact mobile email'); // Populate vendor for each material

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    // ⚠️ CRITICAL: DO NOT auto-sync on regular updates
    // WHY: syncToUpcomingDelivery() creates GENERIC deliveries without vendor grouping
    //      This causes pending intents to appear in Upcoming Deliveries prematurely
    // SOLUTION: Only the /approve endpoint creates deliveries with proper vendor grouping
    // await syncToUpcomingDelivery(order);  // ❌ DISABLED - see /approve endpoint
    console.log(`✅ PurchaseOrder ${order.purchaseOrderId} updated - NO sync (deliveries created only on approval)`);

    res.json({
      success: true,
      message: 'Purchase order updated successfully',
      data: order
    });
  } catch (err) {
    console.error('Update purchase order error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update purchase order',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// TEMPORARY CLEANUP ENDPOINT - Remove after data is cleaned
// DELETE /api/material/purchase-orders/cleanup-wrong-deliveries
router.delete('/cleanup-wrong-deliveries', async (req, res) => {
  try {
    console.log('🧹 Starting cleanup of wrong Upcoming Deliveries...');
    
    // Delete all deliveries with wrong data patterns
    const result = await UpcomingDelivery.deleteMany({
      $or: [
        // Deliveries with generic values (from old buggy code)
        { from: "Vendor" },
        { to: "Site" },
        
        // Deliveries without vendor info
        { vendor_name: { $exists: false } },
        { vendor_name: null },
        { vendor_name: "" },
        
        // Wrong type for POs/Indents  
        { type: "ST", source_type: { $in: ["PurchaseOrder", "Indent"] } },
        
        // Empty items (from photo upload bug)
        { items: { $size: 0 } }
      ]
    });
    
    console.log(`✅ Cleanup complete: Deleted ${result.deletedCount} wrong deliveries`);
    
    res.json({
      success: true,
      message: `Successfully cleaned up ${result.deletedCount} wrong delivery entries`,
      deletedCount: result.deletedCount,
      details: 'Deleted deliveries with: generic vendor/site values, missing vendor info, wrong types, or empty items'
    });
  } catch (err) {
    console.error('❌ Cleanup error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to cleanup deliveries',
      error: err.message
    });
  }
});

// DELETE purchase order
router.delete('/:id', async (req, res) => {
  try {
    const order = await PurchaseOrder.findByIdAndDelete(req.params.id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    // ✅ Delete from UpcomingDelivery using sync service
    await deleteUpcomingDeliveryBySourceId(order.purchaseOrderId);

    // Delete attachments
    if (order.attachments && order.attachments.length > 0) {
      order.attachments.forEach(att => {
        const filePath = path.join(__dirname, '..', att);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
    }

    res.json({
      success: true,
      message: 'Purchase order deleted successfully'
    });
  } catch (err) {
    console.error('Delete purchase order error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete purchase order',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// DELETE attachment
router.delete('/:id/attachments/:attachmentIndex', async (req, res) => {
  try {
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    const index = parseInt(req.params.attachmentIndex);
    if (index < 0 || index >= order.attachments.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid attachment index'
      });
    }

    // ✅ DELETE FROM CLOUDINARY
    const attachment = order.attachments[index];
    if (attachment.publicId) {
      try {
        await deleteFromCloudinary(attachment.publicId);
        console.log('✅ Deleted attachment from Cloudinary:', attachment.publicId);
      } catch (cloudErr) {
        console.error('⚠️ Failed to delete from Cloudinary:', cloudErr.message);
        // Continue with deletion even if Cloudinary deletion fails
      }
    }

    order.attachments.splice(index, 1);
    await order.save();

    res.json({
      success: true,
      message: 'Attachment deleted successfully',
      data: order
    });
  } catch (err) {
    console.error('Delete attachment error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete attachment',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});


export default router;