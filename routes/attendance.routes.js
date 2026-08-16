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
import {
  resolveCapturedAt,
  findExistingByClientId,
  isDuplicateClientIdError,
  readClientId,
} from '../utils/offlineSync.js';

const router = express.Router();

// Admin must type this exact phrase to confirm a bulk delete. Kept in sync
// with the matching literal in AdminDeleteAttendance.jsx on the frontend.
const DELETE_CONFIRMATION_PHRASE = 'DELETE ATTENDANCE RECORDS';

// Cloudinary secure_urls look like
// https://res.cloudinary.com/<cloud>/image/upload/v169.../laxmipowertech/selfies/<id>.jpg
// The public_id (needed to delete the asset) is the folder+filename with the
// version segment and extension stripped off.
const extractCloudinaryPublicId = (url) => {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?([^?]+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  return match ? match[1] : null;
};

// Resolve a startDate/endDate query pair into a [00:00:00, 23:59:59] range.
// A missing endDate collapses the range onto startDate alone (single-day delete).
const resolveDeleteRange = (startDate, endDate) => {
  if (!startDate || isNaN(new Date(startDate))) {
    return { error: 'A valid startDate is required' };
  }

  const rangeStart = new Date(startDate);
  rangeStart.setHours(0, 0, 0, 0);

  const rangeEnd = endDate && !isNaN(new Date(endDate)) ? new Date(endDate) : new Date(startDate);
  rangeEnd.setHours(23, 59, 59, 999);

  if (rangeEnd < rangeStart) {
    return { error: 'endDate cannot be before startDate' };
  }

  return { rangeStart, rangeEnd };
};

// Drop a multer temp file we are not going to use (early return / error path).
const discardUpload = (file) => {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch {
    /* already gone – nothing to clean up */
  }
};

// ✅ PUNCH IN/OUT
router.post('/punch', authMiddleware, upload.single('selfie'), async (req, res) => {
  console.log('🔥 HIT /api/attendance/punch route');
  try {
    const { punchType, lat, lng } = req.body;
    console.log("REQ BODY:", req.body);
    console.log("REQ FILE:", req.file);
    console.log("REQ USER:", req.user);

    if (!['in', 'out'].includes(punchType)) {
      discardUpload(req.file);
      return res.status(400).json({ message: 'Invalid or missing punch type' });
    }
    if (!lat || !lng) {
      discardUpload(req.file);
      return res.status(400).json({ message: 'Location is required' });
    }
    if (!req.file) {
      return res.status(400).json({ message: 'Selfie is required' });
    }

    // Offline replay: if this exact punch already landed, return it instead of
    // recording a second one. Checked before the Cloudinary upload so a retry
    // does not re-upload the selfie.
    const clientId = readClientId(req.body);
    const existing = await findExistingByClientId(Attendance, clientId);
    if (existing) {
      discardUpload(req.file);
      console.log(`↩️  Duplicate punch replay for clientId=${clientId}, returning original`);
      return res.status(200).json({ message: 'Punch already recorded', attendance: existing, duplicate: true });
    }

    // An offline punch carries the time it was taken on the device; a live
    // punch has no capturedAt and falls back to the server clock.
    const { date: punchedAt, backdated } = resolveCapturedAt(req.body.capturedAt);

    // ✅ Reverse geocode
    let location = `Lat: ${lat}, Lng: ${lng}`;
    try {
      const geoRes = await axios.get("https://nominatim.openstreetmap.org/reverse", {
        params: { format: "json", lat: Number(lat), lon: Number(lng) },
        headers: { "User-Agent": "LaxmiPowertechApp/1.0" }
      });
      if (geoRes.data?.display_name) {
        location = geoRes.data.display_name;
      }
    } catch (error) {
      console.error("Reverse geocoding failed:", error.message);
    }

    // ✅ Upload selfie
    let selfieUrl = "";
    try {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: "laxmipowertech/selfies",
        public_id: `${req.user.id}_${Date.now()}`,
        // Cloudinary's perceptual-quality algorithm re-encodes the image at
        // the smallest size that looks the same as the original — this runs
        // once at upload time, so the stored file (and secure_url) is already
        // the compressed version. "auto:good" biases toward preserving
        // quality over squeezing out the last few KB.
        quality: "auto:good",
      });
      selfieUrl = result.secure_url;
      fs.unlinkSync(req.file.path); // clean up
    } catch (uploadErr) {
      console.error("Cloudinary upload failed:", uploadErr);
      discardUpload(req.file);
      return res.status(500).json({ error: "Selfie upload failed", details: uploadErr.message });
    }

    // ✅ Save attendance
    try {
      const attendance = new Attendance({
        user: req.user.id,
        punchType,
        lat: Number(lat),
        lng: Number(lng),
        location,
        selfieUrl,
        date: punchedAt,
        ...(clientId ? { clientId } : {}),
        syncedOffline: backdated,
      });

      await attendance.save();
      return res.status(201).json({ message: "Punch recorded", attendance });
    } catch (saveErr) {
      // Two replays raced: the loser hit the unique clientId index. The punch
      // exists, so this is a success from the client's point of view.
      if (isDuplicateClientIdError(saveErr)) {
        const winner = await findExistingByClientId(Attendance, clientId);
        if (winner) {
          return res.status(200).json({ message: 'Punch already recorded', attendance: winner, duplicate: true });
        }
      }
      console.error("DB save failed:", saveErr);
      return res.status(500).json({ error: "Failed to save attendance", details: saveErr.message });
    }
  } catch (err) {
    console.error("🔥 Punch route fatal error:", err);
    res.status(500).json({ error: "Punch route failed", details: err.message });
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


router.get("/", authMiddleware, async (req, res) => {
  try {
    const { role, project, month, year, startDate, endDate } = req.query;

    // --- Default date range ---
    let filterStart, filterEnd;

    if (startDate && endDate && !isNaN(new Date(startDate)) && !isNaN(new Date(endDate))) {
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

    // --- User filter ---
    const userQuery = {};
    if (role) userQuery.role = String(role).toLowerCase();

    if (project && mongoose.Types.ObjectId.isValid(project)) {
      userQuery.project = new mongoose.Types.ObjectId(project);
    }

    const users = await User.find(userQuery).populate("assignedBranches").lean();
    if (!users.length) {
      return res.json([]); // no users matched filters
    }

    const userIds = users.map((u) => u._id);

    // --- Attendance records ---
    let records = await Attendance.find({
      user: { $in: userIds },
      createdAt: { $gte: filterStart, $lte: filterEnd },
    })
      .sort({ createdAt: -1 })
      .populate("user", "name role email employeeId assignedBranches")
      .populate("leaveId", "type")
      .lean();

    // --- Notes ---
    const keys = records
      .filter((r) => r.user?._id)
      .map((r) => ({
        userId: r.user._id,
        date: new Date(r.createdAt).toISOString().split("T")[0],
      }));

    const notes = await AttendanceNote.find({
      $or: keys.map((k) => ({ userId: k.userId, date: k.date })),
    }).lean();

    const notesMap = new Map(notes.map((n) => [`${n.userId}_${n.date}`, n.note]));

    // --- Branches ---
    const branches = await Branch.find().lean();

    function findBranchForPunch(lat, lng, assignedBranchIds) {
      if (!lat || !lng) return null;

      const assigned = branches.filter((b) =>
        assignedBranchIds?.some((id) => id.toString() === b._id.toString())
      );

      for (const b of assigned) {
        const distance =
          Math.sqrt(Math.pow(lat - b.lat, 2) + Math.pow(lng - b.lng, 2)) *
          111000;
        if (distance <= (b.radius || 500)) return b.name;
      }
      return null;
    }

    // --- Final enrich ---
    records = records.map((r) => {
      const dateKey = new Date(r.createdAt).toISOString().split("T")[0];
      const branchName = findBranchForPunch(
        Number(r.lat),
        Number(r.lng),
        r.user?.assignedBranches || []
      );
      return {
        ...r,
        note: notesMap.get(`${r.user?._id}_${dateKey}`) || "",
        branch: branchName || "Outside Assigned Branch",
      };
    });

    res.json(records);
  } catch (err) {
    console.error("❌ Error in GET /attendance:", err);
    res.status(500).json({
      message: "Failed to fetch attendance records",
      error: err.message,
      stack: err.stack,
    });
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
        date: { $gte: startDate, $lte: endDate },   // ✅ use date, not createdAt
      })
        .populate("leaveId", "type")                // ✅ populate leaveId
        .lean();

      // Group punches per day
      const byDay = {};
      punches.forEach((p) => {
        const key = new Date(p.date).toISOString().split("T")[0];
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
        const key = d.toISOString().split("T")[0];
        const dow = d.getDay();

        const punchesToday = byDay[key] || [];

        // Allow weekend attendance - no automatic week off

        // ✅ Check for leave
        const leavePunch = punchesToday.find((p) => p.punchType === "leave");
        if (leavePunch) {
          const leaveType = leavePunch.leaveId?.type || "unpaid";

          if (leaveType === "paid") paidLeave++;
          else if (leaveType === "unpaid") unpaidLeave++;
          else if (leaveType === "sick") sickLeave++;
          else if (leaveType === "casual") casualLeave++;
          else unpaidLeave++;

          continue;
        }

        // ✅ Check for present/absent
        const ins = punchesToday.filter((p) => p.punchType === "in").map((x) => new Date(x.createdAt));
        const outs = punchesToday.filter((p) => p.punchType === "out").map((x) => new Date(x.createdAt));

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
        employeeId: u.employeeId || "-",
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
    res.status(500).json({ message: "Failed to generate summary" });
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


// ✅ POST: Bulk Attendance (for Labour Management)
router.post('/bulk', authMiddleware, async (req, res) => {
  console.log('🔥 HIT /api/attendance/bulk route');
  console.log('📦 Request body:', req.body);
  try {
    const { records } = req.body;

    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: 'Records array is required' });
    }

    const results = [];
    const errors = [];

    for (const record of records) {
      const { user, branch, status, date, punchTime } = record;

      if (!user || !status || !date) {
        errors.push({ user, message: 'Missing required fields' });
        continue;
      }

      try {
        // in/out records are separate per direction; absent/present/half-day are one record per day
        const startOfDay = new Date(date + 'T00:00:00.000Z');
        const endOfDay   = new Date(date + 'T23:59:59.999Z');
        const dateRange  = { $gte: startOfDay, $lte: endOfDay };

        // Guard: punch-out requires an existing punch-in on the same day
        if (status === 'out') {
          const hasIn = await Attendance.findOne({ user, date: dateRange, punchType: 'in' }).lean();
          if (!hasIn) {
            errors.push({ user, message: 'Cannot punch out without a punch in record for this date' });
            continue;
          }
          // Also validate punch-out time is after punch-in time
          if (punchTime && hasIn) {
            const inTime  = new Date(hasIn.punchTime || hasIn.createdAt);
            const outTime = new Date(punchTime);
            if (outTime <= inTime) {
              errors.push({ user, message: 'Punch out time must be after punch in time' });
              continue;
            }
          }
        }

        const isPunchDirection = status === 'in' || status === 'out';
        const query = isPunchDirection
          ? { user, date: dateRange, punchType: status }
          : { user, date: dateRange, punchType: { $in: ['absent', 'present', 'half-day', 'half'] } };

        const existing = await Attendance.findOne(query);
        const resolvedPunchTime = punchTime ? new Date(punchTime) : undefined;

        if (existing) {
          existing.punchType = status;
          if (resolvedPunchTime) existing.punchTime = resolvedPunchTime;
          if (branch) existing.branch = branch;
          await existing.save();
          results.push(existing);
        } else {
          const attendance = new Attendance({
            user,
            branch,
            punchType: status,
            date: new Date(date),
            ...(resolvedPunchTime && { punchTime: resolvedPunchTime }),
            lat: 0,
            lng: 0,
            selfieUrl: null,
          });
          await attendance.save();
          results.push(attendance);
        }
      } catch (err) {
        errors.push({ user, message: err.message });
      }
    }

    if (errors.length > 0) {
      return res.status(207).json({
        message: 'Partial success',
        results,
        errors
      });
    }

    res.status(201).json({
      message: 'Attendance marked successfully',
      results
    });
  } catch (err) {
    console.error('Bulk attendance error:', err);
    res.status(500).json({ message: 'Failed to mark attendance', error: err.message });
  }
});

// ✅ GET: Fetch attendance by branch and date (for Labour Management)
router.get('/by-date', authMiddleware, async (req, res) => {
  console.log('🔥 HIT /api/attendance/by-date route');
  console.log('📦 Query params:', req.query);
  try {
    const { branch, date } = req.query;

    if (!date) {
      return res.status(400).json({ message: 'Date is required' });
    }

    // Use a full-day UTC range so records stored at any time within the day are matched
    const startOfDay = new Date(date + 'T00:00:00.000Z');
    const endOfDay   = new Date(date + 'T23:59:59.999Z');

    const query = {
      date: { $gte: startOfDay, $lte: endOfDay },
    };

    if (branch) {
      query.branch = branch;
    }

    const attendance = await Attendance.find(query)
      .populate('user', 'name username mobileNumber jobTitle role')
      .lean();

    res.json(attendance);
  } catch (err) {
    console.error('Fetch attendance by date error:', err);
    res.status(500).json({ message: 'Failed to fetch attendance', error: err.message });
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


// ✅ GET: Preview how many attendance records a date/date-range delete would affect
// (Admin) — used to populate the confirmation screen before a bulk delete.
router.get('/admin/delete-preview', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can perform this action' });
    }

    const { startDate, endDate } = req.query;
    const range = resolveDeleteRange(startDate, endDate);
    if (range.error) {
      return res.status(400).json({ message: range.error });
    }
    const { rangeStart, rangeEnd } = range;

    const query = { date: { $gte: rangeStart, $lte: rangeEnd } };
    const count = await Attendance.countDocuments(query);
    const withSelfies = await Attendance.countDocuments({
      ...query,
      selfieUrl: { $nin: [null, ''] },
    });

    res.json({
      count,
      withSelfies,
      startDate: rangeStart.toISOString(),
      endDate: rangeEnd.toISOString(),
    });
  } catch (err) {
    console.error('Delete preview error:', err);
    res.status(500).json({ message: 'Failed to preview attendance records', error: err.message });
  }
});

// ✅ DELETE: Bulk-delete attendance records and/or their Cloudinary selfies for
// a date/date-range (Admin only). The admin picks a target — database, Cloudinary,
// or both — via deleteFromDatabase / deleteFromCloudinary. Requires the admin to
// have typed the exact confirmation phrase, checked again here in case this is
// called directly.
router.delete('/admin/bulk-delete', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can perform this action' });
    }

    const { startDate, endDate, confirmationPhrase, deleteFromDatabase, deleteFromCloudinary } = req.body;

    if (confirmationPhrase !== DELETE_CONFIRMATION_PHRASE) {
      return res.status(400).json({
        message: `Confirmation phrase does not match. Type "${DELETE_CONFIRMATION_PHRASE}" to proceed.`,
      });
    }

    if (!deleteFromDatabase && !deleteFromCloudinary) {
      return res.status(400).json({ message: 'Select at least one target: database or Cloudinary' });
    }

    const range = resolveDeleteRange(startDate, endDate);
    if (range.error) {
      return res.status(400).json({ message: range.error });
    }
    const { rangeStart, rangeEnd } = range;

    const query = { date: { $gte: rangeStart, $lte: rangeEnd } };
    const records = await Attendance.find(query).select('selfieUrl').lean();

    if (!records.length) {
      return res.status(404).json({ message: 'No attendance records found in the selected period' });
    }

    let cloudinaryDeleted = 0;
    let cloudinaryFailed = 0;

    if (deleteFromCloudinary) {
      // Map public_id back to its record so a Cloudinary-only delete can clear
      // the now-dangling selfieUrl without touching the rest of the document.
      const publicIdToRecordId = new Map();
      records.forEach((r) => {
        const publicId = extractCloudinaryPublicId(r.selfieUrl);
        if (publicId) publicIdToRecordId.set(publicId, r._id);
      });
      const publicIds = [...publicIdToRecordId.keys()];
      const deletedRecordIds = [];

      // Batched at 100 (the admin delete_resources limit) — a Cloudinary hiccup
      // should not block the rest of the request.
      for (let i = 0; i < publicIds.length; i += 100) {
        const batch = publicIds.slice(i, i + 100);
        try {
          const result = await cloudinary.api.delete_resources(batch);
          batch.forEach((publicId) => {
            if (result.deleted?.[publicId] === 'deleted') {
              cloudinaryDeleted += 1;
              deletedRecordIds.push(publicIdToRecordId.get(publicId));
            } else {
              cloudinaryFailed += 1;
            }
          });
        } catch (cloudErr) {
          console.error('Cloudinary batch delete failed:', cloudErr.message);
          cloudinaryFailed += batch.length;
        }
      }

      // Only clear selfieUrl when the DB record itself is being kept — if it's
      // about to be deleted wholesale below, there's nothing to clean up here.
      if (!deleteFromDatabase && deletedRecordIds.length) {
        await Attendance.updateMany(
          { _id: { $in: deletedRecordIds } },
          { $set: { selfieUrl: null } }
        );
      }
    }

    let deletedCount = 0;
    if (deleteFromDatabase) {
      const deleteResult = await Attendance.deleteMany(query);
      deletedCount = deleteResult.deletedCount;
    }

    console.log(
      `🗑️  Admin ${req.user.email || req.user.id} bulk-deleted attendance for ` +
        `${rangeStart.toISOString()} to ${rangeEnd.toISOString()} ` +
        `(database=${!!deleteFromDatabase}, cloudinary=${!!deleteFromCloudinary}, ` +
        `deletedCount=${deletedCount}, cloudinaryDeleted=${cloudinaryDeleted})`
    );

    res.json({
      message: 'Attendance records processed successfully',
      deletedCount,
      cloudinaryDeleted,
      cloudinaryFailed,
      deleteFromDatabase: !!deleteFromDatabase,
      deleteFromCloudinary: !!deleteFromCloudinary,
      startDate: rangeStart.toISOString(),
      endDate: rangeEnd.toISOString(),
    });
  } catch (err) {
    console.error('Bulk delete attendance error:', err);
    res.status(500).json({ message: 'Failed to delete attendance records', error: err.message });
  }
});

export default router;
