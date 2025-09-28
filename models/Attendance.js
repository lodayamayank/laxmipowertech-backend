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
  },
  { timestamps: true }
);

export default mongoose.model("Attendance", attendanceSchema);
