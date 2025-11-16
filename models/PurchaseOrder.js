import mongoose from 'mongoose';

const PurchaseOrderSchema = new mongoose.Schema({
  purchaseOrderId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  requestedBy: { 
    type: String, 
    required: true 
  },
  deliverySite: { 
    type: String, 
    required: true 
  },
  requestDate: { 
    type: Date, 
    default: Date.now 
  },
  materials: [
    {
      itemName: { type: String, required: true },
      category: { type: String },
      subCategory: { type: String },
      subCategory1: { type: String },
      quantity: { type: Number, required: true },
      uom: { type: String },
      remarks: { type: String },
      received_quantity: { type: Number, default: 0 },
      is_received: { type: Boolean, default: false }
    }
  ],
  status: { 
    type: String, 
    enum: ['pending', 'approved', 'transferred', 'cancelled'], 
    default: 'pending' 
  },
  attachments: [String],
  remarks: { type: String },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date 
  }
});

PurchaseOrderSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

PurchaseOrderSchema.index({ purchaseOrderId: 1 });
PurchaseOrderSchema.index({ status: 1 });
PurchaseOrderSchema.index({ createdAt: -1 });
PurchaseOrderSchema.index({ deliverySite: 1 });
PurchaseOrderSchema.index({ requestedBy: 1 });

export default mongoose.model('PurchaseOrder', PurchaseOrderSchema);

