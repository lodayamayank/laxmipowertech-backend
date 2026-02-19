import express from 'express';
import Branch from '../models/Branch.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// GET all branches
router.get('/', authMiddleware, async (req, res) => {
  try {
    const branches = await Branch.find().sort({ createdAt: -1 });
    res.json(branches);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch branches' });
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
    res.status(201).json(branch);
  } catch (err) {
    res.status(500).json({ message: 'Failed to create branch' });
  }
});

// PUT update a branch
// PUT /api/branches/:id
router.put("/:id", async (req, res) => {
    try {
      const { name, radius, location } = req.body;
  
      const updatedBranch = await Branch.findByIdAndUpdate(
        req.params.id,
        { name, radius, location },
        { new: true }
      );
  
      if (!updatedBranch) {
        return res.status(404).json({ message: "Branch not found" });
      }
  
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
    res.json({ message: 'Branch deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete branch' });
  }
});

export default router;
