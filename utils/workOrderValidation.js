import WorkOrder from '../models/WorkOrder.js';
import Bill from '../models/Bill.js';
import UpcomingDelivery from '../models/UpcomingDelivery.js';

/**
 * Validates if a new amount can be added without exceeding Work Order limit
 * @param {String} projectId - Project ID (ObjectId or string)
 * @param {Number} newAmount - New amount to be added
 * @param {String} excludeId - ID to exclude from calculation (for updates)
 * @param {String} type - Type of validation: 'bill', 'grn', or 'invoice'
 * @returns {Promise<Object>} { valid: Boolean, message: String, details: Object }
 */
export const validateWorkOrderLimit = async (projectId, newAmount, excludeId = null, type = 'grn') => {
  try {
    // Find all active work orders for this project
    const workOrders = await WorkOrder.find({ 
      project: projectId,
      isTriggered: false // Only consider non-triggered work orders
    });

    if (!workOrders || workOrders.length === 0) {
      return {
        valid: false,
        message: 'No active Work Order found for this project. Please create a Work Order first.',
        details: {
          totalWOAmount: 0,
          totalBilled: 0,
          totalGRN: 0,
          remaining: 0
        }
      };
    }

    // Calculate total WO amount for the project
    const totalWOAmount = workOrders.reduce((sum, wo) => sum + (wo.totalValue || 0), 0);

    // Calculate total bills amount
    const totalBillsAmount = workOrders.reduce((sum, wo) => sum + (wo.totalBillsAmount || 0), 0);

    // Calculate total GRN/Invoice amount (excluding the one being updated)
    let grnQuery = { 
      project: projectId,
      'billing.finalAmount': { $exists: true, $gt: 0 }
    };
    
    if (excludeId) {
      grnQuery._id = { $ne: excludeId };
    }

    const grnDeliveries = await UpcomingDelivery.find(grnQuery);
    const totalGRNAmount = grnDeliveries.reduce((sum, delivery) => {
      return sum + (delivery.billing?.finalAmount || 0);
    }, 0);

    // Calculate total used amount (Bills + GRN)
    const totalUsedAmount = totalBillsAmount + totalGRNAmount;
    const remaining = totalWOAmount - totalUsedAmount;

    // Validate if new amount can be added
    const parsedNewAmount = parseFloat(newAmount) || 0;
    
    if (parsedNewAmount > remaining) {
      return {
        valid: false,
        message: `${type.toUpperCase()} amount exceeds Work Order limit. WO Total: ₹${totalWOAmount.toLocaleString('en-IN')}, Already Used (Bills: ₹${totalBillsAmount.toLocaleString('en-IN')} + GRN: ₹${totalGRNAmount.toLocaleString('en-IN')} = ₹${totalUsedAmount.toLocaleString('en-IN')}), Remaining: ₹${remaining.toLocaleString('en-IN')}, Your ${type.toUpperCase()}: ₹${parsedNewAmount.toLocaleString('en-IN')}`,
        details: {
          totalWOAmount,
          totalBillsAmount,
          totalGRNAmount,
          totalUsedAmount,
          remaining,
          newAmount: parsedNewAmount,
          workOrderCount: workOrders.length
        }
      };
    }

    return {
      valid: true,
      message: 'Amount is within Work Order limit',
      details: {
        totalWOAmount,
        totalBillsAmount,
        totalGRNAmount,
        totalUsedAmount,
        remaining,
        newAmount: parsedNewAmount,
        remainingAfter: remaining - parsedNewAmount,
        workOrderCount: workOrders.length
      }
    };
  } catch (error) {
    console.error('Work Order validation error:', error);
    return {
      valid: false,
      message: `Validation error: ${error.message}`,
      details: {}
    };
  }
};

/**
 * Get Work Order summary for a project
 * @param {String} projectId - Project ID
 * @returns {Promise<Object>} Summary of WO amounts
 */
export const getWorkOrderSummary = async (projectId) => {
  try {
    const workOrders = await WorkOrder.find({ project: projectId });
    
    const totalWOAmount = workOrders.reduce((sum, wo) => sum + (wo.totalValue || 0), 0);
    const totalBillsAmount = workOrders.reduce((sum, wo) => sum + (wo.totalBillsAmount || 0), 0);
    
    const grnDeliveries = await UpcomingDelivery.find({ 
      project: projectId,
      'billing.finalAmount': { $exists: true, $gt: 0 }
    });
    
    const totalGRNAmount = grnDeliveries.reduce((sum, delivery) => {
      return sum + (delivery.billing?.finalAmount || 0);
    }, 0);
    
    const totalUsedAmount = totalBillsAmount + totalGRNAmount;
    const remaining = totalWOAmount - totalUsedAmount;
    
    return {
      totalWOAmount,
      totalBillsAmount,
      totalGRNAmount,
      totalUsedAmount,
      remaining,
      workOrderCount: workOrders.length,
      billCount: workOrders.reduce((sum, wo) => sum + (wo.billsCount || 0), 0),
      grnCount: grnDeliveries.length
    };
  } catch (error) {
    console.error('Get WO summary error:', error);
    throw error;
  }
};
