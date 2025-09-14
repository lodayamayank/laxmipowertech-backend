// routes/attendanceNotes.routes.js
import express from "express";
import auth from "../middleware/authMiddleware.js";
import AttendanceNote from "../models/AttendanceNote.js";
import Attendance from "../models/Attendance.js";
import Branch from "../models/Branch.js";
const router = express.Router();

router.get("/", auth, async (req, res) => {
  try {
    const { search = "", role, userId, branch, startDate, endDate, page = 1, limit = 10 } = req.query;

    const query = {};
    if (search) query.note = { $regex: search, $options: "i" };
    if (userId) query.userId = userId;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    let notes = await AttendanceNote.find(query)
      .populate("userId", "name role")
      .sort({ date: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();

    // Filter by role if provided
    if (role) {
      notes = notes.filter((n) => n.userId?.role?.toLowerCase() === role.toLowerCase());
    }

    // Date filter
    if (startDate || endDate) {
      const start = startDate ? new Date(startDate) : new Date("2000-01-01");
      const end = endDate ? new Date(endDate) : new Date();
      notes = notes.filter((n) => {
        const d = new Date(n.date);
        return d >= start && d <= end;
      });
    }

    // 🔎 Attach branch based on punch for same user+date
    for (let n of notes) {
      const punches = await Attendance.find({
        user: n.userId._id,
        createdAt: {
          $gte: new Date(n.date + "T00:00:00Z"),
          $lte: new Date(n.date + "T23:59:59Z"),
        },
      }).lean();

      if (punches.length > 0) {
        // take first punch location
        const p = punches[0];
        const branchDoc = await Branch.findOne({
          _id: { $in: n.userId.assignedBranches },
        }).lean();
        n.branch = branchDoc?.name || "Outside Assigned Branch";
      } else {
        n.branch = "No Punch";
      }
    }

    // Filter by branch if needed
    if (branch) {
      notes = notes.filter((n) => n.branch === branch);
    }

    const total = notes.length;
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
