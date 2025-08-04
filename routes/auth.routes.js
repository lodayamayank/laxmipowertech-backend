import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import User from '../models/User.js';
import protect from '../middleware/authMiddleware.js';

const router = express.Router();

// Login Route
router.post('/login', async (req, res) => {
  console.log('📲 Login attempt from:', req.ip);
  console.log('Request body:', req.body);

  try {
    const { username, password } = req.body;

    // const user = await User.findOne({ email });
    // if (!user) return res.status(401).json({ message: 'Invalid credentials' });

    // const isMatch = await bcrypt.compare(password, user.password);
    // if (!isMatch) return res.status(401).json({ message: 'Invalid credentials' });

    
    const user = await User.findOne({ username });
    if (!user) {
      console.log("❌ No user found for:", username);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      console.log("❌ Password mismatch for user:", username);
      console.log("Entered:", password);
      console.log("Stored:", user.password);
      return res.status(401).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    res.status(200).json({
      message: 'Login successful',
      token,
      user: {
        id: user._id,
        name: user.name,
        //email: user.email,
        role: user.role,
        username: user.username,
      },
    });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

// Authenticated profile test route
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
