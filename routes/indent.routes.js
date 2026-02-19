import express from "express";
import auth from "../middleware/authMiddleware.js";
import Indent from "../models/Indent.js";
import UpcomingDelivery from "../models/UpcomingDelivery.js";
import { filterByUserBranches, applySingleSiteBranchFilter } from '../middleware/branchAuthMiddleware.js';
import { 
  upload, 
  uploadToCloudinary,
  deleteFromCloudinary,
  extractPublicId 
} from '../middleware/cloudinaryMaterialMiddleware.js';

const router = express.Router();

// ✅ Create new indent (User raises request)
router.post("/", auth, async (req, res) => {
  try {
    const { project, branch, items, remarks } = req.body;
    const indent = new Indent({
      project,
      branch,
      items,
      requestedBy: req.user.id,
    });
    await indent.save();
    res.status(201).json(indent);
  } catch (err) {
    res.status(400).json({ message: "Failed to create indent", error: err.message });
  }
});

// ✅ Get all indents with branch-based filtering
router.get("/", auth, filterByUserBranches, async (req, res) => {
  try {
    const { status, project, requestedBy, page = 1, limit = 10, search = '' } = req.query;
    const filter = {};
    
    // ✅ Apply branch-based filtering (deliverySite field)
    applySingleSiteBranchFilter(req, filter, 'deliverySite');
    
    if (status) filter.status = status;
    if (project) filter.project = project;
    if (requestedBy) filter.requestedBy = requestedBy;
    
    // Search by indentId
    if (search) {
      filter.indentId = { $regex: search, $options: 'i' };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Indent.countDocuments(filter);
    
    const indents = await Indent.find(filter)
      .populate("project", "name")
      .populate("branch", "name")
      .populate("requestedBy", "name role email")
      .populate("approvedBy", "name role")
      .populate("items.vendor", "companyName contact mobile email") // Populate vendor for each item
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    console.log(`✅ Fetched ${indents.length} indents (page ${page}/${Math.ceil(total / limit)})`);

    res.json({
      success: true,
      data: indents,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  } catch (err) {
    console.error('❌ Error fetching indents:', err);
    res.status(500).json({ 
      success: false,
      message: "Failed to fetch indents", 
      error: err.message 
    });
  }
});

// ✅ Approve/Reject indent (Admin)
router.put("/:id/status", auth, async (req, res) => {
  try {
    const { status, adminRemarks } = req.body;
    // Allow all valid statuses: pending, approved, rejected, delivered, transferred, cancelled
    const validStatuses = ["pending", "approved", "rejected", "delivered", "transferred", "cancelled"];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false,
        message: "Invalid status. Valid statuses are: " + validStatuses.join(", ") 
      });
    }

    const indent = await Indent.findByIdAndUpdate(
      req.params.id,
      { status, adminRemarks, approvedBy: req.user.id },
      { new: true }
    );

    if (!indent) {
      return res.status(404).json({ 
        success: false,
        message: "Indent not found" 
      });
    }

    // ✅ Sync status to UpcomingDelivery
    try {
      // Use indent._id to find the delivery (st_id stores the MongoDB _id)
      const delivery = await UpcomingDelivery.findOne({ st_id: indent._id.toString() });
      if (delivery) {
        // Map indent status to delivery status (valid: Pending, Partial, Transferred, Cancelled)
        let deliveryStatus = 'Pending';
        if (status === 'transferred') deliveryStatus = 'Transferred';
        else if (status === 'delivered') deliveryStatus = 'Transferred';
        else if (status === 'approved') deliveryStatus = 'Partial'; // ✅ CRITICAL FIX: Approved = Partial
        else if (status === 'pending') deliveryStatus = 'Pending';
        else if (status === 'rejected' || status === 'cancelled') deliveryStatus = 'Cancelled';
        
        delivery.status = deliveryStatus;
        await delivery.save();
        console.log(`🔄 Synced Indent ${indent.indentId} (${indent._id}) status to UpcomingDelivery: ${deliveryStatus}`);
      } else {
        console.log(`⚠️ No UpcomingDelivery found for Indent ${indent.indentId} (${indent._id})`);
      }
    } catch (syncErr) {
      console.error('⚠️ Failed to sync status to UpcomingDelivery:', syncErr.message);
      // Don't fail the request if sync fails
    }

    res.json({ 
      success: true,
      data: indent 
    });
  } catch (err) {
    res.status(400).json({ 
      success: false,
      message: "Failed to update indent", 
      error: err.message 
    });
  }
});

// ✅ APPROVE INDENT with vendor grouping
router.put("/:id/approve", auth, async (req, res) => {
  try {
    const indent = await Indent.findById(req.params.id)
      .populate('items.vendor', 'companyName contact mobile email')
      .populate('project', 'name')
      .populate('branch', 'name')
      .populate('requestedBy', 'name role');
    
    if (!indent) {
      return res.status(404).json({ 
        success: false,
        message: "Indent not found" 
      });
    }
    
    // Update status to approved
    indent.status = 'approved';
    indent.approvedBy = req.user.id;
    await indent.save();
    
    console.log('✅ Indent approved:', indent.indentId);
    console.log('📦 Items count:', indent.items?.length || 0);
    
    // Check if all items have vendors assigned
    const itemsWithoutVendor = indent.items.filter(item => !item.vendor);
    if (itemsWithoutVendor.length > 0) {
      console.warn('⚠️ Items without vendor:', itemsWithoutVendor.length);
      return res.status(400).json({
        success: false,
        message: `Cannot approve: ${itemsWithoutVendor.length} item(s) do not have a vendor assigned. Please assign vendors to all items before approval.`,
        itemsWithoutVendor: itemsWithoutVendor.map(item => item.name)
      });
    }
    
    // Group items by vendor
    const vendorGroups = {};
    
    indent.items.forEach((item, index) => {
      const vendorId = item.vendor?._id?.toString() || 'no-vendor';
      
      if (!vendorGroups[vendorId]) {
        vendorGroups[vendorId] = {
          vendorInfo: item.vendor || null,
          items: []
        };
      }
      
      vendorGroups[vendorId].items.push({
        ...item.toObject(),
        originalIndex: index
      });
    });
    
    console.log('🏭 Vendor groups:', Object.keys(vendorGroups).length);
    
    // Create separate UpcomingDelivery for each vendor with derived IDs
    const createdDeliveries = [];
    const vendorEntries = Object.entries(vendorGroups);
    let vendorSequence = 1;
    
    for (const [vendorId, group] of vendorEntries) {
      if (vendorId === 'no-vendor') {
        console.log('⚠️ Skipping items without vendor');
        continue;
      }
      
      const deliveryItems = group.items.map(item => ({
        itemId: item._id.toString(),
        name: item.name,
        category: item.category || '',  // ✅ Add for admin detail view
        sub_category: item.subCategory || '',  // ✅ Add for admin detail view
        sub_category1: item.subCategory1 || '',  // ✅ Add for admin detail view
        quantity: item.quantity,
        st_quantity: item.quantity,  // ✅ Required for "Requested" column in admin
        uom: item.unit || 'pcs',
        received_quantity: 0,
        is_received: false,
        remarks: item.remarks
      }));
      
      // ✅ Generate vendor-specific delivery ID with suffix: PO20251214-DS934-01, -02, -03
      const vendorSuffix = vendorSequence.toString().padStart(2, '0');
      const derivedDeliveryId = `${indent.indentId}-${vendorSuffix}`;
      
      // Create delivery entry for this vendor
      const delivery = new UpcomingDelivery({
        st_id: indent._id.toString(),
        source_type: 'Indent',
        source_id: indent.indentId,  // Base Intent ID (for tracking)
        transfer_number: derivedDeliveryId,  // Vendor-specific ID with suffix
        date: new Date(),
        from: group.vendorInfo?.companyName || 'Vendor/Supplier',  // ✅ Vendor name as 'From'
        to: indent.branch?.name || indent.project?.name || 'N/A',  // ✅ Delivery site as 'To'
        type: 'PO',  // REQUIRED field per UpcomingDelivery schema - DO NOT REMOVE
        vendor_name: group.vendorInfo?.companyName || 'Unknown Vendor',
        vendor_id: vendorId,
        delivery_site: indent.branch?.name || 'N/A',
        requested_by: indent.requestedBy?.name || 'Unknown',
        createdBy: indent.requestedBy?.name || 'Unknown',  // ✅ Add createdBy field
        items: deliveryItems,
        status: 'Pending',
        created_date: new Date()
      });
      
      await delivery.save();
      createdDeliveries.push(delivery);
      vendorSequence++;
      
      console.log(`✅ Created delivery ${derivedDeliveryId} for vendor: ${group.vendorInfo?.companyName} (${deliveryItems.length} items)`);
    }
    
    // Sync status to UpcomingDelivery if needed
    try {
      const delivery = await UpcomingDelivery.findOne({ st_id: indent._id.toString() });
      if (delivery) {
        delivery.status = 'Partial';
        await delivery.save();
        console.log(`🔄 Synced Indent ${indent.indentId} status to UpcomingDelivery: Partial`);
      }
    } catch (syncErr) {
      console.error('⚠️ Failed to sync status to UpcomingDelivery:', syncErr.message);
    }
    
    res.json({ 
      success: true,
      message: `Indent approved and ${createdDeliveries.length} delivery entries created`,
      data: {
        indent,
        deliveries: createdDeliveries
      }
    });
  } catch (err) {
    console.error('❌ Approve indent error:', err);
    res.status(400).json({ 
      success: false,
      message: "Failed to approve indent", 
      error: err.message 
    });
  }
});

// ✅ UPDATE INDENT (General update with status sync)
router.put("/:id", auth, async (req, res) => {
  try {
    // ✅ CRITICAL: Indents use 'items' not 'materials', and 'adminRemarks' not 'remarks'
    const { status, adminRemarks, items } = req.body;
    
    const updateData = {
      status,
      adminRemarks,
      items
    };
    
    // Remove undefined fields
    Object.keys(updateData).forEach(key => 
      updateData[key] === undefined && delete updateData[key]
    );
    
    const indent = await Indent.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    )
      .populate('project', 'name')
      .populate('branch', 'name')
      .populate('requestedBy', 'name role')
      .populate('approvedBy', 'name role')
      .populate('items.vendor', 'companyName contact mobile email'); // Populate vendor for each item
    
    if (!indent) {
      return res.status(404).json({ 
        success: false,
        message: "Indent not found" 
      });
    }
    
    // ✅ Sync status to UpcomingDelivery if status was updated
    if (status) {
      try {
        const delivery = await UpcomingDelivery.findOne({ st_id: indent._id.toString() });
        if (delivery) {
          // Map indent status to delivery status
          let deliveryStatus = 'Pending';
          if (status === 'transferred' || status === 'delivered') deliveryStatus = 'Transferred';
          else if (status === 'approved') deliveryStatus = 'Partial';
          else if (status === 'pending') deliveryStatus = 'Pending';
          else if (status === 'rejected' || status === 'cancelled') deliveryStatus = 'Cancelled';
          
          delivery.status = deliveryStatus;
          await delivery.save();
          console.log(`🔄 Synced Indent ${indent.indentId} status to UpcomingDelivery: ${deliveryStatus}`);
        }
      } catch (syncErr) {
        console.error('⚠️ Failed to sync status to UpcomingDelivery:', syncErr.message);
      }
    }
    
    res.json({ 
      success: true,
      data: indent 
    });
  } catch (err) {
    console.error('❌ Update indent error:', err);
    res.status(400).json({ 
      success: false,
      message: "Failed to update indent", 
      error: err.message 
    });
  }
});

// ✅ DELETE ALL indents - MUST BE BEFORE /:id route
router.delete('/all', auth, async (req, res) => {
  try {
    // Get all indent IDs before deletion
    const indents = await Indent.find({}, '_id');
    const indentIds = indents.map(indent => indent._id.toString());
    
    // Delete all associated upcoming deliveries (using st_id which stores the indent _id)
    const deliveryResult = await UpcomingDelivery.deleteMany({
      st_id: { $in: indentIds }
    });
    
    console.log(`🗑️ Deleted ${deliveryResult.deletedCount} associated upcoming deliveries`);
    
    // Delete all indents
    const result = await Indent.deleteMany({});
    
    res.json({
      success: true,
      message: `Successfully deleted all ${result.deletedCount} indents and ${deliveryResult.deletedCount} associated upcoming deliveries`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error('Delete all indents error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete all indents',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// ✅ Get single indent details
router.get("/:id", auth, async (req, res) => {
  try {
  const indent = await Indent.findById(req.params.id)
    .populate("project", "name")
    .populate("branch", "name")
    .populate("requestedBy", "name role")
    .populate("approvedBy", "name role")
    .populate("items.vendor", "companyName contact mobile email"); // Populate vendor for each item

  if (!indent) {
    return res.status(404).json({ 
      success: false,
      message: "Indent not found" 
    });
  }
  
  // ✅ Return consistent response format
  res.json({ 
    success: true,
    data: indent 
  });
} catch (err) {
    console.error('❌ Get indent error:', err);
    res.status(500).json({ 
      success: false,
      message: "Failed to fetch indent", 
      error: err.message 
    });
  }
});

// ✅ DELETE INDENT
router.delete("/:id", auth, async (req, res) => {
  try {
    const indent = await Indent.findById(req.params.id);
    
    if (!indent) {
      return res.status(404).json({ 
        success: false,
        message: 'Indent not found' 
      });
    }

    // Delete associated upcoming delivery
    await UpcomingDelivery.deleteMany({ st_id: req.params.id });

    // Delete image from Cloudinary if exists
    if (indent.imagePublicId) {
      try {
        await deleteFromCloudinary(indent.imagePublicId);
        console.log('✅ Deleted Cloudinary image:', indent.imagePublicId);
      } catch (cloudinaryErr) {
        console.error('⚠️ Failed to delete Cloudinary image:', cloudinaryErr.message);
        // Continue with indent deletion even if Cloudinary deletion fails
      }
    }

    await Indent.findByIdAndDelete(req.params.id);
    console.log('✅ Deleted indent:', req.params.id);

    res.json({ 
      success: true,
      message: 'Indent deleted successfully' 
    });
  } catch (err) {
    console.error('❌ Delete indent error:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to delete indent',
      error: err.message 
    });
  }
});

// ✅ UPLOAD INDENT PHOTO - NEW ENDPOINT
router.post("/upload-photo", upload.single('image'), async (req, res) => {
  try {
    console.log('📥 Upload photo request received');
    console.log('📄 Body:', req.body);
    console.log('📷 File:', req.file);

    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'No image file uploaded' 
      });
    }

    const { indentId, uploadedBy } = req.body;

    if (!indentId) {
      // Clean up uploaded file if validation fails
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ 
        success: false,
        message: 'Indent ID is required' 
      });
    }

    // ✅ Generate absolute file URL with backend domain
    const baseURL = process.env.BACKEND_URL || 'https://laxmipowertech-backend-1.onrender.com';
    const fileUrl = `${baseURL}/uploads/indents/${req.file.filename}`;

    console.log('✅ File uploaded successfully');
    console.log('🆔 Indent ID:', indentId);
    console.log('📁 File path:', req.file.path);
    console.log('🌐 File URL:', fileUrl);

    // ✅ CREATE INDENT RECORD IN DATABASE
    const indent = new Indent({
      indentId: indentId,
      imageUrl: fileUrl,
      requestedBy: uploadedBy,
      status: 'pending',
      items: [] // Empty items array, will be populated later if needed
    });

    await indent.save();
    console.log('✅ Indent record created in database:', indent._id);

    // ⚠️ CRITICAL: DO NOT auto-create UpcomingDelivery on intent creation
    // 
    // WHY THIS CODE IS DISABLED:
    // 1. Creates deliveries BEFORE admin approval (violates requirement)
    // 2. Uses generic "Vendor" and "Site" values (not actual vendor names)
    // 3. Items array is empty (no material information)
    // 4. NO vendor grouping (violates requirement for vendor-wise grouping)
    // 5. Causes pending intents to appear in Upcoming Deliveries prematurely
    // 
    // CORRECT FLOW:
    // Client creates intent → Admin assigns vendors → Admin approves →
    // /approve endpoint groups materials by vendor → Creates vendor-wise deliveries
    // 
    console.log('✅ Indent created - awaiting admin approval for delivery creation');
    
    // INTENTIONALLY DISABLED - Do not re-enable this code
    // try {
    //   const upcomingDelivery = new UpcomingDelivery({
    //     st_id: indent._id.toString(),
    //     transfer_number: indentId,
    //     from: 'Vendor',  // ❌ Generic value
    //     to: req.body.project || 'Site',  // ❌ Generic value
    //     items: [],  // ❌ Empty array
    //     type: 'PO'
    //   });
    //   await upcomingDelivery.save();
    // } catch (deliveryErr) {...}

    // Return success response
    res.status(200).json({
      success: true,
      message: 'Intent list uploaded successfully',
      data: {
        _id: indent._id,
        indentId: indent.indentId,
        imageUrl: indent.imageUrl,
        filename: req.file.filename,
        uploadedBy: indent.requestedBy,
        status: indent.status,
        createdAt: indent.createdAt
      }
    });

  } catch (err) {
    console.error('❌ Upload photo error:', err);
    
    // Clean up file if it was uploaded but processing failed
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    
    res.status(500).json({ 
      success: false,
      message: 'Failed to upload intent list',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// ✅ MANUAL SYNC ENDPOINT (for debugging/testing)
router.post("/sync-all", auth, async (req, res) => {
  try {
    const indents = await Indent.find({});
    let synced = 0;
    let failed = 0;
    
    for (const indent of indents) {
      try {
        const delivery = await UpcomingDelivery.findOne({ st_id: indent._id.toString() });
        if (delivery) {
          // Map indent status to delivery status (valid: Pending, Partial, Transferred, Cancelled)
          let deliveryStatus = 'Pending';
          if (indent.status === 'transferred') deliveryStatus = 'Transferred';
          else if (indent.status === 'delivered') deliveryStatus = 'Transferred';
          else if (indent.status === 'approved') deliveryStatus = 'Partial'; // ✅ Approved = Partial
          else if (indent.status === 'pending') deliveryStatus = 'Pending';
          else if (indent.status === 'rejected' || indent.status === 'cancelled') deliveryStatus = 'Cancelled';
          
          delivery.status = deliveryStatus;
          await delivery.save();
          synced++;
          console.log(`✅ Synced ${indent.indentId}: ${indent.status} → ${deliveryStatus}`);
        }
      } catch (err) {
        failed++;
        console.error(`❌ Failed to sync ${indent.indentId}:`, err.message);
      }
    }
    
    res.json({
      success: true,
      message: `Synced ${synced} indents, ${failed} failed`,
      synced,
      failed
    });
  } catch (err) {
    res.status(500).json({
      success: false,
      message: 'Sync failed',
      error: err.message
    });
  }
});


export default router;
