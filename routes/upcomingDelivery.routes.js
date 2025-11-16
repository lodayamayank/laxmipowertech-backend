import express from 'express';
import UpcomingDelivery from '../models/UpcomingDelivery.js';
import SiteTransfer from '../models/SiteTransfer.js';
import PurchaseOrder from '../models/PurchaseOrder.js';

const router = express.Router();

// GET all upcoming deliveries
router.get('/', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const search = req.query.search || '';
    const skip = (page - 1) * limit;

    const query = search ? {
      $or: [
        { transfer_number: { $regex: search, $options: 'i' } },
        { from: { $regex: search, $options: 'i' } },
        { to: { $regex: search, $options: 'i' } },
        { createdBy: { $regex: search, $options: 'i' } }
      ]
    } : {};

    const deliveries = await UpcomingDelivery.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await UpcomingDelivery.countDocuments(query);

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
router.get('/:id', async (req, res) => {
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
router.post('/', async (req, res) => {
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

    // Auto-update status based on items
    const allReceived = delivery.items.every(item => item.is_received);
    const someReceived = delivery.items.some(item => item.is_received);
    
    if (allReceived) {
      delivery.status = 'Transferred';
    } else if (someReceived) {
      delivery.status = 'Partial';
    } else {
      delivery.status = 'Pending';
    }

    await delivery.save();

    // Sync back to source (SiteTransfer or PurchaseOrder)
    if (delivery.type === 'ST') {
      const siteTransfer = await SiteTransfer.findOne({ siteTransferId: delivery.st_id });
      if (siteTransfer) {
        delivery.items.forEach(deliveryItem => {
          const materialIndex = siteTransfer.materials.findIndex(
            mat => mat._id.toString() === deliveryItem.itemId
          );
          if (materialIndex !== -1) {
            siteTransfer.materials[materialIndex].received_quantity = deliveryItem.received_quantity;
            siteTransfer.materials[materialIndex].is_received = deliveryItem.is_received;
          }
        });
        
        const allMaterialsReceived = siteTransfer.materials.every(mat => mat.is_received);
        if (allMaterialsReceived) {
          siteTransfer.status = 'transferred';
        }
        
        await siteTransfer.save();
      }
    } else if (delivery.type === 'PO') {
      const purchaseOrder = await PurchaseOrder.findOne({ purchaseOrderId: delivery.st_id });
      if (purchaseOrder) {
        delivery.items.forEach(deliveryItem => {
          const materialIndex = purchaseOrder.materials.findIndex(
            mat => mat._id.toString() === deliveryItem.itemId
          );
          if (materialIndex !== -1) {
            purchaseOrder.materials[materialIndex].received_quantity = deliveryItem.received_quantity;
            purchaseOrder.materials[materialIndex].is_received = deliveryItem.is_received;
          }
        });
        
        const allMaterialsReceived = purchaseOrder.materials.every(mat => mat.is_received);
        if (allMaterialsReceived) {
          purchaseOrder.status = 'transferred';
        }
        
        await purchaseOrder.save();
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