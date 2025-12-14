import express from 'express';
import SiteTransfer from '../models/SiteTransfer.js';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import { syncToUpcomingDelivery as syncServiceToUpcomingDelivery, deleteUpcomingDeliveryBySourceId } from '../utils/syncService.js';
import { 
  upload, 
  uploadMultipleToCloudinary,
  deleteFromCloudinary,
  deleteMultipleFromCloudinary,
  extractPublicId 
} from '../middleware/cloudinaryMaterialMiddleware.js';

const router = express.Router();

// Generate unique siteTransferId
const generateSiteTransferId = async () => {
  const date = new Date();
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const ymd = `${year}${month}${day}`;
  
  const suffix = Math.random().toString(36).slice(2, 7).toUpperCase();
  const siteTransferId = `ST${ymd}-${suffix}`;
  
  const existing = await SiteTransfer.findOne({ siteTransferId });
  if (existing) {
    return generateSiteTransferId();
  }
  
  return siteTransferId;
};

// Sync to UpcomingDelivery
const syncToUpcomingDelivery = async (siteTransfer) => {
  try {
    const items = siteTransfer.materials.map(mat => ({
      itemId: mat._id.toString(),
      category: mat.itemName || '',
      sub_category: '',
      sub_category1: '',
      st_quantity: mat.quantity || 0,
      received_quantity: mat.received_quantity || 0,
      is_received: mat.is_received || false
    }));

    // ✅ CRITICAL FIX: Map SiteTransfer status to UpcomingDelivery status
    // Approved → Approved (NOT Partial)
    // Partial status is determined by received_quantity vs st_quantity, not by approval
    let deliveryStatus = 'Pending';
    if (siteTransfer.status === 'transferred') deliveryStatus = 'Transferred';
    else if (siteTransfer.status === 'approved') deliveryStatus = 'Approved';  // ✅ FIX: Approved, not Partial
    else if (siteTransfer.status === 'pending') deliveryStatus = 'Pending';
    else if (siteTransfer.status === 'cancelled') deliveryStatus = 'Cancelled';
    
    // ✅ Check if any materials are partially received (override to Partial if applicable)
    const hasPartiallyReceived = siteTransfer.materials.some(mat => {
      const received = mat.received_quantity || 0;
      const total = mat.quantity || 0;
      return received > 0 && received < total;
    });
    
    if (hasPartiallyReceived && deliveryStatus === 'Approved') {
      deliveryStatus = 'Partial';  // ✅ Only use Partial when materials are actually partially received
    }

    const deliveryData = {
      st_id: siteTransfer.siteTransferId,
      transfer_number: siteTransfer.siteTransferId,
      date: siteTransfer.requestDate,
      from: siteTransfer.fromSite,
      to: siteTransfer.toSite,
      items: items,
      status: deliveryStatus,  // ✅ Use mapped status instead of hardcoded 'Pending'
      type: 'ST',
      createdBy: siteTransfer.requestedBy,
      attachments: siteTransfer.attachments || []  // ✅ SYNC ATTACHMENTS from Site Transfer to Upcoming Deliveries
    };

    const existing = await UpcomingDelivery.findOne({ st_id: siteTransfer.siteTransferId });
    
    if (existing) {
      await UpcomingDelivery.findByIdAndUpdate(existing._id, deliveryData);
    } else {
      await UpcomingDelivery.create(deliveryData);
    }
  } catch (err) {
    console.error('Sync to UpcomingDelivery failed:', err.message);
  }
};

// CREATE site transfer
router.post('/', upload.array('attachments', 10), async (req, res) => {
  try {
    let materials = req.body.materials;
    if (typeof materials === 'string') {
      try {
        materials = JSON.parse(materials);
      } catch (e) {
        return res.status(400).json({ 
          success: false,
          message: 'Invalid materials format' 
        });
      }
    }
    
    const { fromSite, toSite, requestedBy, status } = req.body;
    
    if (!fromSite || !toSite || !requestedBy) {
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields: fromSite, toSite, requestedBy' 
      });
    }

    const siteTransferId = await generateSiteTransferId();
    
    // ✅ UPLOAD ATTACHMENTS TO CLOUDINARY
    let attachments = [];
    if (req.files && req.files.length > 0) {
      console.log(`☁️ Uploading ${req.files.length} attachments to Cloudinary...`);
      const cloudinaryResults = await uploadMultipleToCloudinary(
        req.files, 
        'material-transfer/site-transfers'
      );
      attachments = cloudinaryResults.map(result => ({
        url: result.url,
        publicId: result.publicId
      }));
      console.log(`✅ Uploaded ${attachments.length} attachments to Cloudinary`);
    }

    const siteTransfer = new SiteTransfer({
      siteTransferId,
      fromSite,
      toSite,
      requestedBy,
      materials: materials || [],
      status: status || 'pending',
      attachments,
      requestDate: new Date()
    });

    await siteTransfer.save();
    
    // ✅ DO NOT sync to Upcoming Delivery on creation
    // Sync only happens after admin approval (in update endpoint)
    console.log(`✅ Site transfer created: ${siteTransferId} (status: ${siteTransfer.status})`);
    console.log(`⏳ Waiting for admin approval before creating Upcoming Delivery`);

    res.status(201).json({
      success: true,
      message: 'Site transfer created successfully',
      data: siteTransfer
    });
  } catch (err) {
    console.error('Create site transfer error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create site transfer',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// GET all site transfers
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const transfers = await SiteTransfer.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await SiteTransfer.countDocuments();

    res.json({
      success: true,
      data: transfers,
      pagination: {
        page,
        limit,
        total,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (err) {
    console.error('Get site transfers error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch site transfers',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// DELETE ALL site transfers - MUST BE BEFORE /:id route
router.delete('/all', async (req, res) => {
  try {
    // Get all site transfer IDs before deletion
    const siteTransfers = await SiteTransfer.find({}, 'siteTransferId');
    const transferIds = siteTransfers.map(st => st.siteTransferId);
    
    // Delete all associated upcoming deliveries (using st_id which stores siteTransferId)
    const deliveryResult = await UpcomingDelivery.deleteMany({
      st_id: { $in: transferIds }
    });
    
    console.log(`🗑️ Deleted ${deliveryResult.deletedCount} associated upcoming deliveries`);
    
    // Delete all site transfers
    const result = await SiteTransfer.deleteMany({});
    
    res.json({
      success: true,
      message: `Successfully deleted all ${result.deletedCount} site transfers and ${deliveryResult.deletedCount} associated upcoming deliveries`,
      deletedCount: result.deletedCount
    });
  } catch (err) {
    console.error('Delete all site transfers error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete all site transfers',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// GET site transfer by ID
router.get('/:id', async (req, res) => {
  try {
    const transfer = await SiteTransfer.findById(req.params.id);
    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: 'Site transfer not found'
      });
    }
    res.json({ success: true, data: transfer });
  } catch (err) {
    console.error('Get site transfer error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch site transfer',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// UPDATE site transfer
router.put('/:id', upload.array('attachments', 10), async (req, res) => {
  try {
    let materials = req.body.materials;
    if (typeof materials === 'string') {
      materials = JSON.parse(materials);
    }

    const updateData = {
      fromSite: req.body.fromSite,
      toSite: req.body.toSite,
      requestedBy: req.body.requestedBy,
      materials: materials,
      status: req.body.status
    };

    const attachments = [];
    if (req.files && req.files.length > 0) {
      // Use absolute URLs with backend domain for images
      const baseURL = process.env.BACKEND_URL || 'https://laxmipowertech-backend.onrender.com';
      req.files.forEach(file => {
        attachments.push(`${baseURL}/uploads/siteTransfers/${file.filename}`);
      });
    }

    const existingTransfer = await SiteTransfer.findById(req.params.id);
    updateData.attachments = [...(existingTransfer.attachments || []), ...attachments];

    const transfer = await SiteTransfer.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: 'Site transfer not found'
      });
    }

    // ✅ CRITICAL: Only sync to Upcoming Delivery when status is 'approved' or 'transferred'
    // This matches the Intent lifecycle exactly: pending → NOT synced → approved → SYNCED to Upcoming Deliveries
    const shouldSync = transfer.status === 'approved' || transfer.status === 'transferred';
    
    if (shouldSync) {
      await syncToUpcomingDelivery(transfer);
      console.log(`✅ Synced SiteTransfer ${transfer.siteTransferId} to UpcomingDelivery (status: ${transfer.status})`);
    } else {
      console.log(`⏸️ Skipping sync for SiteTransfer ${transfer.siteTransferId} (status: ${transfer.status} - not approved yet)`);
      
      // ✅ Cleanup: If status changed FROM approved/transferred TO pending/cancelled, remove from UpcomingDelivery
      if (transfer.status === 'pending' || transfer.status === 'cancelled') {
        const existing = await UpcomingDelivery.findOne({ st_id: transfer.siteTransferId });
        if (existing) {
          await UpcomingDelivery.findByIdAndDelete(existing._id);
          console.log(`�️ Removed SiteTransfer ${transfer.siteTransferId} from UpcomingDelivery (status reverted to ${transfer.status})`);
        }
      }
    }

    res.json({
      success: true,
      message: 'Site transfer updated successfully',
      data: transfer
    });
  } catch (err) {
    console.error('Update site transfer error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to update site transfer',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// DELETE site transfer
router.delete('/:id', async (req, res) => {
  try {
    const transfer = await SiteTransfer.findByIdAndDelete(req.params.id);
    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: 'Site transfer not found'
      });
    }

    // ✅ Delete from UpcomingDelivery using sync service
    await deleteUpcomingDeliveryBySourceId(transfer.siteTransferId);

    // Delete attachments
    if (transfer.attachments && transfer.attachments.length > 0) {
      transfer.attachments.forEach(att => {
        const filePath = path.join(__dirname, '..', att);
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
    }

    res.json({
      success: true,
      message: 'Site transfer deleted successfully'
    });
  } catch (err) {
    console.error('Delete site transfer error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to delete site transfer',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// DELETE attachment
router.delete('/:id/attachments/:attachmentIndex', async (req, res) => {
  try {
    const transfer = await SiteTransfer.findById(req.params.id);
    if (!transfer) {
      return res.status(404).json({
        success: false,
        message: 'Site transfer not found'
      });
    }

    const index = parseInt(req.params.attachmentIndex);
    if (index < 0 || index >= transfer.attachments.length) {
      return res.status(400).json({
        success: false,
        message: 'Invalid attachment index'
      });
    }

    const attachmentPath = transfer.attachments[index];
    const filePath = path.join(__dirname, '..', attachmentPath);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    transfer.attachments.splice(index, 1);
    await transfer.save();

    res.json({
      success: true,
      message: 'Attachment deleted successfully',
      data: transfer
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