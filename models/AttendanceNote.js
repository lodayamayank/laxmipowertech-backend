// models/AttendanceNote.js
import mongoose from "mongoose";

const AttendanceNoteSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  date: { type: String, required: true }, // "YYYY-MM-DD"
  note: { type: String, default: "" },
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
}, { timestamps: true });

AttendanceNoteSchema.index({ userId: 1, date: 1 }, { unique: true });

export default mongoose.model("AttendanceNote", AttendanceNoteSchema);
