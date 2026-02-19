// models/Leave.js
import mongoose from "mongoose";

const LeaveSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  type: { 
    type: String, 
    enum: ["paid", "unpaid", "sick", "casual"], 
    required: true 
  },
  startDate: { type: Date, required: true },
  endDate: { type: Date, required: true },
  reason: { type: String },
  status: { 
    type: String, 
    enum: ["pending", "approved", "rejected"], 
    default: "pending" 
  },
  approver: { type: mongoose.Schema.Types.ObjectId, ref: "User" }, // new
  approvedAt: { type: Date }, // new
}, { timestamps: true });

export default mongoose.model("Leave", LeaveSchema);
