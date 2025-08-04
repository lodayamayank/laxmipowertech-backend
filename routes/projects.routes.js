import express from 'express';
import Project from '../models/Project.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// Create a new project
router.post('/', authMiddleware, async (req, res) => {
  try {
    const project = new Project(req.body);
    await project.save();
    res.status(201).json(project);
  } catch (err) {
    res.status(400).json({ message: 'Failed to create project', error: err.message });
  }
});

// Get all projects
router.get('/', authMiddleware, async (req, res) => {
  try {
    const projects = await Project.find().sort({ createdAt: -1 });
    res.json(projects);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch projects', error: err.message });
  }
});

// Update a project
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const project = await Project.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(project);
  } catch (err) {
    res.status(400).json({ message: 'Failed to update project', error: err.message });
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