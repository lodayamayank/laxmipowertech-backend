// routes/attendanceNotes.routes.js
import express from "express";
import auth from "../middleware/authMiddleware.js";
import AttendanceNote from "../models/AttendanceNote.js";

const router = express.Router();

// Get note for user + date
router.get("/:userId/:date", auth, async (req, res) => {
  const { userId, date } = req.params;
  const note = await AttendanceNote.findOne({ userId, date });
  res.json(note || {});
});

// Upsert note
router.post("/:userId/:date", auth, async (req, res) => {
  const { userId, date } = req.params;
  const { note } = req.body;

  const doc = await AttendanceNote.findOneAndUpdate(
    { userId, date },
    { note, updatedBy: req.user._id },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  res.json(doc);
});

export default router;
