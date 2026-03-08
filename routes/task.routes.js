import express from 'express';
import auth from '../middleware/authMiddleware.js';
import Task from '../models/Task.js';
import Project from '../models/Project.js';
import { filterByUserBranches } from '../middleware/branchAuthMiddleware.js';
import { upload, uploadToCloudinary, deleteFromCloudinary } from '../middleware/cloudinaryMaterialMiddleware.js';

const router = express.Router();

// Create new task (Supervisor only)
router.post('/', auth, upload.single('photo'), async (req, res) => {
  try {
    const { project, branch, building, wing, floor, flat, room, notes } = req.body;
    
    // Validate required fields
    if (!project || !building || !wing || !floor || !flat || !room) {
      return res.status(400).json({ 
        success: false,
        message: 'All hierarchy levels are required' 
      });
    }

    // Validate photo upload
    if (!req.file) {
      return res.status(400).json({ 
        success: false,
        message: 'Photo is required' 
      });
    }

    // Upload photo to Cloudinary
    const cloudinaryResult = await uploadToCloudinary(req.file.path, 'tasks');
    
    // Parse building, wing, floor, flat, room from JSON strings if needed
    const buildingData = typeof building === 'string' ? JSON.parse(building) : building;
    const wingData = typeof wing === 'string' ? JSON.parse(wing) : wing;
    const floorData = typeof floor === 'string' ? JSON.parse(floor) : floor;
    const flatData = typeof flat === 'string' ? JSON.parse(flat) : flat;
    const roomData = typeof room === 'string' ? JSON.parse(room) : room;

    // Create task
    const task = new Task({
      project,
      branch: branch || null,
      building: buildingData,
      wing: wingData,
      floor: floorData,
      flat: flatData,
      room: roomData,
      supervisor: req.user.id,
      photoUrl: cloudinaryResult.secure_url,
      photoPublicId: cloudinaryResult.public_id,
      notes: notes || '',
      status: 'completed'
    });

    await task.save();

    // Populate before sending response
    await task.populate('supervisor', 'name email role');
    await task.populate('project', 'name address');
    if (task.branch) {
      await task.populate('branch', 'name address');
    }

    res.status(201).json({
      success: true,
      message: 'Task submitted successfully',
      data: task
    });
  } catch (err) {
    console.error('Error creating task:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to create task', 
      error: err.message 
    });
  }
});

// Get all tasks with filtering (Admin & Supervisor)
router.get('/', auth, filterByUserBranches, async (req, res) => {
  try {
    const { 
      project, 
      building, 
      wing, 
      floor, 
      flat, 
      supervisor, 
      startDate, 
      endDate,
      page = 1, 
      limit = 50 
    } = req.query;
    
    const filter = {};

    // Apply role-based filtering
    if (req.user.role === 'supervisor' || req.user.role === 'subcontractor') {
      // Supervisors only see their own tasks
      filter.supervisor = req.user.id;
    }

    // Apply filters
    if (project) filter.project = project;
    if (building) filter['building.name'] = { $regex: building, $options: 'i' };
    if (wing) filter['wing.name'] = { $regex: wing, $options: 'i' };
    if (floor) filter['floor.name'] = { $regex: floor, $options: 'i' };
    if (flat) filter['flat.name'] = { $regex: flat, $options: 'i' };
    if (supervisor) filter.supervisor = supervisor;

    // Date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const total = await Task.countDocuments(filter);

    const tasks = await Task.find(filter)
      .populate('project', 'name address')
      .populate('branch', 'name address')
      .populate('supervisor', 'name email role')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit));

    res.json({
      success: true,
      data: tasks,
      pagination: {
        currentPage: parseInt(page),
        totalPages: Math.ceil(total / limit),
        totalItems: total,
        itemsPerPage: parseInt(limit)
      }
    });
  } catch (err) {
    console.error('Error fetching tasks:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch tasks', 
      error: err.message 
    });
  }
});

// Get task by ID
router.get('/:id', auth, async (req, res) => {
  try {
    const task = await Task.findById(req.params.id)
      .populate('project', 'name address')
      .populate('branch', 'name address')
      .populate('supervisor', 'name email role');

    if (!task) {
      return res.status(404).json({ 
        success: false,
        message: 'Task not found' 
      });
    }

    // Check authorization: supervisors can only view their own tasks, admins can view all
    if (req.user.role === 'supervisor' || req.user.role === 'subcontractor') {
      if (task.supervisor._id.toString() !== req.user.id) {
        return res.status(403).json({ 
          success: false,
          message: 'Not authorized to view this task' 
        });
      }
    }

    res.json({
      success: true,
      data: task
    });
  } catch (err) {
    console.error('Error fetching task:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch task', 
      error: err.message 
    });
  }
});

// Update task status (Admin only)
router.put('/:id/status', auth, async (req, res) => {
  try {
    // Only admin can update task status
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false,
        message: 'Only admins can update task status' 
      });
    }

    const { status } = req.body;
    const validStatuses = ['pending', 'in-progress', 'completed', 'verified'];
    
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ 
        success: false,
        message: `Invalid status. Valid statuses: ${validStatuses.join(', ')}` 
      });
    }

    const task = await Task.findByIdAndUpdate(
      req.params.id,
      { status },
      { new: true }
    ).populate('supervisor', 'name email role')
     .populate('project', 'name address');

    if (!task) {
      return res.status(404).json({ 
        success: false,
        message: 'Task not found' 
      });
    }

    res.json({
      success: true,
      message: 'Task status updated successfully',
      data: task
    });
  } catch (err) {
    console.error('Error updating task status:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to update task status', 
      error: err.message 
    });
  }
});

// Delete task (Admin only)
router.delete('/:id', auth, async (req, res) => {
  try {
    // Only admin can delete tasks
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false,
        message: 'Only admins can delete tasks' 
      });
    }

    const task = await Task.findById(req.params.id);

    if (!task) {
      return res.status(404).json({ 
        success: false,
        message: 'Task not found' 
      });
    }

    // Delete photo from Cloudinary
    if (task.photoPublicId) {
      await deleteFromCloudinary(task.photoPublicId);
    }

    await task.deleteOne();

    res.json({
      success: true,
      message: 'Task deleted successfully'
    });
  } catch (err) {
    console.error('Error deleting task:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to delete task', 
      error: err.message 
    });
  }
});

// Get task statistics (Admin only)
router.get('/stats/summary', auth, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ 
        success: false,
        message: 'Only admins can view statistics' 
      });
    }

    const { project, startDate, endDate } = req.query;
    const filter = {};

    if (project) filter.project = project;
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = new Date(startDate);
      if (endDate) {
        const end = new Date(endDate);
        end.setHours(23, 59, 59, 999);
        filter.createdAt.$lte = end;
      }
    }

    const totalTasks = await Task.countDocuments(filter);
    const tasksByStatus = await Task.aggregate([
      { $match: filter },
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]);

    const tasksByProject = await Task.aggregate([
      { $match: filter },
      { $group: { _id: '$project', count: { $sum: 1 } } },
      { $lookup: { from: 'projects', localField: '_id', foreignField: '_id', as: 'project' } },
      { $unwind: '$project' },
      { $project: { projectName: '$project.name', count: 1 } }
    ]);

    res.json({
      success: true,
      data: {
        totalTasks,
        tasksByStatus,
        tasksByProject
      }
    });
  } catch (err) {
    console.error('Error fetching task statistics:', err);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch statistics', 
      error: err.message 
    });
  }
});

export default router;
