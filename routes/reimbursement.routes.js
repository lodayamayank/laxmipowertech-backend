import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import Reimbursement from "../models/Reimbursement.js";
import User from "../models/User.js";
import auth from "../middleware/authMiddleware.js";

const router = express.Router();

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
      submittedAt: new Date(),
    });
    
    await reimbursement.save();
    
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

// ✅ Admin: Get all reimbursement requests (with filters) - MUST BE BEFORE /:id
router.get("/", auth, async (req, res) => {
  try {
    if (req.user.role !== "admin" && req.user.role !== "supervisor") {
      return res.status(403).json({ message: "Access denied" });
    }
    
    const { status, role, from, to, page = 1, limit = 20 } = req.query;
    const query = {};
    
    if (status) query.status = status;
    if (from || to) {
      query.submittedAt = {};
      if (from) query.submittedAt.$gte = new Date(from);
      if (to) query.submittedAt.$lte = new Date(to);
    }
    
    // 🔧 FIX: Filter by role before populating
    if (role) {
      const usersWithRole = await User.find({ role }).select("_id");
      const userIds = usersWithRole.map(u => u._id);
      query.user = { $in: userIds };
    }
    
    const total = await Reimbursement.countDocuments(query);
    const reimbursements = await Reimbursement.find(query)
      .populate("user", "name username email mobileNumber role assignedBranches")
      .populate("approver", "name")
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));
    
    res.json({ 
      rows: reimbursements, 
      total, 
      page: Number(page), 
      limit: Number(limit) 
    });
  } catch (err) {
    console.error("Failed to fetch reimbursements", err);
    res.status(500).json({ 
      message: "Failed to fetch reimbursements", 
      error: err.message 
    });
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
    
    res.json({ message: "Reimbursement deleted successfully" });
  } catch (err) {
    res.status(500).json({ 
      message: "Failed to delete reimbursement", 
      error: err.message 
    });
  }
});

export default router;