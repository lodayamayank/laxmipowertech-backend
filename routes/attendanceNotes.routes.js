// routes/attendanceNotes.routes.js
import express from "express";
import auth from "../middleware/authMiddleware.js";
import AttendanceNote from "../models/AttendanceNote.js";

const router = express.Router();

// routes/attendanceNotes.routes.js
router.get("/", auth, async (req, res) => {
  try {
    const { search = "", page = 1, limit = 10 } = req.query;

    const query = search
      ? { note: { $regex: search, $options: "i" } }
      : {};

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const notes = await AttendanceNote.find(query)
      .populate({
        path: "userId",
        select: "name role assignedBranches",
        populate: { path: "assignedBranches", select: "name" },
      })
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    const total = await AttendanceNote.countDocuments(query);

    res.json({ notes, total });
  } catch (err) {
    console.error("❌ Failed to fetch notes:", err);
    res.status(500).json({ message: "Failed to fetch notes" });
  }
});




// ✅ Get note for user + date
router.get("/:userId/:date", auth, async (req, res) => {
  try {
    const { userId, date } = req.params;
    const note = await AttendanceNote.findOne({ userId, date });
    res.json(note || {});
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch note", error: err.message });
  }
});

// ✅ Upsert note (create or update for user+date)
router.post("/:userId/:date", auth, async (req, res) => {
  try {
    const { userId, date } = req.params;
    const { note } = req.body;

    const doc = await AttendanceNote.findOneAndUpdate(
      { userId, date },
      { note, updatedBy: req.user._id },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json(doc);
  } catch (err) {
    res.status(500).json({ message: "Failed to save note", error: err.message });
  }
});

// ✅ Update note by ID
router.put("/:id", auth, async (req, res) => {
  try {
    const updated = await AttendanceNote.findByIdAndUpdate(
      req.params.id,
      { note: req.body.note },
      { new: true }
    ).populate("userId", "name username role");

    if (!updated) return res.status(404).json({ message: "Note not found" });
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: "Failed to update note", error: err.message });
  }
});

// ✅ Delete note by ID
router.delete("/:id", auth, async (req, res) => {
  try {
    const deleted = await AttendanceNote.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Note not found" });

    res.json({ message: "Note deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Failed to delete note", error: err.message });
  }
});

export default router;
