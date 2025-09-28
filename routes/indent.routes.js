import express from "express";
import auth from "../middleware/authMiddleware.js";
import Indent from "../models/Indent.js";

const router = express.Router();

// ✅ Create new indent (User raises request)
router.post("/", auth, async (req, res) => {
  try {
    const { project, branch, items, remarks } = req.body;
    const indent = new Indent({
      project,
      branch,
      items,
      requestedBy: req.user.id,
    });
    await indent.save();
    res.status(201).json(indent);
  } catch (err) {
    res.status(400).json({ message: "Failed to create indent", error: err.message });
  }
});

// ✅ Get all indents (Admin side, with filters)
router.get("/", auth, async (req, res) => {
  try {
    const { status, project, requestedBy } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (project) filter.project = project;
    if (requestedBy) filter.requestedBy = requestedBy;

    const indents = await Indent.find(filter)
      .populate("project", "name")
      .populate("branch", "name")
      .populate("requestedBy", "name role")
      .populate("approvedBy", "name role")
      .sort({ createdAt: -1 });

    res.json(indents);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch indents", error: err.message });
  }
});

// ✅ Approve/Reject indent (Admin)
router.put("/:id/status", auth, async (req, res) => {
  try {
    const { status, adminRemarks } = req.body;
    if (!["approved", "rejected", "delivered"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }

    const indent = await Indent.findByIdAndUpdate(
      req.params.id,
      { status, adminRemarks, approvedBy: req.user.id },
      { new: true }
    );

    res.json(indent);
  } catch (err) {
    res.status(400).json({ message: "Failed to update indent", error: err.message });
  }
});

// ✅ Get single indent details
router.get("/:id", auth, async (req, res) => {
  try {
    const indent = await Indent.findById(req.params.id)
      .populate("project", "name")
      .populate("branch", "name")
      .populate("requestedBy", "name role")
      .populate("approvedBy", "name role");

    if (!indent) return res.status(404).json({ message: "Indent not found" });
    res.json(indent);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch indent", error: err.message });
  }
});

export default router;
