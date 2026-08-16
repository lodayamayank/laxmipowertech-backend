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

  // Offline sync: UUID minted on the device so a replayed request is
  // recognised instead of inserted twice.
  clientId: { type: String },
  capturedAt: { type: Date },
  syncedOffline: { type: Boolean, default: false },
}, { timestamps: true });

LeaveSchema.index({ user: 1, status: 1, startDate: 1, endDate: 1 });
LeaveSchema.index({ clientId: 1 }, { unique: true, sparse: true });

export default mongoose.model("Leave", LeaveSchema);
