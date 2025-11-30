import mongoose from 'mongoose';

const SiteTransferSchema = new mongoose.Schema({
  siteTransferId: { 
    type: String, 
    required: true, 
    unique: true 
  },
  fromSite: { 
    type: String, 
    required: true 
  },
  toSite: { 
    type: String, 
    required: true 
  },
  requestedBy: { 
    type: String, 
    required: true 
  },
  requestDate: { 
    type: Date, 
    default: Date.now 
  },
  materials: [
    {
      itemName: { type: String },
      quantity: { type: Number },
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
  attachments: [
    {
      url: { type: String, required: true },
      publicId: { type: String, required: true }
    }
  ],
  createdAt: { 
    type: Date, 
    default: Date.now 
  },
  updatedAt: { 
    type: Date 
  }
});

SiteTransferSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

SiteTransferSchema.index({ siteTransferId: 1 });
SiteTransferSchema.index({ status: 1 });
SiteTransferSchema.index({ createdAt: -1 });
SiteTransferSchema.index({ fromSite: 1, toSite: 1 });
SiteTransferSchema.index({ requestedBy: 1 });

export default mongoose.model('SiteTransfer', SiteTransferSchema);
