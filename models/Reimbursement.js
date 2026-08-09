import mongoose from "mongoose";

const ReimbursementItemSchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  expenseDate: { type: Date, required: true },
  category: { 
    type: String, 
    enum: ["travel", "food", "accommodation", "materials", "other"],
    required: true 
  },
  description: { type: String, required: true },
  receipts: [{ type: String }], // Array of image URLs
});

const ReimbursementSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  items: [ReimbursementItemSchema],
  totalAmount: { type: Number, required: true },
  status: { 
    type: String, 
    enum: ["pending", "approved", "rejected", "paid"], 
    default: "pending" 
  },
  note: { type: String },
  submittedAt: { type: Date, default: Date.now },
  
  // Admin fields
  approver: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  approvedAt: { type: Date },
  rejectionReason: { type: String },
  paymentDate: { type: Date },
  paymentMethod: { type: String, enum: ["cash", "bank", "upi"], default: "bank" },

  // Offline sync: UUID minted on the device so a replayed request is
  // recognised instead of inserted twice.
  clientId: { type: String },
  syncedOffline: { type: Boolean, default: false },
}, { timestamps: true });

ReimbursementSchema.index({ user: 1, status: 1, submittedAt: 1 });
ReimbursementSchema.index({ clientId: 1 }, { unique: true, sparse: true });

export default mongoose.model("Reimbursement", ReimbursementSchema);