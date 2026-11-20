import express from 'express';
import Branch from '../models/Branch.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

router.get("/ping", authMiddleware, (req, res) => {
  res.json({ ok: true });
});
// GET all branches
let cache = { data: null, exp: 0 };

router.get("/", authMiddleware, async (req, res) => {
  try {
    if (!cache.data || cache.exp < Date.now()) {
      cache = {
        data: await Branch.find().sort({ createdAt: -1 }).lean(),
        exp: Date.now() + 30_000,
      };
    }
    res.json(cache.data);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch branches" });
  }
});


export const invalidateBranchCache = () => {
  cache.exp = 0;
};

// GET single branch by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const branch = await Branch.findById(req.params.id);
    if (!branch) {
      return res.status(404).json({ message: 'Branch not found' });
    }
    res.json(branch);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch branch', error: err.message });
  }
});

// POST create a new branch
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, lat, lng, radius } = req.body;
    if (!name || lat == null || lng == null) {
      return res.status(400).json({ message: 'Missing required fields' });
    }

    const branch = new Branch({ name, lat, lng, radius });
    await branch.save();
    invalidateBranchCache();
    res.status(201).json(branch);
  } catch (err) {
    res.status(500).json({ message: 'Failed to create branch' });
  }
});

// PUT update a branch
// PUT /api/branches/:id
router.put("/:id", authMiddleware, async (req, res) => {
  try {
    const { name, radius, location } = req.body;

    const updatedBranch = await Branch.findByIdAndUpdate(
      req.params.id,
      { name, radius, location },
      { new: true },
    );

    if (!updatedBranch) {
      return res.status(404).json({ message: "Branch not found" });
    }
    invalidateBranchCache();
    res.json(updatedBranch);
  } catch (error) {
    console.error("Error updating branch:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE a branch
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    const deleted = await Branch.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Branch not found' });
    invalidateBranchCache();
    res.json({ message: 'Branch deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete branch' });
  }
});

export default router;
