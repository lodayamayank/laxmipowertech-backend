// routes/leaves.routes.js
import express from "express";
import Leave from "../models/Leave.js";
import auth from "../middleware/authMiddleware.js";
import Attendance from "../models/Attendance.js";
import { upload, uploadToCloudinary } from "../middleware/cloudinaryMaterialMiddleware.js";
import fs from "fs";
import {
  resolveCapturedAt,
  findExistingByClientId,
  isDuplicateClientIdError,
  readClientId,
} from "../utils/offlineSync.js";

const router = express.Router();

const hasValidImageSignature = (filePath, mimetype) => {
  const header = fs.readFileSync(filePath).subarray(0, 12);
  if (mimetype === "image/jpeg") return header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  if (mimetype === "image/png") return header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mimetype === "image/gif") return header.subarray(0, 6).toString("ascii").match(/^GIF8[79]a$/) !== null;
  if (mimetype === "image/webp") return header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
  return false;
};

// ✅ Request leave
router.post("/", auth, upload.single("proof"), async (req, res) => {
  try {
    if (req.body.type === "sick" && !req.file) {
      return res.status(400).json({ message: "Medical proof image is required for sick leave" });
    }
    if (req.file && !hasValidImageSignature(req.file.path, req.file.mimetype)) {
      fs.unlinkSync(req.file.path);
      return res.status(400).json({ message: "Only valid image files are allowed for medical proof" });
    }

    // Offline replay: return the original request instead of filing a second one.
    const clientId = readClientId(req.body);
    const existing = await findExistingByClientId(Leave, clientId);
    if (existing) {
      if (req.file?.path) {
        fs.unlinkSync(req.file.path);
      }
      return res.status(200).json({ ...existing.toObject(), duplicate: true });
    }

    let proofUrl;
    if (req.file) {
      const uploadedProof = await uploadToCloudinary(
        req.file.path,
        "laxmipowertech/leaves/proofs",
        null,
        {
          resource_type: "image",
          quality: "auto:eco",
          fetch_format: "auto",
          transformation: [{ width: 1600, height: 1600, crop: "limit" }],
        }
      );
      proofUrl = uploadedProof.url;
    }

    const { date: capturedAt, backdated } = resolveCapturedAt(req.body.capturedAt);
    // clientId/capturedAt are transport concerns – don't let them spread into
    // the document twice via ...req.body.
    const { clientId: _cid, capturedAt: _cap, ...leaveFields } = req.body;

    const leave = new Leave({
      ...leaveFields,
      user: req.user.id,
      ...(proofUrl ? { proofUrl } : {}),
      ...(clientId ? { clientId } : {}),
      capturedAt,
      syncedOffline: backdated,
    });

    try {
      await leave.save();
    } catch (saveErr) {
      if (isDuplicateClientIdError(saveErr)) {
        const winner = await findExistingByClientId(Leave, clientId);
        if (winner) return res.status(200).json({ ...winner.toObject(), duplicate: true });
      }
      throw saveErr;
    }

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
      .populate({
        path: "user",
        select: "username role assignedBranches",
        populate: { path: "assignedBranches", select: "name" }  // 👈 added
      })
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
