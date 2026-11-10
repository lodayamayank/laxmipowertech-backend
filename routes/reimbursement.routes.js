import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import Reimbursement from "../models/Reimbursement.js";
import User from "../models/User.js";
import auth from "../middleware/authMiddleware.js";
import {
  resolveCapturedAt,
  findExistingByClientId,
  isDuplicateClientIdError,
  readClientId,
} from "../utils/offlineSync.js";

const router = express.Router();

let pendingCache = { count: 0, at: 0 };
const invalidatePendingCache = () => {
  pendingCache.at = 0;
};

// Setup multer for receipt uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = "./uploads/reimbursements";
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${Math.round(Math.random() * 1e9)}${path.extname(file.originalname)}`;
    cb(null, uniqueName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB per file
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|pdf/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (mimetype && extname) {
      return cb(null, true);
    }
    cb(new Error("Only images (jpeg, jpg, png) and PDF files are allowed"));
  },
});

// ✅ Create reimbursement request
router.post("/", auth, upload.array("receipts", 10), async (req, res) => {
  try {
    const { items, note } = req.body;

    // Offline replay: return the original claim instead of filing a second one.
    const clientId = readClientId(req.body);
    const existing = await findExistingByClientId(Reimbursement, clientId);
    if (existing) {
      await existing.populate("user", "name username email mobileNumber role");
      return res.status(200).json({
        message: "Reimbursement already submitted",
        reimbursement: existing,
        duplicate: true,
      });
    }

    // A claim submitted offline keeps the time it was filled in on the device.
    const { date: submittedAt, backdated } = resolveCapturedAt(req.body.capturedAt);

    // Parse items if it's a JSON string
    const parsedItems = typeof items === "string" ? JSON.parse(items) : items;

    // Add uploaded file paths to respective items
    if (req.files && req.files.length > 0) {
      const receiptPaths = req.files.map(file => `/uploads/reimbursements/${file.filename}`);
      
      // Distribute receipts to items (you can modify logic as needed)
      parsedItems.forEach((item, index) => {
        item.receipts = receiptPaths.filter((_, i) => 
          i >= index * Math.ceil(receiptPaths.length / parsedItems.length) && 
          i < (index + 1) * Math.ceil(receiptPaths.length / parsedItems.length)
        );
      });
    }
    
    // Calculate total amount
    const totalAmount = parsedItems.reduce((sum, item) => sum + parseFloat(item.amount), 0);
    
    const reimbursement = new Reimbursement({
      user: req.user.id,
      items: parsedItems,
      totalAmount,
      note,
      submittedAt,
      ...(clientId ? { clientId } : {}),
      syncedOffline: backdated,
    });

    try {
      await reimbursement.save();
      invalidatePendingCache();
    } catch (saveErr) {
      // Two replays raced; the loser hit the unique clientId index. The claim
      // exists, so report success with the winner rather than a 500.
      if (isDuplicateClientIdError(saveErr)) {
        const winner = await findExistingByClientId(Reimbursement, clientId);
        if (winner) {
          await winner.populate("user", "name username email mobileNumber role");
          return res.status(200).json({
            message: "Reimbursement already submitted",
            reimbursement: winner,
            duplicate: true,
          });
        }
      }
      throw saveErr;
    }

    // Populate user details for response
    await reimbursement.populate("user", "name username email mobileNumber role");
    
    res.status(201).json({
      message: "Reimbursement request submitted successfully",
      reimbursement,
    });
  } catch (err) {
    console.error("Reimbursement creation error:", err);
    res.status(400).json({ 
      message: "Failed to submit reimbursement", 
      error: err.message 
    });
  }
});

// ✅ Get my reimbursement requests
router.get("/my", auth, async (req, res) => {
  try {
    const reimbursements = await Reimbursement.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .populate("approver", "name");
    
    res.json(reimbursements);
  } catch (err) {
    res.status(500).json({ 
      message: "Failed to fetch reimbursements", 
      error: err.message 
    });
  }
});
// GET /api/reimbursements/pending-count
router.get("/pending-count", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "supervisor") {
      return res.status(403).json({ message: "Access denied" });
    }
    if (Date.now() - pendingCache.at > 15_000) {
      pendingCache = {
        count: await Reimbursement.countDocuments({ status: "pending" }),
        at: Date.now(),
      };
    }
    res.json({ count: pendingCache.count });
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch count", error: err.message });
  }
});

// ✅ Admin: Get all reimbursement requests (with filters) - MUST BE BEFORE /:id
router.get("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "supervisor") {
      return res.status(403).json({ message: "Access denied" });
    }

    const { status, role, from, to } = req.query;
    const page = Math.max(Number(req.query.page) || 1, 1);
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 100);
    const query = {};

    if (status) query.status = status;
    if (from || to) {
      query.submittedAt = {};
      if (from) query.submittedAt.$gte = new Date(from);
      if (to) query.submittedAt.$lte = new Date(to);
    }

    if (role) {
      const userIds = await User.find({ role }).distinct("_id");
      query.user = { $in: userIds };
    }

    const [rows, total] = await Promise.all([
      Reimbursement.find(query)
        .sort({ createdAt: -1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("user", "name username email mobileNumber role assignedBranches")
        .populate("approver", "name")
        .lean(),
      Reimbursement.countDocuments(query),
    ]);

    res.json({ rows, total, page, limit });
  } catch (err) {
    console.error("Failed to fetch reimbursements", err);
    res.status(500).json({ message: "Failed to fetch reimbursements", error: err.message });
  }
});

// ✅ Get single reimbursement details
router.get("/:id", auth, async (req, res) => {
  try {
    const reimbursement = await Reimbursement.findById(req.params.id)
      .populate("user", "name username email mobileNumber role")
      .populate("approver", "name");
    
    if (!reimbursement) {
      return res.status(404).json({ message: "Reimbursement not found" });
    }
    
    // Check access
    if (reimbursement.user._id.toString() !== req.user.id && 
        req.user.role !== "admin" && 
        req.user.role !== "supervisor") {
      return res.status(403).json({ message: "Access denied" });
    }
    
    res.json(reimbursement);
  } catch (err) {
    res.status(500).json({ 
      message: "Failed to fetch reimbursement", 
      error: err.message 
    });
  }
});

// ✅ Admin: Update reimbursement status
router.patch("/:id/status", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "supervisor") {
      return res.status(403).json({ message: "Access denied" });
    }
    
    const { status, rejectionReason, paymentMethod, paymentDate } = req.body;
    
    if (!["pending", "approved", "rejected", "paid"].includes(status)) {
      return res.status(400).json({ message: "Invalid status" });
    }
    
    const reimbursement = await Reimbursement.findById(req.params.id);
    if (!reimbursement) {
      return res.status(404).json({ message: "Reimbursement not found" });
    }
    
    reimbursement.status = status;
    reimbursement.approver = req.user.id;
    reimbursement.approvedAt = new Date();
    
    if (status === "rejected" && rejectionReason) {
      reimbursement.rejectionReason = rejectionReason;
    }
    
    if (status === "paid") {
      reimbursement.paymentDate = paymentDate || new Date();
      reimbursement.paymentMethod = paymentMethod || "bank";
    }
    
    await reimbursement.save();
    invalidatePendingCache();
    await reimbursement.populate("user", "name username email");
    
    res.json({ 
      message: `Reimbursement ${status} successfully`, 
      reimbursement 
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ 
      message: "Failed to update reimbursement", 
      error: err.message 
    });
  }
});

// ✅ Delete reimbursement (only if pending)
router.delete("/:id", auth, async (req, res) => {
  try {
    const reimbursement = await Reimbursement.findById(req.params.id);
    
    if (!reimbursement) {
      return res.status(404).json({ message: "Reimbursement not found" });
    }
    
    // Only creator can delete and only if pending
    if (reimbursement.user.toString() !== req.user.id) {
      return res.status(403).json({ message: "Access denied" });
    }
    
    if (reimbursement.status !== "pending") {
      return res.status(400).json({ 
        message: "Cannot delete reimbursement that is already processed" 
      });
    }
    
    // Delete associated files
    reimbursement.items.forEach(item => {
      item.receipts.forEach(receipt => {
        const filePath = `.${receipt}`;
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
      });
    });
    
    await reimbursement.deleteOne();
    invalidatePendingCache();
    
    res.json({ message: "Reimbursement deleted successfully" });
  } catch (err) {
    res.status(500).json({ 
      message: "Failed to delete reimbursement", 
      error: err.message 
    });
  }
});

export default router;