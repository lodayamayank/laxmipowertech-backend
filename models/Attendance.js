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
        "half-day",
        "present",
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
     markedBy: String,
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },

    // Supervisor-set punch time (overrides createdAt for salary calculation)
    punchTime: { type: Date },

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

attendanceSchema.index({ user: 1, date: 1, punchType: 1 }); // replaces { user, date }: summary, bulk, supervisor-code-punch
attendanceSchema.index({ user: 1, createdAt: -1 });           // keep: /my, /today, /live, GET /, /user/:id
attendanceSchema.index({ branch: 1, date: 1 });              // new: /by-date
attendanceSchema.index({ date: 1 });                         // new: admin delete preview/delete
attendanceSchema.index({ clientId: 1 }, { unique: true, sparse: true }); // keep
export default mongoose.model("Attendance", attendanceSchema);
