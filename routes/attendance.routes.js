import express from 'express';
import Attendance from '../models/Attendance.js';
import authMiddleware from '../middleware/authMiddleware.js'; 
import upload from '../config/multer.js';
import User from '../models/User.js';
import mongoose from 'mongoose'; 
import axios from 'axios'; //  For reverse geocoding
import cloudinary from '../config/cloudinary.js';
import fs from 'fs';

const router = express.Router();

// ✅ PUNCH IN/OUT
router.post('/punch', authMiddleware, upload.single('selfie'), async (req, res) => {
  console.log('🔥 HIT /api/attendance/punch route');
  try {
    const { punchType, lat, lng } = req.body;

    // Validations
    if (!['in', 'out'].includes(punchType)) {
      return res.status(400).json({ message: 'Invalid or missing punch type' });
    }
    if (!lat || !lng) {
      return res.status(400).json({ message: 'Location is required' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Selfie is required' });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const lastToday = await Attendance.findOne({
      user: req.user.id,
      punchType,
      createdAt: { $gte: today }
    });

    if (lastToday) {
      return res.status(400).json({ message: `Already punched ${punchType.toUpperCase()} today` });
    }

    // ✅ Reverse geocode location
    let location = "";
    try {
      const geoRes = await axios.get("https://nominatim.openstreetmap.org/reverse", {
        params: {
          format: "json",
          lat,
          lon: lng,
        },
        headers: {
          "User-Agent": "LaxmiPowertechApp/1.0 (contact@laxmipowertech.com)"
        }
      });
      location = geoRes.data.display_name || `Lat: ${lat}, Lng: ${lng}`;
    } catch (error) {
      console.error("Reverse geocoding failed:", error.message);
      location = `Lat: ${lat}, Lng: ${lng}`;
    }
    const result = await cloudinary.uploader.upload(req.file.path, {
      folder: 'laxmipowertech/selfies',
      public_id: `${req.user.id}_${Date.now()}`,
    });
    fs.unlinkSync(req.file.path);
    // Save attendance
    const attendance = new Attendance({
      user: req.user.id,
      punchType,
      lat,
      lng,
      location,
      selfieUrl: result.secure_url,
    });

    await attendance.save();
    res.status(201).json({ message: 'Punch recorded', attendance });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to save attendance' });
  }
});

// ✅ GET: My Attendance History
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const records = await Attendance.find({ user: req.user.id }).sort({ createdAt: -1 });
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch attendance records' });
  }
});

// ✅ GET: All Attendance (Admin View)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const records = await Attendance.find()
      .sort({ createdAt: -1 })
      .populate('user', 'name email');
    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch attendance records' });
  }
});

// ✅ GET: Attendance Summary
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const { project, month, year } = req.query;

    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);

    const records = await Attendance.aggregate([
      {
        $match: {
          createdAt: { $gte: startDate, $lte: endDate },
        },
      },
      {
        $lookup: {
          from: 'users',
          localField: 'user',
          foreignField: '_id',
          as: 'user',
        },
      },
      { $unwind: '$user' },
      {
        $match: {
          'user.project': new mongoose.Types.ObjectId(project),
          ...(role && { 'user.role': role })
        },
      },
      {
        $group: {
          _id: '$user._id',
          user: { $first: '$user' },
          present: {
            $sum: {
              $cond: [{ $eq: ['$punchType', 'in'] }, 1, 0],
            },
          },
          absent: {
            $sum: {
              $cond: [{ $eq: ['$punchType', 'absent'] }, 1, 0],
            },
          },
          halfDay: {
            $sum: {
              $cond: [{ $eq: ['$punchType', 'half'] }, 1, 0],
            },
          },
          weekOff: {
            $sum: {
              $cond: [{ $eq: ['$punchType', 'weekoff'] }, 1, 0],
            },
          },
          paidLeave: {
            $sum: {
              $cond: [{ $eq: ['$punchType', 'paidleave'] }, 1, 0],
            },
          },
          unpaidLeave: {
            $sum: {
              $cond: [{ $eq: ['$punchType', 'unpaidleave'] }, 1, 0],
            },
          },
          overtime: {
            $sum: {
              $cond: [{ $eq: ['$punchType', 'overtime'] }, 1, 0],
            },
          },
        },
      },
    ]);

    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to generate summary' });
  }
});

// ✅ GET: Is User Already Punched In/Out Today?
router.get('/today', authMiddleware, async (req, res) => {
  try {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const records = await Attendance.find({
      user: req.user.id,
      createdAt: { $gte: startOfDay },
    });

    const punchedIn = records.some((r) => r.punchType === 'in');
    const punchedOut = records.some((r) => r.punchType === 'out');

    res.json({ punchedIn, punchedOut });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch today\'s attendance' });
  }
});

// ✅ GET: Live Dashboard Attendance (Admin)
router.get('/live', authMiddleware, async (req, res) => {
  try {
    const { project, role, branch } = req.query;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const attendanceToday = await Attendance.find({
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).populate('user');

    const userQuery = {};
    if (project) userQuery.project = project;
    if (role) userQuery.role = role;
    if (branch) userQuery.assignedBranches = new mongoose.Types.ObjectId(branch);

    const users = await User.find(userQuery);

    const liveData = users.map((user) => {
      const records = attendanceToday.filter((a) =>
        a.user._id.toString() === user._id.toString()
      );

      const punchIn = records.find((r) => r.punchType === "in");
      const punchOut = records.find((r) => r.punchType === "out");

      let status = "no_punch";
      let punchTime = null;
      let location = null;
      let selfieUrl = null;

      if (punchIn && !punchOut) {
        status = "in";
        punchTime = new Date(punchIn.createdAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        location = punchIn.location;
        selfieUrl = punchIn.selfieUrl;
      } else if (punchIn && punchOut) {
        status = "out";
        punchTime = new Date(punchOut.createdAt).toLocaleTimeString("en-US", {
          hour: "2-digit",
          minute: "2-digit",
        });
        location = punchOut.location;
        selfieUrl = punchOut.selfieUrl;
      }

      return {
        _id: user._id,
        name: user.name,
        status,
        punchTime,
        location,
        selfieUrl,
        avatar: user.photo || null,
        role: user.role,
        branches: user.assignedBranches,
      };
    });

    res.json(liveData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch live attendance' });
  }
});

export default router;
