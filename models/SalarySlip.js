import mongoose from 'mongoose';

const salarySlipSchema = new mongoose.Schema(
  {
    // Employee Reference
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    
    // Period Information
    month: {
      type: Number,
      required: true,
      min: 1,
      max: 12,
    },
    year: {
      type: Number,
      required: true,
    },
    
    // Employee Details (snapshot at time of generation)
    employeeDetails: {
      name: String,
      username: String,
      employeeId: String,
      role: String,
      department: String,
      jobTitle: String,
    },
    
    // Salary Configuration (snapshot)
    salaryConfig: {
      ctcAmount: Number,
      salaryType: String,
      perDayTravelAllowance: Number,
      railwayPassAmount: Number,
      standardDailyHours: Number,
      overtimeRateMultiplier: Number,
    },
    
    // Attendance Summary
    attendance: {
      workingDays: Number,
      presentDays: Number,
      absentDays: Number,
      halfDays: Number,
      paidLeaveDays: Number,
      casualLeaveDays: Number,
      sickLeaveDays: Number,
      unpaidLeaveDays: Number,
      effectivePaidLeaveDays: Number,
      effectiveUnpaidLeaveDays: Number,
      totalHoursWorked: Number,
      totalOvertimeHours: Number,
    },
    
    // Salary Breakdown
    grossSalary: {
      type: Number,
      required: true,
    },
    perDaySalary: Number,
    perHourRate: Number,
    payableDays: Number,
    
    // Deductions
    deductions: {
      absent: Number,
      halfDay: Number,
      unpaidLeave: Number,
      total: Number,
    },
    
    // Benefits
    reimbursements: {
      total: Number,
      count: Number,
      details: [{
        id: mongoose.Schema.Types.ObjectId,
        amount: Number,
        status: String,
        submittedAt: Date,
      }],
    },
    
    travel: {
      perDayAllowance: Number,
      railwayPass: Number,
      total: Number,
    },
    
    overtime: {
      hours: Number,
      rate: Number,
      multiplier: Number,
      total: Number,
    },
    
    // Final Salary
    netSalary: {
      type: Number,
      required: true,
    },
    
    // Payment Information
    paymentStatus: {
      type: String,
      enum: ['pending', 'processing', 'paid', 'failed'],
      default: 'pending',
    },
    paymentDate: Date,
    paymentMethod: String,
    paymentReference: String,
    paymentNotes: String,
    
    // Metadata
    generatedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    generatedAt: {
      type: Date,
      default: Date.now,
    },
    locked: {
      type: Boolean,
      default: false,
    },
    notes: String,
  },
  {
    timestamps: true,
  }
);

// Compound index to prevent duplicate slips for same user/month/year
salarySlipSchema.index({ user: 1, month: 1, year: 1 }, { unique: true });

// Index for faster queries
salarySlipSchema.index({ month: 1, year: 1 });
salarySlipSchema.index({ paymentStatus: 1 });

const SalarySlip = mongoose.model('SalarySlip', salarySlipSchema);

export default SalarySlip;