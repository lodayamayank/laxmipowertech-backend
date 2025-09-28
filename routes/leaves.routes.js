// routes/leaves.routes.js
import express from "express";
import Leave from "../models/Leave.js";
import auth from "../middleware/authMiddleware.js";
import Attendance from "../models/Attendance.js";

const router = express.Router();

// ✅ Request leave
router.post("/", auth, async (req, res) => {
  try {
    const leave = new Leave({
      ...req.body,
      user: req.user.id,
    });
    await leave.save();
    res.status(201).json(leave);
  } catch (err) {
    res.status(400).json({ message: "Failed to request leave", error: err.message });
  }
});

// ✅ Get my leave requests
router.get("/my", auth, async (req, res) => {
  try {
    const leaves = await Leave.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(leaves);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch leaves", error: err.message });
  }
});

// ✅ Admin: get all leaves (with filters & pagination)
router.get("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "supervisor") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { status, type, role, branchId, from, to, page = 1, limit = 20 } = req.query;
    const query = {};

    if (status) query.status = status;
    if (type) query.type = type;
    if (from || to) {
      query.$and = [];
      if (from) query.$and.push({ endDate: { $gte: new Date(from) } });
      if (to) query.$and.push({ startDate: { $lte: new Date(to) } });
    }

    let leavesQuery = Leave.find(query)
      .populate("user", "username role assignedBranches")
      .sort({ createdAt: -1 });

    if (role) {
      leavesQuery = leavesQuery.where("user.role").equals(role);
    }

    if (branchId) {
      leavesQuery = leavesQuery.where("user.assignedBranches").in([branchId]);
    }

    const total = await Leave.countDocuments(query);
    const leaves = await leavesQuery
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({ rows: leaves, total, page: Number(page), limit: Number(limit) });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch leaves", error: err.message });
  }
});

// ✅ Admin: approve/reject leave
// PATCH /api/leaves/:id/status
router.patch("/:id/status", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "supervisor") {
      return res.status(403).json({ message: "Forbidden" });
    }

    const { status } = req.body;
    if (!["pending", "approved", "rejected"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const leave = await Leave.findById(req.params.id);
    if (!leave) return res.status(404).json({ message: "Leave not found" });

    leave.status = status;
    leave.approver = req.user.id;
    leave.approvedAt = new Date();
    await leave.save();

    // 🔹 Attendance sync
    if (status === "approved") {
      const start = new Date(leave.startDate);
      const end = new Date(leave.endDate);

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        await Attendance.findOneAndUpdate(
          { user: leave.user, date: d },
          {
            user: leave.user,
            date: d,
            punchType: "leave",   // 👈 always "leave"
            leaveId: leave._id,   // 👈 use leaveId to know type (paid/unpaid/sick/casual)
          },
          { upsert: true, new: true }
        );
      }
    }
    else {
      // If rejected or set back to pending → remove linked attendance
      await Attendance.deleteMany({ leaveId: leave._id });
    }

    res.json({ message: "Leave updated and attendance synced", leave });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to update leave", error: err.message });
  }
});


export default router;
