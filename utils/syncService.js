/**
 * Sync Service - Two-way synchronization between Material Transfer and Upcoming Delivery
 * Prevents circular updates and ensures data consistency
 */

import SiteTransfer from '../models/SiteTransfer.js';
import PurchaseOrder from '../models/PurchaseOrder.js';
import UpcomingDelivery from '../models/UpcomingDelivery.js';

/**
 * Calculate status based on items
 * @param {Array} items - Array of items with quantity/st_quantity and received_quantity
 * @returns {String} - Status: 'Pending', 'Partial', or 'Transferred'
 * 
 * Logic:
 * - requested == received → Transferred
 * - requested > received (and received > 0) → Partial
 * - received == 0 → Pending
 */
export const calculateDeliveryStatus = (items) => {
  if (!items || items.length === 0) return 'Pending';
  
  // Check if all materials are fully received
  const allReceived = items.every(item => {
    const requestedQty = item.quantity || item.st_quantity || 0;
    const receivedQty = item.received_quantity || 0;
    // Both conditions: checkbox checked AND quantity matches
    return item.is_received && receivedQty >= requestedQty;
  });
  
  // Check if no materials received at all
  const noneReceived = items.every(item => {
    const receivedQty = item.received_quantity || 0;
    return receivedQty === 0;
  });
  
  if (allReceived) return 'Transferred';
  if (noneReceived) return 'Pending';
  return 'Partial';
};

/**
 * Map delivery status to site transfer/PO status
 * @param {String} deliveryStatus - Upcoming Delivery status
 * @returns {String} - Site Transfer/PO status
 */
export const mapToSourceStatus = (deliveryStatus) => {
  const statusMap = {
    'Pending': 'pending',
    'Partial': 'approved', // Partial delivery = approved/in-progress
    'Transferred': 'transferred',
    'Cancelled': 'cancelled'
  };
  return statusMap[deliveryStatus] || 'pending';
};

/**
 * Map site transfer/PO status to delivery status
 * @param {String} sourceStatus - Site Transfer or PO status
 * @returns {String} - Upcoming Delivery status
 */
export const mapToDeliveryStatus = (sourceStatus) => {
  const statusMap = {
    'pending': 'Pending',
    'approved': 'Partial',
    'transferred': 'Transferred',
    'cancelled': 'Cancelled'
  };
  return statusMap[sourceStatus?.toLowerCase()] || 'Pending';
};

/**
 * Sync from Upcoming Delivery to Site Transfer
 * Called when Upcoming Delivery is updated
 * @param {String} stId - Site Transfer ID
 * @param {Object} updates - Updates to apply
 * @param {Boolean} skipSync - Flag to prevent circular updates
 */
export const syncToSiteTransfer = async (stId, updates, skipSync = false) => {
  if (skipSync) return; // Prevent circular updates
  
  try {
    const siteTransfer = await SiteTransfer.findOne({ siteTransferId: stId });
    if (!siteTransfer) {
      console.warn(`⚠️  Site Transfer not found for st_id: ${stId}`);
      return;
    }

    let hasChanges = false;
    const updateData = {};

    // Sync status
    if (updates.status && updates.status !== mapToDeliveryStatus(siteTransfer.status)) {
      updateData.status = mapToSourceStatus(updates.status);
      hasChanges = true;
    }

    // Sync items if provided
    if (updates.items && Array.isArray(updates.items)) {
      // Update material quantities based on received quantities
      const updatedMaterials = siteTransfer.materials.map((material) => {
        const deliveryItem = updates.items.find(item => item.itemId === material._id.toString());
        if (deliveryItem) {
          return {
            ...material.toObject(),
            received_quantity: deliveryItem.received_quantity || 0,
            is_received: deliveryItem.is_received || false
          };
        }
        return material;
      });
      updateData.materials = updatedMaterials;
      hasChanges = true;
    }

    if (hasChanges) {
      updateData.updatedAt = Date.now();
      await SiteTransfer.findByIdAndUpdate(siteTransfer._id, updateData);
      console.log(`✅ Synced to Site Transfer: ${stId} - Status: ${updateData.status || 'unchanged'}`);
    }
  } catch (error) {
    console.error(`❌ Error syncing to Site Transfer (${stId}):`, error.message);
  }
};

/**
 * Sync from Upcoming Delivery to Purchase Order
 * Called when Upcoming Delivery is updated
 * @param {String} poId - Purchase Order ID
 * @param {Object} updates - Updates to apply
 * @param {Boolean} skipSync - Flag to prevent circular updates
 */
export const syncToPurchaseOrder = async (poId, updates, skipSync = false) => {
  if (skipSync) return; // Prevent circular updates
  
  try {
    const purchaseOrder = await PurchaseOrder.findOne({ purchaseOrderId: poId });
    if (!purchaseOrder) {
      console.warn(`⚠️  Purchase Order not found for po_id: ${poId}`);
      return;
    }

    let hasChanges = false;
    const updateData = {};

    // Sync status - ALWAYS sync if status is provided
    if (updates.status) {
      const mappedStatus = mapToSourceStatus(updates.status);
      console.log(`🔄 Syncing PO status: ${updates.status} → ${mappedStatus} (current: ${purchaseOrder.status})`);
      if (mappedStatus !== purchaseOrder.status) {
        updateData.status = mappedStatus;
        hasChanges = true;
      } else {
        console.log('ℹ️ Status unchanged, skipping update');
      }
    }

    // Sync items if provided
    if (updates.items && Array.isArray(updates.items)) {
      // Update material quantities based on received quantities
      const updatedMaterials = purchaseOrder.materials.map((material) => {
        const deliveryItem = updates.items.find(item => item.itemId === material._id.toString());
        if (deliveryItem) {
          return {
            ...material.toObject(),
            received_quantity: deliveryItem.received_quantity || 0,
            is_received: deliveryItem.is_received || false
          };
        }
        return material;
      });
      updateData.materials = updatedMaterials;
      hasChanges = true;
    }

    if (hasChanges) {
      updateData.updatedAt = Date.now();
      await PurchaseOrder.findByIdAndUpdate(purchaseOrder._id, updateData);
      console.log(`✅ Synced to Purchase Order: ${poId} - Status: ${updateData.status || 'unchanged'}`);
    }
  } catch (error) {
    console.error(`❌ Error syncing to Purchase Order (${poId}):`, error.message);
  }
};

/**
 * Sync from Site Transfer or Purchase Order to Upcoming Delivery
 * Called when Site Transfer or PO is updated
 * @param {String} sourceId - Site Transfer ID or PO ID
 * @param {Object} updates - Updates to apply
 * @param {Boolean} skipSync - Flag to prevent circular updates
 */
export const syncToUpcomingDelivery = async (sourceId, updates, skipSync = false) => {
  if (skipSync) return; // Prevent circular updates
  
  try {
    const delivery = await UpcomingDelivery.findOne({ st_id: sourceId });
    if (!delivery) {
      console.warn(`⚠️  Upcoming Delivery not found for source_id: ${sourceId}`);
      return;
    }

    let hasChanges = false;
    const updateData = {};

    // Sync status - ALWAYS sync if status is provided
    if (updates.status) {
      const newDeliveryStatus = mapToDeliveryStatus(updates.status);
      if (newDeliveryStatus !== delivery.status) {
        updateData.status = newDeliveryStatus;
        hasChanges = true;
        console.log(`🔄 Syncing status: ${updates.status} → ${newDeliveryStatus}`);
      }
    }

    // Sync materials to items - UPDATE ALL FIELDS INCLUDING QUANTITY
    if (updates.materials && Array.isArray(updates.materials)) {
      const updatedItems = delivery.items.map((item) => {
        const material = updates.materials.find(m => m._id.toString() === item.itemId);
        if (material) {
          return {
            ...item.toObject(),
            // ✅ CRITICAL FIX: Update st_quantity when material quantity changes
            st_quantity: material.quantity || item.st_quantity,
            // ✅ Update category fields if they changed
            category: material.category || item.category,
            sub_category: material.subCategory || item.sub_category,
            sub_category1: material.subCategory1 || item.sub_category1,
            // Keep received quantities (only updated via GRN)
            received_quantity: material.received_quantity || item.received_quantity || 0,
            is_received: material.is_received || item.is_received || false
          };
        }
        return item;
      });
      
      // Only recalculate status from items if status wasn't explicitly provided
      if (!updates.status) {
        const calculatedStatus = calculateDeliveryStatus(updatedItems);
        updateData.status = calculatedStatus;
      }
      updateData.items = updatedItems;
      hasChanges = true;
    }

    if (hasChanges) {
      updateData.updatedAt = Date.now();
      await UpcomingDelivery.findByIdAndUpdate(delivery._id, updateData);
      console.log(`✅ Synced to Upcoming Delivery: ${sourceId} - Status: ${updateData.status || 'unchanged'}`);
    }
  } catch (error) {
    console.error(`❌ Error syncing to Upcoming Delivery (${sourceId}):`, error.message);
  }
};

/**
 * Sync status change from either side
 * @param {String} sourceId - Site Transfer ID or PO ID
 * @param {String} newStatus - New status value
 * @param {String} source - Source of update: 'siteTransfer', 'purchaseOrder', or 'upcomingDelivery'
 * @param {String} type - Type: 'ST' or 'PO'
 */
export const syncStatusChange = async (sourceId, newStatus, source = 'upcomingDelivery', type = 'ST') => {
  try {
    if (source === 'upcomingDelivery') {
      // Update came from Upcoming Delivery, sync to source
      if (type === 'ST') {
        await syncToSiteTransfer(sourceId, { status: newStatus }, false);
      } else if (type === 'PO') {
        await syncToPurchaseOrder(sourceId, { status: newStatus }, false);
      }
    } else {
      // Update came from Site Transfer or PO, sync to Upcoming Delivery
      await syncToUpcomingDelivery(sourceId, { status: newStatus }, false);
    }
  } catch (error) {
    console.error(`❌ Error in syncStatusChange (${sourceId}):`, error.message);
  }
};

/**
 * Delete Upcoming Delivery when Site Transfer or PO is deleted
 * @param {String} sourceId - Site Transfer ID or PO ID
 */
export const deleteUpcomingDeliveryBySourceId = async (sourceId) => {
  try {
    const result = await UpcomingDelivery.findOneAndDelete({ st_id: sourceId });
    if (result) {
      console.log(`✅ Deleted Upcoming Delivery for source_id: ${sourceId}`);
    }
  } catch (error) {
    console.error(`❌ Error deleting Upcoming Delivery (${sourceId}):`, error.message);
  }
};

export default {
  syncToSiteTransfer,
  syncToPurchaseOrder,
  syncToUpcomingDelivery,
  syncStatusChange,
  calculateDeliveryStatus,
  mapToSourceStatus,
  mapToDeliveryStatus,
  deleteUpcomingDeliveryBySourceId
};