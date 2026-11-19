import mongoose from "mongoose";

const supervisorAttendanceCodeSchema = new mongoose.Schema(
  {
    supervisor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Branch",
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true },
);

// One code per supervisor, branch and day (needed for the atomic upsert)
supervisorAttendanceCodeSchema.index(
  { supervisor: 1, branch: 1, date: 1 },
  { unique: true },
);

// A code identifies one supervisor per branch per day; serves /supervisor-code-punch lookup
supervisorAttendanceCodeSchema.index(
  { branch: 1, date: 1, code: 1 },
  { unique: true },
);

// Auto-delete old codes 48h after their date (replaces the per-request deleteMany)
supervisorAttendanceCodeSchema.index(
  { date: 1 },
  { expireAfterSeconds: 172800 },
);

export default mongoose.model(
  "SupervisorAttendanceCode",
  supervisorAttendanceCodeSchema,
);
