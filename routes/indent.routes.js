import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import auth from "../middleware/authMiddleware.js";
import Indent from "../models/Indent.js";
import UpcomingDelivery from "../models/UpcomingDelivery.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// ✅ CREATE UPLOADS/INDENTS DIRECTORY
const indentsUploadDir = path.join(__dirname, '..', 'uploads', 'indents');
if (!fs.existsSync(indentsUploadDir)) {
  fs.mkdirSync(indentsUploadDir, { recursive: true });
  console.log('✅ Created directory:', indentsUploadDir);
}

// ✅ MULTER CONFIGURATION FOR INDENT PHOTO UPLOADS
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, indentsUploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'indent-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|webp/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

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

// ✅ Get all indents (Admin side, with filters and pagination)
router.get("/", auth, async (req, res) => {
  try {
    const { status, project, requestedBy, page = 1, limit = 10, search = '' } = req.query;
    const filter = {};
    
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

// ✅ UPDATE INDENT (General update with status sync)
router.put("/:id", auth, async (req, res) => {
  try {
    const { status, remarks, requestedBy, deliverySite, materials } = req.body;
    
    const updateData = {
      status,
      remarks,
      requestedBy,
      deliverySite,
      materials
    };
    
    // Remove undefined fields
    Object.keys(updateData).forEach(key => 
      updateData[key] === undefined && delete updateData[key]
    );
    
    const indent = await Indent.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
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
      .populate("approvedBy", "name role");

    if (!indent) return res.status(404).json({ message: "Indent not found" });
    res.json(indent);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch indent", error: err.message });
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

    // Delete image file if exists
    if (indent.imageUrl) {
      const imagePath = path.join(__dirname, '..', indent.imageUrl);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
        console.log('✅ Deleted image file:', imagePath);
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

    // Generate file URL
    const fileUrl = `/uploads/indents/${req.file.filename}`;

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

    // ✅ CREATE UPCOMING DELIVERY ENTRY
    try {
      const upcomingDelivery = new UpcomingDelivery({
        st_id: indent._id.toString(),
        transfer_number: indentId,
        date: new Date(),
        from: 'Vendor', // Default for PO
        to: req.body.project || 'Site', // Use project from form
        items: [], // Empty items initially, can be populated later
        status: 'Pending',
        type: 'PO', // Purchase Order type
        createdBy: uploadedBy || 'system'
      });
      
      await upcomingDelivery.save();
      console.log('✅ UpcomingDelivery created:', upcomingDelivery._id);
    } catch (deliveryErr) {
      console.error('⚠️ Failed to create UpcomingDelivery:', deliveryErr);
      // Don't fail the whole request if upcoming delivery creation fails
    }

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
