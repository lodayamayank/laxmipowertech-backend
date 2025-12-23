import mongoose from 'mongoose';

const UpcomingDeliverySchema = new mongoose.Schema({
  st_id: { 
    type: String, 
    required: true 
  },
  source_type: {
    type: String,
    enum: ['SiteTransfer', 'PurchaseOrder', 'Indent'],
    default: 'SiteTransfer'
  },
  source_id: {
    type: String  // PO ID or Indent ID
  },
  transfer_number: { 
    type: String, 
    unique: true,
    sparse: true  // Allow null for POs/Indents
  },
  date: { 
    type: Date, 
    default: Date.now 
  },
  created_date: {
    type: Date,
    default: Date.now
  },
  expected_delivery: {
    type: Date
  },
  // For Site Transfers
  from: { 
    type: String
  },
  to: { 
    type: String
  },
  // For Purchase Orders / Indents
  vendor_name: {
    type: String
  },
  vendor_id: {
    type: String
  },
  delivery_site: {
    type: String
  },
  requested_by: {
    type: String
  },
  items: [
    {
      itemId: { type: String, required: true },
      name: { type: String },  // For PO/Indent
      category: { type: String },
      sub_category: { type: String },
      sub_category1: { type: String },
      st_quantity: { type: Number },  // For Site Transfers
      quantity: { type: Number },  // For PO/Indent
      uom: { type: String },  // For PO/Indent
      received_quantity: { type: Number, default: 0 },
      is_received: { type: Boolean, default: false },
      remarks: { type: String }
    }
  ],
  status: { 
    type: String, 
    enum: ['Pending', 'Partial', 'Transferred'], 
    default: 'Pending' 
  },
  type: {
    type: String,
    enum: ['ST', 'PO'],
    default: 'ST',
    required: true
  },
  createdBy: { 
    type: String
  },
  attachments: [
    {
      url: { type: String, required: true },
      publicId: { type: String, required: true }
    }
  ],
  // Billing Information (for GRN)
  billing: {
    invoiceNumber: { type: String },
    price: { type: Number, default: 0 },
    billDate: { type: Date },
    discount: { type: Number, default: 0 },
    amount: { type: Number, default: 0 }  // Auto-calculated: price - discount
  },
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date,
    default: Date.now 
  }
});

UpcomingDeliverySchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

UpcomingDeliverySchema.index({ st_id: 1 });
UpcomingDeliverySchema.index({ transfer_number: 1 });
UpcomingDeliverySchema.index({ status: 1 });
UpcomingDeliverySchema.index({ type: 1 });
UpcomingDeliverySchema.index({ createdAt: -1 });
UpcomingDeliverySchema.index({ from: 1, to: 1 });

export default mongoose.model('UpcomingDelivery', UpcomingDeliverySchema);
