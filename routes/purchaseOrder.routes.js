import express from 'express';
import PurchaseOrder from '../models/PurchaseOrder.js';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { syncToUpcomingDelivery as syncServiceToUpcomingDelivery, deleteUpcomingDeliveryBySourceId } from '../utils/syncService.js';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Create uploads directory
const uploadsDir = path.join(__dirname, '../uploads/purchaseOrders');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Configure multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '_' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = /jpeg|jpg|png|gif|webp|bmp|pdf/;
  const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
  const mimetype = allowedTypes.test(file.mimetype) || file.mimetype === 'application/pdf';
  
  if (extname && mimetype) {
    cb(null, true);
  } else {
    cb(new Error('Only image and PDF files are allowed!'), false);
  }
};

const upload = multer({
  storage: storage,
  fileFilter: fileFilter,
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB
});

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
    const items = purchaseOrder.materials.map(mat => ({
      itemId: mat._id.toString(),
      category: mat.category || '',
      sub_category: mat.subCategory || '',
      sub_category1: mat.subCategory1 || '',
      st_quantity: mat.quantity || 0,
      received_quantity: mat.received_quantity || 0,
      is_received: mat.is_received || false
    }));

    const deliveryData = {
      st_id: purchaseOrder.purchaseOrderId,
      transfer_number: purchaseOrder.purchaseOrderId,
      date: purchaseOrder.requestDate,
      from: 'Vendor/Supplier',
      to: purchaseOrder.deliverySite,
      items: items,
      status: 'Pending',
      type: 'PO',
      createdBy: purchaseOrder.requestedBy
    };

    const existing = await UpcomingDelivery.findOne({ st_id: purchaseOrder.purchaseOrderId });
    
    if (existing) {
      await UpcomingDelivery.findByIdAndUpdate(existing._id, deliveryData);
    } else {
      await UpcomingDelivery.create(deliveryData);
    }
  } catch (err) {
    console.error('Sync to UpcomingDelivery failed:', err.message);
  }
};

// CREATE purchase order
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
    
    const { requestedBy, deliverySite, status, remarks } = req.body;
    
    if (!requestedBy || !deliverySite) {
      return res.status(400).json({ 
        success: false,
        message: 'Missing required fields: requestedBy, deliverySite' 
      });
    }

    const purchaseOrderId = await generatePurchaseOrderId();
    const attachments = req.files ? req.files.map(f => `/uploads/purchaseOrders/${f.filename}`) : [];

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
    await syncToUpcomingDelivery(purchaseOrder);

    res.status(201).json({
      success: true,
      message: 'Purchase order created successfully',
      data: purchaseOrder
    });
  } catch (err) {
    console.error('Create purchase order error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to create purchase order',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
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
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await PurchaseOrder.countDocuments(query);

    res.json({
      success: true,
      data: orders,
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
    const order = await PurchaseOrder.findById(req.params.id);
    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }
    res.json({ success: true, data: order });
  } catch (err) {
    console.error('Get purchase order error:', err.message);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch purchase order',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
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
      const newAttachments = req.files.map(f => `/uploads/purchaseOrders/${f.filename}`);
      const existingOrder = await PurchaseOrder.findById(req.params.id);
      updateData.attachments = [...(existingOrder.attachments || []), ...newAttachments];
    }

    const order = await PurchaseOrder.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );

    if (!order) {
      return res.status(404).json({
        success: false,
        message: 'Purchase order not found'
      });
    }

    // ✅ Sync to UpcomingDelivery using sync service
    await syncServiceToUpcomingDelivery(order.purchaseOrderId, {
      status: order.status,
      materials: order.materials
    });
    console.log(`🔄 Synced PurchaseOrder ${order.purchaseOrderId} to UpcomingDelivery`);

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

    const attachmentPath = order.attachments[index];
    const filePath = path.join(__dirname, '..', attachmentPath);
    
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
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