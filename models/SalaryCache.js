import mongoose from 'mongoose';

const salaryCacheSchema = new mongoose.Schema({
  month: { type: Number, required: true },
  year: { type: Number, required: true },
  employees: { type: Array, default: [] },
  total: { type: Number, default: 0 },
  computedAt: { type: Date, default: Date.now },
}, { timestamps: false });

salaryCacheSchema.index({ month: 1, year: 1 }, { unique: true });

export default mongoose.model('SalaryCache', salaryCacheSchema);
