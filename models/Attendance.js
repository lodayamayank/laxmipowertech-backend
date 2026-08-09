import mongoose from "mongoose";

const attendanceSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    punchType: {
      type: String,
      enum: [
        "in",
        "out",
        "half",
        "absent",
        "weekoff",
        "paidleave",
        "unpaidleave",
        "overtime",
      ],
      required: true,
    },
    lat: String,
    lng: String,
    selfieUrl: String,

    // 🔹 For leave integration
    date: { type: Date, required: true },
    leaveId: { type: mongoose.Schema.Types.ObjectId, ref: "Leave" },

    // 🔹 Offline sync: UUID minted on the device so a replayed punch is
    // recognised instead of inserted twice. Absent on normal online punches.
    clientId: { type: String },
    // True when `date` came from the device rather than the server clock.
    syncedOffline: { type: Boolean, default: false },
  },
  { timestamps: true }
);

attendanceSchema.index({ user: 1, date: 1 });
attendanceSchema.index({ clientId: 1 }, { unique: true, sparse: true });

export default mongoose.model("Attendance", attendanceSchema);
