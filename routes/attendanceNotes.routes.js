// routes/attendanceNotes.routes.js
import express from "express";
import mongoose from "mongoose";
import auth from "../middleware/authMiddleware.js";
import AttendanceNote from "../models/AttendanceNote.js";

const router = express.Router();

router.get("/", auth, async (req, res) => {
  try {
    const {
      search = "",
      role = "",
      branch = "", // branchId
      startDate = "",
      endDate = "",
      page = 1,
      limit = 10,
    } = req.query;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    // Base filter (dates on notes)
    const match = {};
    if (startDate && endDate) {
      match.date = { $gte: startDate, $lte: endDate };
    } else if (startDate) {
      match.date = { $gte: startDate };
    } else if (endDate) {
      match.date = { $lte: endDate };
    }

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

      // Join attendance -> branch
      {
        $lookup: {
          from: "attendances",
          let: { uId: "$userId", d: "$date" }, // d is a string (note.date)
          pipeline: [
            {
              $match: {
                $expr: {
                  $and: [
                    { $eq: ["$userId", "$$uId"] },
                    {
                      $eq: [
                        { $dateToString: { format: "%Y-%m-%d", date: "$date" } },
                        "$$d",
                      ],
                    },
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
            {
              $project: {
                branchId: "$branch._id",
                branchName: "$branch.name",
              },
            },
          ],
          as: "attendance",
        },
      },
      { $unwind: { path: "$attendance", preserveNullAndEmptyArrays: true } },

      // ✅ Filters after joins
      {
        $match: {
          ...(role ? { "user.role": role } : {}),
          ...(branch ? { "attendance.branchId": new mongoose.Types.ObjectId(branch) } : {}),
          ...(search
            ? {
                $or: [
                  { note: { $regex: search, $options: "i" } },
                  { "user.name": { $regex: search, $options: "i" } },
                  { "attendance.branchName": { $regex: search, $options: "i" } },
                ],
              }
            : {}),
        },
      },

      // Final shape
      {
        $project: {
          _id: 1,
          date: 1,
          note: 1,
          userName: "$user.name",
          role: "$user.role",
          branchId: "$attendance.branchId",
          branch: { $ifNull: ["$attendance.branchName", "N/A"] },
        },
      },
    ];

    // Count pipeline
    const countPipeline = [...pipeline, { $count: "total" }];

    const [data, totalResult] = await Promise.all([
      AttendanceNote.aggregate([
        ...pipeline,
        { $sort: { date: -1 } },
        { $skip: skip },
        { $limit: parseInt(limit) },
      ]),
      AttendanceNote.aggregate(countPipeline),
    ]);

    const total = totalResult.length > 0 ? totalResult[0].total : 0;

    res.json({ notes: data, total });
  } catch (err) {
    console.error("❌ Failed to fetch notes:", err);
    res.status(500).json({ message: "Failed to fetch notes", error: err.message });
  }
});

export default router;
