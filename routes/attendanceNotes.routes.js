// routes/attendanceNotes.routes.js
import express from "express";
import auth from "../middleware/authMiddleware.js";
import AttendanceNote from "../models/AttendanceNote.js";
import Attendance from "../models/Attendance.js";
import Branch from "../models/Branch.js"; 
const router = express.Router();

router.get("/", auth, async (req, res) => {
  try {
    const {
      search = "",
      role = "",
      branch = "",
      startDate = "",
      endDate = "",
      page = 1,
      limit = 10,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Build match filter
    const match = {};
    if (search) {
      match.note = { $regex: search, $options: "i" };
    }
    if (startDate && endDate) {
      match.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      match.date = { $gte: startDate };
    } else if (endDate) {
      match.date = { $lte: endDate };
    }

    // Aggregation
    const pipeline = [
      { $match: match },

      // Join user info
      {
        $lookup: {
          from: "users",
          localField: "userId",
          foreignField: "_id",
          as: "user",
        },
      },
      { $unwind: "$user" },

      // Optional role filter
      ...(role ? [{ $match: { "user.role": role } }] : []),

      // Join attendance to find branch
      {
        $lookup: {
          from: "attendances",
          let: { uId: "$userId", d: "$date" },
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$uId"] },
                    { $eq: ["$date", "$$d"] },
                  ],
                },
              },
            },
            {
              $lookup: {
                from: "branches",
                localField: "branchId",
                foreignField: "_id",
                as: "branch",
              },
            },
            { $unwind: { path: "$branch", preserveNullAndEmptyArrays: true } },
            { $project: { branchName: "$branch.name" } },
          ],
          as: "attendance",
        },
      },
      { $unwind: { path: "$attendance", preserveNullAndEmptyArrays: true } },

      // Optional branch filter
      ...(branch ? [{ $match: { "attendance.branchName": branch } }] : []),

      // Shape final output
      {
        $project: {
          _id: 1,
          date: 1,
          note: 1,
          userName: "$user.name",
          role: "$user.role",
          branch: "$attendance.branchName",
        },
      },

      { $sort: { date: -1 } },
      { $skip: skip },
      { $limit: parseInt(limit) },
    ];

    const [data, totalCount] = await Promise.all([
      AttendanceNote.aggregate(pipeline),
      AttendanceNote.countDocuments(match),
    ]);

    res.json({ notes: data, total: totalCount });
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
