import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema(
  {
    name: String,
    jobTitle: String,
    project: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Project',
    },
    mobileNumber: String,
    username: {
      type: String,
      required: true,
      unique: true,
      trim: true,
    },
    email: {
      type: String,
      lowercase: true,
      default: '',
    },
    
    password: {
      type: String,
      required: true,
    },
    dateOfJoining: Date,
    address: String,
    gender: String,
    role: {
      type: String,
      enum: ['admin','staff', 'subcontractor', 'labour'],
      default: 'staff',
    },
    assignedBranches: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Branch',
      },
    ],
  },
  { timestamps: true }
);

// 🔐 Hash password before save (only if modified)
userSchema.pre('save', async function (next) {
  if (!this.isModified('password')) return next();
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (err) {
    next(err);
  }
});

export default mongoose.model('User', userSchema);
