// routes/attendanceNotes.routes.js
import express from "express";
import auth from "../middleware/authMiddleware.js";
import AttendanceNote from "../models/AttendanceNote.js";

const router = express.Router();

// ✅ Get ALL notes (with filters + pagination)
router.get("/", auth, async (req, res) => {
  try {
    const { user, search, startDate, endDate, page = 1, limit = 20 } = req.query;

    const filter = {};

    if (user) filter.userId = user;
    if (startDate && endDate) {
      filter.date = { $gte: startDate, $lte: endDate };
    }

    if (search) {
      filter.note = { $regex: search, $options: "i" };
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [notes, total] = await Promise.all([
      AttendanceNote.find(filter)
        .populate("userId", "name username role")
        .sort({ date: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      AttendanceNote.countDocuments(filter),
    ]);

    res.json({
      notes,
      total,
      page: parseInt(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error("❌ Failed to fetch notes:", err);
    res.status(500).json({ message: "Failed to fetch notes", error: err.message });
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
