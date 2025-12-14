// --- backend/routes/auth.routes.js ---
import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

// ✅ Login Route
router.post('/login', async (req, res) => {
  console.log('📲 Login attempt from:', req.ip);
  console.log('Request body:', req.body);

  try {
    let { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ message: 'Username and password are required' });
    }

    // ✅ Normalize username (trim + lowercase)
    username = username.trim().toLowerCase();

    const user = await User.findOne({ username }).populate('assignedBranches', 'name');
    if (!user) {
      console.log("❌ No user found for:", username);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // ✅ Compare password
    const isMatch = await bcrypt.compare(password, user.password);
    console.log("🔑 Login attempt:", {
      entered: password,
      stored: user.password,
      match: isMatch,
    });

    if (!isMatch) {
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    // ✅ Generate token
    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        role: user.role,
        username: user.username,
        assignedBranches: user.assignedBranches || [],
      },
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// ✅ Authenticated profile test route
router.get('/me', protect, async (req, res) => {
  try {
    const user = await User.findById(req.user.id)
      .select('-password')
      .populate({
        path: 'assignedBranches',
        select: 'name lat lng radius',
      });

    if (!user) return res.status(404).json({ message: 'User not found' });

    res.json({
      message: `Hello ${user.name}, your role is ${user.role}`,
      user,
    });
  } catch (err) {
    console.error("❌ Failed to fetch user:", err);
    res.status(500).json({ message: 'Failed to fetch user profile', error: err.message });
  }
});

export default router;
