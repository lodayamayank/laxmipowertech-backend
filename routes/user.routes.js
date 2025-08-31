// --- backend/routes/user.routes.js ---
import express from 'express';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// Get allowed roles
router.get('/roles', (req, res) => {
  const roles = User.schema.path('role').enumValues;
  res.json(roles);
});

// ✅ Register a user (with password hashing)
router.post('/register', authMiddleware, async (req, res) => {
  try {
    let { password, ...rest } = req.body;

    // Fallback if password not provided
    if (!password || password.trim() === '') {
      password = 'default123';
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = new User({
      ...rest,
      password: hashedPassword,
    });

    await newUser.save();

    const populatedUser = await User.findById(newUser._id)
      .populate('project', 'name')
      .populate('assignedBranches', 'name radius lat lng address');

    res.status(201).json(populatedUser);
  } catch (err) {
    res.status(400).json({ message: 'Failed to register user', error: err.message });
  }
});


// ✅ Get current user profile
router.get('/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .populate('project', 'name')
      .populate('assignedBranches', 'name radius lat lng address');

    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json(user);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch user profile', error: err.message });
  }
});

// ✅ Get all users
router.get('/', authMiddleware, async (req, res) => {
  try {
    const users = await User.find()
      .populate('project', 'name')
      .populate('assignedBranches', 'name radius lat lng address');
    res.json(users);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch users', error: err.message });
  }
});

// ✅ Update current user profile (skip hashing here unless password is updated)
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const updateData = { ...req.body };

    if (updateData.password && updateData.password.trim()) {
      updateData.password = await bcrypt.hash(updateData.password.trim(), 10);
    } else {
      delete updateData.password;
    }

    const updated = await User.findByIdAndUpdate(userId, updateData, { new: true })
      .populate('project', 'name')
      .populate('assignedBranches', 'name radius lat lng address');

    res.json(updated);
  } catch (err) {
    console.error('❌ Update failed:', err);
    res.status(500).json({ message: 'Failed to update profile', error: err.message });
  }
});

// ✅ Update user by ID (with optional password hashing)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const updateData = { ...req.body };

    if (updateData.password) {
      updateData.password = await bcrypt.hash(updateData.password, 10);
    }
    //Remove invalid project field
    if (!updateData.project || updateData.project === '') {
      delete updateData.project;
    }

    const updatedUser = await User.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
    })
      .populate('project', 'name')
      .populate('assignedBranches', 'name radius lat lng address');

    res.json(updatedUser);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update user', error: err.message });
  }
});

// ✅ Delete a user
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await User.findByIdAndDelete(req.params.id);
    res.json({ message: 'User deleted successfully' });
  } catch (err) {
    res.status(500).json({ message: 'Failed to delete user', error: err.message });
  }
});

export default router;
