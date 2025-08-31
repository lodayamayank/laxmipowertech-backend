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

// ✅ GET: All Attendance (Admin View) with Filters + Notes
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { role, project, month, year } = req.query;

    // Date filter
    const monthNum = parseInt(month) || new Date().getMonth() + 1;
    const yearNum = parseInt(year) || new Date().getFullYear();

    const startDate = new Date(yearNum, monthNum - 1, 1);
    const endDate = new Date(yearNum, monthNum, 0, 23, 59, 59);

    // Build user filter
    const userQuery = {};
    if (role) userQuery.role = role.toLowerCase();
    if (project && mongoose.Types.ObjectId.isValid(project)) {
      userQuery.project = new mongoose.Types.ObjectId(project);
    }

    // Find all users (respect role/project filter)
    const users = await User.find(userQuery).lean();

    // Find attendance records for those users within the month
    const userIds = users.map((u) => u._id);
    const records = await Attendance.find({
      user: { $in: userIds },
      createdAt: { $gte: startDate, $lte: endDate },
    })
      .sort({ createdAt: -1 })
      .populate('user', 'name role email employeeId project');

    // ✅ Enrich with notes
    const AttendanceNote = (await import('../models/AttendanceNote.js')).default;
    const keys = records.map((r) => ({
      user: r.user?._id,
      date: new Date(r.createdAt).toISOString().split('T')[0],
    }));

    const notes = await AttendanceNote.find({
      $or: keys.map((k) => ({ userId: k.user, date: k.date })),
    }).lean();

    const notesMap = new Map(notes.map((n) => [`${n.userId}_${n.date}`, n.note]));

    const enriched = records.map((r) => {
      const dateKey = new Date(r.createdAt).toISOString().split('T')[0];
      return {
        ...r.toObject(),
        note: notesMap.get(`${r.user?._id}_${dateKey}`) || '',
      };
    });

    res.json(enriched);
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
    //if (project) userQuery.project = project;
    if (role) userQuery.role = role.toLowerCase();

    const users = await User.find(userQuery).lean();

    const results = [];

    for (const u of users) {
      const punches = await Attendance.find({
        user: u._id,
        createdAt: { $gte: startDate, $lte: endDate },
      }).lean();

      // Group punches per day
      const byDay = {};
      punches.forEach((p) => {
        const key = new Date(p.createdAt).toISOString().split('T')[0];
        if (!byDay[key]) byDay[key] = { ins: [], outs: [] };
        if (p.punchType === 'in') byDay[key].ins.push(new Date(p.createdAt));
        if (p.punchType === 'out') byDay[key].outs.push(new Date(p.createdAt));
      });

      // Counters
      let present = 0,
        absent = 0,
        halfDay = 0,
        weekOff = 0,
        overtime = 0;

      // --- NEW: Fetch leaves for this user in this month
      const leaves = await Leave.find({
        user: u._id,
        startDate: { $lte: endDate },
        endDate: { $gte: startDate },
      }).lean();

      let paidLeave = 0,
        unpaidLeave = 0;

      const leaveDays = new Set();
      leaves.forEach((leave) => {
        const leaveStart = leave.startDate < startDate ? startDate : leave.startDate;
        const leaveEnd = leave.endDate > endDate ? endDate : leave.endDate;

        for (let d = new Date(leaveStart); d <= leaveEnd; d.setDate(d.getDate() + 1)) {
          const key = d.toISOString().split('T')[0];
          leaveDays.add(key);
          if (leave.type === 'paid') paidLeave++;
          if (leave.type === 'unpaid') unpaidLeave++;
        }
      });

      // Process each day of the month
      const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
      for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(yearNum, monthNum - 1, day);
        const key = d.toISOString().split('T')[0];
        const dow = d.getDay();

        if (dow === 0) {
          weekOff++;
          continue;
        }

        if (leaveDays.has(key)) {
          continue; // Skip days already counted as leave
        }

        const data = byDay[key];
        if (!data) {
          absent++;
          continue;
        }

        if (data.ins.length && data.outs.length) {
          const firstIn = Math.min(...data.ins.map((x) => x.getTime()));
          const lastOut = Math.max(...data.outs.map((x) => x.getTime()));
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
