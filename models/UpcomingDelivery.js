import mongoose from 'mongoose';

const UpcomingDeliverySchema = new mongoose.Schema({
  st_id: { 
    type: String, 
    required: true 
  },
  transfer_number: { 
    type: String, 
    required: true,
    unique: true 
  },
  date: { 
    type: Date, 
    default: Date.now 
  },
  from: { 
    type: String, 
    required: true 
  },
  to: { 
    type: String, 
    required: true 
  },
  items: [
    {
      itemId: { type: String, required: true },
      category: { type: String },
      sub_category: { type: String },
      sub_category1: { type: String },
      st_quantity: { type: Number, required: true },
      received_quantity: { type: Number, default: 0 },
      is_received: { type: Boolean, default: false }
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
    type: String, 
    required: true 
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
