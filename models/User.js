import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    // Basic Info
    name: String,
    username: { type: String, required: true, unique: true, trim: true },
    email: { type: String, lowercase: true, default: '' },
    password: { type: String, required: true },
    mobileNumber: String,
    role: {
      type: String,
      enum: ['admin', 'staff', 'supervisor', 'subcontractor', 'labour'],
      default: 'staff',
    },
    jobTitle: String,

    // Relational
    project: { type: mongoose.Schema.Types.ObjectId, ref: 'Project' },
    assignedBranches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],

    // Personal Details
    personalEmail: { type: String, lowercase: true, default: '' },
    dateOfBirth: Date,
    maritalStatus: { type: String, enum: ['single', 'married', 'other'], default: 'single' },
    aadhaarNumber: String,
    panNumber: String,
    drivingLicense: String,
    emergencyContact: String,
    address: String,

    // Employee Details
    employeeType: { type: String, enum: ['permanent', 'contract', 'intern', 'consultant'], default: 'permanent' },
    dateOfJoining: Date,
    dateOfLeaving: Date,
    employeeId: String,
    department: String,
    reportingManager: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

    // Salary Details
    ctcAmount: { type: Number, default: 0 },
    salaryType: { type: String, enum: ['monthly', 'weekly', 'daily'], default: 'monthly' },
    salaryEffectiveDate: Date,

    // Travel Allowance
    perDayTravelAllowance: { type: Number, default: 0 },
    railwayPassAmount: { type: Number, default: 0 },

    // Overtime Configuration
    standardDailyHours: { type: Number, default: 9 },
    overtimeRateMultiplier: { type: Number, default: 1.0 },
    otherAmount: { type: Number, default: 0 },
    otherAmountType: { type: String, enum: ['earning', 'deduction'], default: 'earning' },
  },
  { timestamps: true }
);

// 🔐 Hash password before save (only if modified)
// NOTE: Mongoose 9 awaits async hooks automatically — do NOT use next() in async hooks
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 10);
});

export default mongoose.model('User', userSchema);