import mongoose from 'mongoose';

const holidayCalendarSchema = new mongoose.Schema({
  date: { type: Date, required: true, unique: true },
  name: { type: String, required: true },
  source: { type: String, enum: ['system', 'manual'], default: 'manual' },
  isActive: { type: Boolean, default: true },
  branchId: { type: mongoose.Schema.Types.ObjectId, ref: 'Branch', default: null },
}, { timestamps: true });

export default mongoose.model('HolidayCalendar', holidayCalendarSchema);
