import express from 'express';
import Project from '../models/Project.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// Create a new project
router.post('/', authMiddleware, async (req, res) => {
  try {
    const { name, address, branches, buildings } = req.body;
    const project = new Project({ 
      name, 
      address, 
      branches,
      buildings: buildings || [] // Support buildings hierarchy for task tracking
    });
    await project.save();
    res.status(201).json(await project.populate('branches', 'name address'));
  } catch (err) {
    res.status(400).json({ message: 'Failed to create project', error: err.message });
  }
});

// Get all projects
router.get('/', authMiddleware, async (req, res) => {
  try {
    const projects = await Project.find()
      .sort({ createdAt: -1 })
      .populate('branches', 'name address');
    res.json(projects);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch projects', error: err.message });
  }
});

// Update a project
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const { name, address, branches, buildings } = req.body;
    const updateData = { name, address, branches };
    
    // Only update buildings if provided
    if (buildings !== undefined) {
      updateData.buildings = buildings;
    }
    
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true }
    ).populate('branches', 'name address');
    res.json(project);
  } catch (err) {
    res.status(400).json({ message: 'Failed to update project', error: err.message });
  }
});

// Get project by ID
router.get('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id)
      .populate('branches', 'name address');
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    res.json(project);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch project', error: err.message });
  }
});

// Get project hierarchy (buildings structure for task dropdowns)
router.get('/:id/hierarchy', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findById(req.params.id).select('buildings');
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    res.json({ buildings: project.buildings || [] });
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch project hierarchy', error: err.message });
  }
});

// Update project hierarchy (buildings structure)
router.put('/:id/hierarchy', authMiddleware, async (req, res) => {
  try {
    const { buildings } = req.body;
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { buildings },
      { new: true }
    );
    if (!project) {
      return res.status(404).json({ message: 'Project not found' });
    }
    res.json({ message: 'Project hierarchy updated successfully', buildings: project.buildings });
  } catch (err) {
    res.status(400).json({ message: 'Failed to update project hierarchy', error: err.message });
  }
});

// Delete a project
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await Project.findByIdAndDelete(req.params.id);
    res.json({ message: 'Project deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete project', error: err.message });
  }
});

export default router;
