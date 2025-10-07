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

// ✅ Register a user (with password hashing + default fallback)
// router.post('/register', authMiddleware, async (req, res) => {
//   try {
//     let { password, ...rest } = req.body;

//     // Always ensure password is set
//     const rawPassword = password && password.trim()
//       ? password.trim()
//       : "default123";

//     const hashedPassword = await bcrypt.hash(rawPassword, 10);

//     const newUser = new User({
//       ...rest,
//       username: rest.username.trim().toLowerCase(),
//       password: hashedPassword,
//     });

//     await newUser.save();

//     const populatedUser = await User.findById(newUser._id)
//       .populate('project', 'name')
//       .populate('assignedBranches', 'name radius lat lng address');

//     res.status(201).json(populatedUser);
//   } catch (err) {
//     res.status(400).json({ message: 'Failed to register user', error: err.message });
//   }
// });
// In user.routes.js - Update the register route
router.post('/register', authMiddleware, async (req, res) => {
  try {
    const { password, ...rest } = req.body;

    const newUser = new User({
      ...rest,
      username: rest.username.trim().toLowerCase(),
      password: password || "default123", // Let the pre-save hook handle hashing
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

// ✅ Update current user profile
router.put('/me', authMiddleware, async (req, res) => {
  try {
    const userId = req.user._id;
    const updateData = { ...req.body };

    if (updateData.password && updateData.password.trim()) {
      updateData.password = await bcrypt.hash(updateData.password.trim(), 10);
    } else {
      delete updateData.password;
    }

    const allowedFields = [
      'name', 'mobileNumber', 'personalEmail', 'dateOfBirth', 'maritalStatus',
      'aadhaarNumber', 'panNumber', 'drivingLicense', 'emergencyContact',
      'address', 'employeeType', 'dateOfJoining', 'dateOfLeaving', 'employeeId',
      'department', 'jobTitle', 'project', 'assignedBranches', 'role', 'password'
    ];

    Object.keys(updateData).forEach((key) => {
      if (!allowedFields.includes(key)) delete updateData[key];
    });

    const updated = await User.findByIdAndUpdate(userId, updateData, { new: true })
      .populate('project', 'name')
      .populate('assignedBranches', 'name radius lat lng address');

    res.json(updated);
  } catch (err) {
    console.error('❌ Update failed:', err);
    res.status(500).json({ message: 'Failed to update profile', error: err.message });
  }
});

// ✅ Update user by ID (with optional password hashing + safe default)
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    console.log('📥 [Backend] Received req.body:', req.body);

    const updateData = { ...req.body };

    if (updateData.password && updateData.password.trim()) {
      updateData.password = await bcrypt.hash(updateData.password.trim(), 10);
    } else {
      delete updateData.password;
    }

    // Remove invalid project field
    if (!updateData.project || updateData.project === '') {
      delete updateData.project;
    }

    const allowedFields = [
      'name', 'mobileNumber', 'personalEmail', 'dateOfBirth', 'maritalStatus',
      'aadhaarNumber', 'panNumber', 'drivingLicense', 'emergencyContact',
      'address', 'employeeType', 'dateOfJoining', 'dateOfLeaving', 'employeeId',
      'department', 'jobTitle', 'project', 'assignedBranches', 'role', 'password', 'username'
    ];

    Object.keys(updateData).forEach((key) => {
      if (!allowedFields.includes(key)) {
        console.log(`⚠️ [Backend] Removing disallowed field: ${key}`);
        delete updateData[key];
      }
    });

    console.log('📤 [Backend] Filtered updateData:', updateData);
    console.log('📤 [Backend] Specific fields:', {
      personalEmail: updateData.personalEmail,
      dateOfBirth: updateData.dateOfBirth,
      maritalStatus: updateData.maritalStatus,
      aadhaarNumber: updateData.aadhaarNumber,
      panNumber: updateData.panNumber,
      drivingLicense: updateData.drivingLicense,
      emergencyContact: updateData.emergencyContact,
      employeeType: updateData.employeeType,
      employeeId: updateData.employeeId,
      department: updateData.department,
      dateOfLeaving: updateData.dateOfLeaving,
    });

    // Remove empty string values that shouldn't be sent
    Object.keys(updateData).forEach((key) => {
      if (updateData[key] === '') {
        delete updateData[key];
      }
    });
    console.log('📤 [Backend] Final updateData after removing empty strings:', updateData);

    const updatedUser = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },  // Use $set operator explicitly
      {
        new: true,
        runValidators: true,
        strict: false  // Allow fields not in schema (shouldn't be needed but helps debug)
      }
    )
      .populate('project', 'name')
      .populate('assignedBranches', 'name radius lat lng address');

    console.log('✅ [Backend] Updated user:', updatedUser);
    console.log('✅ [Backend] Updated specific fields:', {
      personalEmail: updatedUser.personalEmail,
      dateOfBirth: updatedUser.dateOfBirth,
      maritalStatus: updatedUser.maritalStatus,
      aadhaarNumber: updatedUser.aadhaarNumber,
      panNumber: updatedUser.panNumber,
      drivingLicense: updatedUser.drivingLicense,
      emergencyContact: updatedUser.emergencyContact,
      employeeType: updatedUser.employeeType,
      employeeId: updatedUser.employeeId,
      department: updatedUser.department,
      dateOfLeaving: updatedUser.dateOfLeaving
    });

    res.json(updatedUser);
  } catch (err) {
    console.error('❌ [Backend] Update failed:', err);
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
// ✅ Admin Reset Password (force default123)
router.post('/reset-password/:username', authMiddleware, async (req, res) => {
  try {
    // Only admins can reset
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: "Access denied. Admins only." });
    }

    const { username } = req.params;
    const rawPassword = "default123";
    const hashedPassword = await bcrypt.hash(rawPassword, 10);

    const updatedUser = await User.findOneAndUpdate(
      { username },
      { password: hashedPassword },
      { new: true }
    );

    if (!updatedUser) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({
      message: `Password reset to '${rawPassword}' successfully.`,
      username: updatedUser.username,
    });
  } catch (err) {
    console.error("❌ Reset password failed:", err);
    res.status(500).json({ message: "Failed to reset password", error: err.message });
  }
});
router.put('/:id/personal', authMiddleware, async (req, res) => {
  try {
    const updateData = { ...req.body };
    delete updateData.password; // ⚠️ Never update password through this route
    delete updateData.username; // ⚠️ Never update username through this route

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update personal info', error: err.message });
  }
});

router.put('/:id/employee', authMiddleware, async (req, res) => {
  try {
    const updateData = { ...req.body };
    delete updateData.password; // ⚠️ Never update password through this route
    delete updateData.username; // ⚠️ Never update username through this route

    const updated = await User.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true }
    );
    res.json(updated);
  } catch (err) {
    res.status(500).json({ message: 'Failed to update employee info', error: err.message });
  }
});


export default router;
