import mongoose from 'mongoose';

const workOrderSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  workOrderNo: {
    type: String,
    required: true,
    trim: true
  },
  workOrderName: {
    type: String,
    required: true,
    trim: true
  },
  workOrderDate: {
    type: Date,
    required: true
  },
  totalValue: {
    type: Number,
    required: true,
    min: 0
  },
  totalBillsAmount: {
    type: Number,
    default: 0,
    min: 0
  },
  billsCount: {
    type: Number,
    default: 0,
    min: 0
  },
  description: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['active', 'completed', 'on-hold', 'cancelled'],
    default: 'active'
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, { timestamps: true });

workOrderSchema.index({ project: 1, createdAt: -1 });
workOrderSchema.index({ workOrderNo: 1, project: 1 }, { unique: true });

export default mongoose.model('WorkOrder', workOrderSchema);
