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
  proofUrl: { type: String },
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
LeaveSchema.index({ status: 1, createdAt: -1 });           // badge count + admin list filtered by status
LeaveSchema.index({ user: 1, createdAt: -1 });             // GET /my (sorted by newest)
LeaveSchema.index({ startDate: 1, endDate: 1 });           // from/to date-range filters
LeaveSchema.index({ clientId: 1 }, { unique: true, sparse: true });


export default mongoose.model("Leave", LeaveSchema);
