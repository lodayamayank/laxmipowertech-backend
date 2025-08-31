// models/Leave.js
import mongoose from 'mongoose';

const LeaveSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  type: { type: String, enum: ['paid', 'unpaid'], required: true },
  reason: String,
}, { timestamps: true });

export default mongoose.model('Leave', LeaveSchema);
