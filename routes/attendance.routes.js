import express from 'express';
import Attendance from '../models/Attendance.js';
import authMiddleware from '../middleware/authMiddleware.js';
import upload from '../config/multer.js';
import User from '../models/User.js';
import mongoose from 'mongoose';
import axios from 'axios'; //  For reverse geocoding
import cloudinary from '../config/cloudinary.js';
import fs from 'fs';
import Leave from '../models/Leave.js';
import Branch from '../models/Branch.js';
import AttendanceNote from '../models/AttendanceNote.js';

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

// ✅ GET: My Attendance History (Punches + Leaves)
// ✅ GET: My Attendance History (with leave info)
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const records = await Attendance.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .populate('leaveId', 'type startDate endDate'); // 🔑 populate leave type

    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch attendance records' });
  }
});


// ✅ GET: All Attendance (Admin View) with Filters + Notes + Branch check
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { role, project, month, year, startDate, endDate, page = 1, limit = 20 } = req.query;

    let filterStart, filterEnd;

    if (startDate && endDate) {
      filterStart = new Date(startDate);
      filterStart.setHours(0, 0, 0, 0);

      filterEnd = new Date(endDate);
      filterEnd.setHours(23, 59, 59, 999);
    } else {
      const monthNum = parseInt(month) || new Date().getMonth() + 1;
      const yearNum = parseInt(year) || new Date().getFullYear();

      filterStart = new Date(yearNum, monthNum - 1, 1);
      filterEnd = new Date(yearNum, monthNum, 0, 23, 59, 59);
    }

    // Build user filter
    const userQuery = {};
    if (role) userQuery.role = role.toLowerCase();
    if (project && mongoose.Types.ObjectId.isValid(project)) {
      userQuery.project = new mongoose.Types.ObjectId(project);
    }

    // Find all users (respect role/project filter)
    const users = await User.find(userQuery).populate('assignedBranches').lean();
    const userIds = users.map((u) => u._id);

    // Pagination math
    const skip = (Number(page) - 1) * Number(limit);

    // Total count first
    const total = await Attendance.countDocuments(query);

    // Then fetch page of results
    const records = await Attendance.find(query)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit))
      .populate('user', 'name role email employeeId assignedBranches')
      .lean();

    // --- enrich with branch + notes same as before ---
    // (you can reuse your existing branch + note enrichment code here)

    res.json({
      rows: records,
      total,
      page: Number(page),
      totalPages: Math.ceil(total / limit),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch attendance records' });
  }
});







// ✅ GET: Attendance Summary (Aggregated per User)
router.get('/summary', authMiddleware, async (req, res) => {
  try {
    let { project, role, month, year } = req.query;

    const monthNum = parseInt(month) || new Date().getMonth() + 1;
    const yearNum = parseInt(year) || new Date().getFullYear();

    const startDate = new Date(yearNum, monthNum - 1, 1);
    const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59);

    // Fetch users by role/project
    const userQuery = {};
    if (role) userQuery.role = role.toLowerCase();
    if (project && mongoose.Types.ObjectId.isValid(project)) {
      userQuery.project = project;
    }

    const users = await User.find(userQuery).lean();
    const results = [];

    for (const u of users) {
      // Fetch attendance for the user in this month
      const punches = await Attendance.find({
        user: u._id,
        createdAt: { $gte: startDate, $lte: endDate },
      }).lean();

      // Group punches per day
      const byDay = {};
      punches.forEach((p) => {
        const key = new Date(p.createdAt).toISOString().split('T')[0];
        if (!byDay[key]) byDay[key] = [];
        byDay[key].push(p);
      });

      // Counters
      let present = 0,
        absent = 0,
        halfDay = 0,
        weekOff = 0,
        overtime = 0,
        paidLeave = 0,
        unpaidLeave = 0,
        sickLeave = 0,
        casualLeave = 0;

      const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(yearNum, monthNum - 1, day);
        const key = d.toISOString().split('T')[0];
        const dow = d.getDay();

        const punchesToday = byDay[key] || [];

        if (dow === 0) {
          weekOff++;
          continue;
        }

        if (punchesToday.some((p) => p.punchType === 'leave')) {
          // classify leave type
          const leavePunch = punchesToday.find((p) => p.punchType === 'leave');
          const leaveType = leavePunch?.leaveId?.type || 'unpaid';

          if (leaveType === 'paid') paidLeave++;
          else if (leaveType === 'unpaid') unpaidLeave++;
          else if (leaveType === 'sick') sickLeave++;
          else if (leaveType === 'casual') casualLeave++;

          continue;
        }

        const ins = punchesToday.filter((p) => p.punchType === 'in').map((x) => new Date(x.createdAt));
        const outs = punchesToday.filter((p) => p.punchType === 'out').map((x) => new Date(x.createdAt));

        if (!ins.length && !outs.length) {
          absent++;
          continue;
        }

        if (ins.length && outs.length) {
          const firstIn = Math.min(...ins.map((x) => x.getTime()));
          const lastOut = Math.max(...outs.map((x) => x.getTime()));
          const minutes = Math.round((lastOut - firstIn) / 60000);

          if (minutes >= 480) present++;
          else if (minutes >= 240) halfDay++;
          else absent++;

          if (minutes > 540) overtime++;
        } else {
          halfDay++;
        }
      }

      results.push({
        name: u.name,
        employeeId: u.employeeId || '-',
        present,
        absent,
        halfDay,
        weekOff,
        paidLeave,
        unpaidLeave,
        sickLeave,
        casualLeave,
        overtime,
      });
    }

    res.json(results);
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
// ✅ GET: Live Dashboard Attendance (Admin)
router.get('/live', authMiddleware, async (req, res) => {
  try {
    const { project, role, branch } = req.query;

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    // Get all attendance records for today
    const attendanceToday = await Attendance.find({
      createdAt: { $gte: startOfDay, $lte: endOfDay },
    }).populate('user');

    // Also fetch today's approved leaves
    const leavesToday = await Leave.find({
      status: "approved",
      startDate: { $lte: endOfDay },
      endDate: { $gte: startOfDay },
    }).populate("user");

    const userQuery = {};
    if (project) userQuery.project = project;
    if (role) userQuery.role = role;
    if (branch) userQuery.assignedBranches = new mongoose.Types.ObjectId(branch);

    const users = await User.find(userQuery).populate('assignedBranches').lean();

    // ✅ Load all branches from DB once
    const Branch = (await import('../models/Branch.js')).default;
    const branches = await Branch.find().lean();

    function findBranchForPunch(lat, lng, assignedBranchIds) {
      if (!lat || !lng) return null;

      const assigned = branches.filter((b) =>
        assignedBranchIds.some((id) => id.toString() === b._id.toString())
      );

      for (const b of assigned) {
        const distance =
          Math.sqrt(Math.pow(lat - b.lat, 2) + Math.pow(lng - b.lng, 2)) *
          111000; // meters
        if (distance <= (b.radius || 500)) {
          return b.name;
        }
      }
      return null;
    }

    const liveData = users.map((user) => {
      const records = attendanceToday.filter(
        (a) => a.user._id.toString() === user._id.toString()
      );

      const punchIn = records.find((r) => r.punchType === 'in');
      const punchOut = records.find((r) => r.punchType === 'out');

      // ✅ Check leave record
      const leaveToday = leavesToday.find(
        (l) => l.user._id.toString() === user._id.toString()
      );

      let status = 'no_punch';
      let punchTime = null;
      let branchName = 'Outside Assigned Branch';
      let selfieUrl = null;

      if (leaveToday) {
        status = leaveToday.type === "paid" ? "paidleave" : "unpaidleave";
        punchTime = null;
        branchName = "On Leave";
        selfieUrl = null;
      } else if (punchIn && !punchOut) {
        status = 'in';
        punchTime = new Date(punchIn.createdAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        });
        branchName =
          findBranchForPunch(
            Number(punchIn.lat),
            Number(punchIn.lng),
            user.assignedBranches
          ) || 'Outside Assigned Branch';
        selfieUrl = punchIn.selfieUrl;
      } else if (punchIn && punchOut) {
        status = 'out';
        punchTime = new Date(punchOut.createdAt).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
        });
        branchName =
          findBranchForPunch(
            Number(punchOut.lat),
            Number(punchOut.lng),
            user.assignedBranches
          ) || 'Outside Assigned Branch';
        selfieUrl = punchOut.selfieUrl;
      }

      return {
        _id: user._id,
        name: user.name,
        role: user.role,
        status,       // can be "in" / "out" / "paidleave" / "unpaidleave" / "no_punch"
        punchTime,
        branch: branchName,
        selfieUrl,
        avatar: user.photo || null,
      };
    });

    res.json(liveData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch live attendance' });
  }
});


// ✅ GET note for user+date
router.get('/notes/:userId/:date', authMiddleware, async (req, res) => {
  try {
    const { userId, date } = req.params;
    const note = await AttendanceNote.findOne({ userId, date });
    res.json(note || { note: '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch note' });
  }
});

// ✅ POST/UPDATE note
router.post('/notes/:userId/:date', authMiddleware, async (req, res) => {
  try {
    const { userId, date } = req.params;
    const { note } = req.body;

    const updated = await AttendanceNote.findOneAndUpdate(
      { userId, date },
      { userId, date, note },
      { upsert: true, new: true }
    );

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save note' });
  }
});



export default router;
