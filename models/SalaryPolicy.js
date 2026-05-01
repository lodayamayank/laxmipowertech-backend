import mongoose from 'mongoose';

const salaryPolicySchema = new mongoose.Schema({
  holidayPaidLeaveEligibleRoles: {
    type: [String],
    default: ['staff', 'supervisor'],
  },
  sundayHolidayExcludedRoles: {
    type: [String],
    default: ['labour'],
  },
}, { timestamps: true });

export default mongoose.model('SalaryPolicy', salaryPolicySchema);
