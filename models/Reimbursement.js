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
}, { timestamps: true });

export default mongoose.model("Reimbursement", ReimbursementSchema);