import mongoose from 'mongoose';

const billSchema = new mongoose.Schema({
  workOrder: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'WorkOrder',
    required: true
  },
  billNo: {
    type: String,
    required: true,
    trim: true
  },
  billDate: {
    type: Date,
    required: true
  },
  totalBillValue: {
    type: Number,
    required: true,
    min: 0
  },
  retentionAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  holdingAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  notes: {
    type: String,
    default: ''
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

billSchema.index({ workOrder: 1, createdAt: -1 });

export default mongoose.model('Bill', billSchema);
