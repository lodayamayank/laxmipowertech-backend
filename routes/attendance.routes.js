import express from 'express';
import { randomInt } from 'node:crypto';
import Attendance from '../models/Attendance.js';
import authMiddleware from '../middleware/authMiddleware.js';
import upload from '../config/multer.js';
import User from '../models/User.js';
import SupervisorAttendanceCode from '../models/SupervisorAttendanceCode.js';
import mongoose from 'mongoose';
import axios from 'axios'; // For reverse geocoding
import cloudinary from '../config/cloudinary.js';
import fs from 'fs';
import Leave from '../models/Leave.js';
import {
  findBranchForPunch,
  findNearestAssignedBranch,
} from '../utils/branchMatching.js';
import AttendanceNote from '../models/AttendanceNote.js';
import {
  resolveCapturedAt,
  findExistingByClientId,
  isDuplicateClientIdError,
  readClientId,
} from '../utils/offlineSync.js';
import { getBranches } from '../utils/branchCache.js';

const router = express.Router();

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

const generateDailyCode = () => String(randomInt(100000, 1000000));

// Midnight today in India, as a UTC Date (00:00 IST = 18:30 UTC previous day).
const getServerDay = () => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  return new Date(Date.UTC(get('year'), get('month') - 1, get('day')) - IST_OFFSET_MS);
};

// IST calendar key (YYYY-MM-DD); independent of server timezone.
const formatDateKey = (date) =>
  new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);

// UTC calendar key, used for notes and the legacy per-day grouping.
const dayKey = (d) => new Date(d).toISOString().split('T')[0];

// Tiny in-memory TTL cache (per server instance, capped at 200 entries).
// Cleared on every attendance write so dashboards never show stale data for long.
const memo = new Map();
const cached = async (key, ttlMs, fn) => {
  const hit = memo.get(key);
  if (hit && hit.exp > Date.now()) return hit.value;
  const value = await fn();
  if (memo.size >= 200) memo.delete(memo.keys().next().value);
  memo.set(key, { value, exp: Date.now() + ttlMs });
  return value;
};

// Serve Cloudinary selfies compressed (applied at delivery, not at upload).
const optimizeSelfie = (url) =>
  url && url.includes('/upload/') && !url.includes('/upload/q_auto')
    ? url.replace('/upload/', '/upload/q_auto:good,f_auto/')
    : url;

// Atomic upsert: no find/create/retry dance, no delete on the hot path
// (old codes are removed by the TTL index on SupervisorAttendanceCode.date).
const findOrCreateSupervisorCode = async (supervisorId, branchId, date) => {
  const query = { supervisor: supervisorId, branch: branchId, date };
  try {
    return await SupervisorAttendanceCode.findOneAndUpdate(
      query,
      { $setOnInsert: { code: generateDailyCode() } },
      { upsert: true, new: true, lean: true }
    );
  } catch (error) {
    if (error?.code !== 11000) throw error;
    return SupervisorAttendanceCode.findOne(query).lean(); // lost the upsert race
  }
};

// Must match the literal in AdminDeleteAttendance.jsx on the frontend.
const DELETE_CONFIRMATION_PHRASE = 'DELETE ATTENDANCE RECORDS';

// Cloudinary secure_url -> public_id (folder + filename, no version/extension).
const extractCloudinaryPublicId = (url) => {
  if (!url || typeof url !== 'string') return null;
  const match = url.match(/\/upload\/(?:v\d+\/)?([^?]+)\.[a-zA-Z0-9]+(?:\?.*)?$/);
  return match ? match[1] : null;
};

// startDate/endDate -> [00:00:00, 23:59:59]; missing endDate = single day.
const resolveDeleteRange = (startDate, endDate) => {
  if (!startDate || isNaN(new Date(startDate))) {
    return { error: 'A valid startDate is required' };
  }
  const rangeStart = new Date(startDate);
  rangeStart.setHours(0, 0, 0, 0);

  const rangeEnd =
    endDate && !isNaN(new Date(endDate)) ? new Date(endDate) : new Date(startDate);
  rangeEnd.setHours(23, 59, 59, 999);

  if (rangeEnd < rangeStart) return { error: 'endDate cannot be before startDate' };
  return { rangeStart, rangeEnd };
};

// Drop a multer temp file we are not going to use.
const discardUpload = (file) => {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch {
    /* already gone */
  }
};

// Reverse geocode with a hard timeout; never throws.
const geocode = async (lat, lng) => {
  const fallback = `Lat: ${lat}, Lng: ${lng}`;
  try {
    const r = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { format: 'json', lat: Number(lat), lon: Number(lng) },
      headers: { 'User-Agent': 'LaxmiPowertechApp/1.0' },
      timeout: 2500,
    });
    return r.data?.display_name || fallback;
  } catch (error) {
    console.error('Reverse geocoding failed:', error.message);
    return fallback;
  }
};

// Shared by GET / and GET /user/:userId. Attaches note + resolved branch name.
const enrichRecords = (rawRecords, userOf, notesMap, branchMap, branches) =>
  rawRecords.map((r) => {
    const user = userOf(r);
    const dk = dayKey(r.createdAt);
    const branchName =
      (r.branch && branchMap.get(String(r.branch))?.name) ||
      findBranchForPunch(Number(r.lat), Number(r.lng), user?.assignedBranches || [], branches);
    return {
      ...r,
      user,
      selfieUrl: optimizeSelfie(r.selfieUrl),
      note: notesMap.get(`${user?._id}_${dk}`) || '',
      branch: branchName || 'Outside Assigned Branch',
    };
  });

/* -------------------------------------------------------------------------- */
/* POST /punch                                                                */
/* -------------------------------------------------------------------------- */

router.post('/punch', authMiddleware, upload.single('selfie'), async (req, res) => {
  try {
    const { punchType, lat, lng } = req.body;

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

    // Offline replay: return the original punch before re-uploading the selfie.
    const clientId = readClientId(req.body);
    const existing = await findExistingByClientId(Attendance, clientId);
    if (existing) {
      discardUpload(req.file);
      return res
        .status(200)
        .json({ message: 'Punch already recorded', attendance: existing, duplicate: true });
    }

    // Offline punches carry the device time; live punches use the server clock.
    const { date: punchedAt, backdated } = resolveCapturedAt(req.body.capturedAt);

    // Upload without transformations (faster); compression happens at delivery.
    let selfieUrl;
    try {
      const result = await cloudinary.uploader.upload(req.file.path, {
        folder: 'laxmipowertech/selfies',
        public_id: `${req.user.id}_${Date.now()}`,
      });
      selfieUrl = result.secure_url;
    } catch (uploadErr) {
      console.error('Cloudinary upload failed:', uploadErr);
      return res.status(500).json({ error: 'Selfie upload failed', details: uploadErr.message });
    } finally {
      discardUpload(req.file);
    }

    let attendance;
    try {
      attendance = new Attendance({
        user: req.user.id,
        punchType,
        lat: Number(lat),
        lng: Number(lng),
        location: `Lat: ${lat}, Lng: ${lng}`, // address is filled in after responding
        selfieUrl,
        markedBy: 'Selfie',
        date: punchedAt,
        ...(clientId ? { clientId } : {}),
        syncedOffline: backdated,
      });
      await attendance.save();
    } catch (saveErr) {
      // Racing replay hit the unique clientId index: the punch exists, so succeed.
      if (isDuplicateClientIdError(saveErr)) {
        const winner = await findExistingByClientId(Attendance, clientId);
        if (winner) {
          return res
            .status(200)
            .json({ message: 'Punch already recorded', attendance: winner, duplicate: true });
        }
      }
      console.error('DB save failed:', saveErr);
      return res.status(500).json({ error: 'Failed to save attendance', details: saveErr.message });
    }

    memo.clear();
    res.status(201).json({ message: 'Punch recorded', attendance });

    // Fire-and-forget: patch the readable address in after the response is sent.
    geocode(lat, lng).then((location) =>
      Attendance.updateOne({ _id: attendance._id }, { location }).catch(() => {})
    );
  } catch (err) {
    console.error('Punch route fatal error:', err);
    discardUpload(req.file);
    res.status(500).json({ error: 'Punch route failed', details: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* Supervisor fallback codes                                                  */
/* -------------------------------------------------------------------------- */

// GET: today's fallback attendance code for the logged-in supervisor
router.get('/supervisor-codes', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'supervisor') {
      return res.status(403).json({ message: 'Only supervisors can access attendance codes' });
    }

    const { lat, lng } = req.query || {};
    if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') {
      return res.status(400).json({ message: 'Valid location is required', codes: [] });
    }

    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ message: 'Invalid location coordinates', codes: [] });
    }

    // Branches come from the cache instead of populate().
    const [{ map: branchMap }, supervisor] = await Promise.all([
      getBranches(),
      User.findById(req.user.id).select('assignedBranches').lean(),
    ]);

    if (!supervisor) return res.status(404).json({ message: 'Supervisor not found' });

    const assignedBranches = (supervisor.assignedBranches || [])
      .map((id) => branchMap.get(String(id)))
      .filter(Boolean);
    if (!assignedBranches.length) return res.json({ codes: [] });

    const matchedBranch = findNearestAssignedBranch(latitude, longitude, assignedBranches, assignedBranches);
    if (!matchedBranch) {
      return res.status(403).json({
        message: 'You are not within any of your assigned branch locations.',
        codes: [],
      });
    }

    const today = getServerDay();
    const record = await findOrCreateSupervisorCode(req.user.id, matchedBranch._id, today);

    return res.json({
      codes: [
        {
          branchId: matchedBranch._id.toString(),
          branchName: matchedBranch.name || '',
          code: record.code,
          date: formatDateKey(today),
        },
      ],
    });
  } catch (error) {
    console.error('Supervisor attendance codes error:', error);
    return res.status(500).json({ message: 'Failed to retrieve attendance codes' });
  }
});

// POST: attendance punch using a supervisor's daily fallback code
router.post('/supervisor-code-punch', authMiddleware, upload.none(), async (req, res) => {
  try {
    const { code, punchType, lat, lng } = req.body || {};

    if (!['in', 'out'].includes(punchType)) {
      return res.status(400).json({ message: 'Invalid or missing punch type' });
    }
    if (typeof code !== 'string' || !/^\d{6}$/.test(code)) {
      return res.status(400).json({ message: 'Code must be a 6-digit number' });
    }
    if (lat === undefined || lat === null || lat === '' || lng === undefined || lng === null || lng === '') {
      return res.status(400).json({ message: 'Location is required' });
    }

    const latitude = Number(lat);
    const longitude = Number(lng);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return res.status(400).json({ message: 'Invalid location coordinates' });
    }

    const [{ list: branches, map: branchMap }, user] = await Promise.all([
      getBranches(),
      User.findById(req.user.id).select('assignedBranches').lean(),
    ]);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const assignedBranches = (user.assignedBranches || [])
      .map((id) => branchMap.get(String(id)))
      .filter(Boolean);

    const detectedBranch = findNearestAssignedBranch(latitude, longitude, assignedBranches, branches);
    if (!detectedBranch) {
      return res.status(400).json({ message: 'You are outside your assigned branch.' });
    }

    const today = getServerDay();
    const tomorrow = new Date(today.getTime() + DAY_MS);

    // Independent lookups run in parallel; results are checked in the original order.
    const [matchingCode, existingAttendance] = await Promise.all([
      SupervisorAttendanceCode.findOne({ branch: detectedBranch._id, date: today, code })
        .populate('supervisor', 'name username')
        .lean(),
      Attendance.findOne({
        user: req.user.id,
        punchType,
        date: { $gte: today, $lt: tomorrow },
      })
        .select('_id')
        .lean(),
    ]);

    if (!matchingCode) {
      return res.status(400).json({ message: 'Invalid or expired supervisor code.' });
    }
    if (existingAttendance) {
      return res.status(400).json({ message: `Punch ${punchType} has already been recorded today.` });
    }

    const attendance = await Attendance.create({
      user: req.user.id,
      punchType,
      lat: latitude,
      lng: longitude,
      branch: detectedBranch._id,
      date: new Date(),
      selfieUrl: null,
      markedBy: `Marked by Supervisor code - ${
        matchingCode.supervisor?.name || matchingCode.supervisor?.username || 'Supervisor'
      }`,
    });

    memo.clear();
    return res.status(201).json({ message: 'Attendance recorded using supervisor code', attendance });
  } catch (error) {
    console.error('Supervisor code punch error:', error);
    return res.status(500).json({ message: 'Failed to record attendance' });
  }
});

/* -------------------------------------------------------------------------- */
/* Reads                                                                      */
/* -------------------------------------------------------------------------- */

// GET: my attendance history. Capped; pass ?limit= (max 500) for more.
router.get('/my', authMiddleware, async (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const records = await Attendance.find({ user: req.user.id })
      .sort({ createdAt: -1 })
      .limit(limit)
      .populate('leaveId', 'type startDate endDate')
      .lean();

    res.json(records);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch attendance records' });
  }
});

// GET: attendance records for a role/project over a date range (admin tables)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const { role, project, month, year, startDate, endDate } = req.query;

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

    const userQuery = {};
    if (role) userQuery.role = String(role).toLowerCase();
    if (project && mongoose.Types.ObjectId.isValid(project)) {
      userQuery.project = new mongoose.Types.ObjectId(project);
    }

    // Only the fields the response needs; branches come from the cache.
    const [users, { list: branches, map: branchMap }] = await Promise.all([
      User.find(userQuery).select('name role email employeeId assignedBranches').lean(),
      getBranches(),
    ]);
    if (!users.length) return res.json([]);

    const userMap = new Map(users.map((u) => [String(u._id), u]));
    const userIds = users.map((u) => u._id);

    // Notes are fetched as one range query (not one $or clause per record).
    const [rawRecords, notes] = await Promise.all([
      Attendance.find({ user: { $in: userIds }, createdAt: { $gte: filterStart, $lte: filterEnd } })
        .sort({ createdAt: -1 })
        .populate('leaveId', 'type')
        .lean(),
      AttendanceNote.find({
        userId: { $in: userIds },
        date: {
          $gte: dayKey(new Date(filterStart.getTime() - DAY_MS)),
          $lte: dayKey(new Date(filterEnd.getTime() + DAY_MS)),
        },
      }).lean(),
    ]);

    const notesMap = new Map(notes.map((n) => [`${n.userId}_${n.date}`, n.note]));

    res.json(
      enrichRecords(rawRecords, (r) => userMap.get(String(r.user)), notesMap, branchMap, branches)
    );
  } catch (err) {
    console.error('Error in GET /attendance:', err);
    res.status(500).json({ message: 'Failed to fetch attendance records' });
  }
});

/* -------------------------------------------------------------------------- */
/* GET /summary                                                               */
/* -------------------------------------------------------------------------- */

// 2 queries total (users + one aggregation) instead of one query per user.
// Days are bucketed in IST. Move this into services/attendanceSummary.js if reused.
 export const buildSummary = async ({ userQuery, startDate, endDateExclusive, days }) => {
  const users = await User.find(userQuery).select('name employeeId').lean();
  if (!users.length) return [];

  const stats = new Map(
    users.map((u) => [
      String(u._id),
      {
        present: 0,
        absent: 0,
        halfDay: 0,
        weekOff: 0,
        paidLeave: 0,
        unpaidLeave: 0,
        sickLeave: 0,
        casualLeave: 0,
        overtime: 0,
        rows: 0, // days that have at least one record
      },
    ])
  );

  const isType = (...types) => ({ $in: ['$punchType', types] });
  const when = (cond, then, other = null) => ({ $cond: [cond, then, other] });

  // Collapse all punches of a user-day into one row inside MongoDB.
  const dayRows = await Attendance.aggregate([
    {
      $match: {
        user: { $in: users.map((u) => u._id) },
        date: { $gte: startDate, $lt: endDateExclusive },
      },
    },
    {
      $group: {
        _id: {
          user: '$user',
          day: { $dateToString: { format: '%Y-%m-%d', date: '$date', timezone: 'Asia/Kolkata' } },
        },
        hasLeave: { $max: isType('leave', 'paidleave', 'unpaidleave') },
        paidFlag: { $max: isType('paidleave') },
        leaveId: { $max: when(isType('leave'), '$leaveId') },
        inCount: { $sum: when(isType('in'), 1, 0) },
        outCount: { $sum: when(isType('out'), 1, 0) },
        firstIn: { $min: when(isType('in'), '$createdAt') },
        lastOut: { $max: when(isType('out'), '$createdAt') },
      },
    },
    // Only leave rows carry a leaveId, so this join is tiny.
    { $lookup: { from: Leave.collection.name, localField: 'leaveId', foreignField: '_id', as: 'leave' } },
    { $addFields: { leaveType: { $arrayElemAt: ['$leave.type', 0] } } },
    { $project: { leave: 0 } },
  ]);

  // Same classification rules as before, over the small grouped result.
  for (const r of dayRows) {
    const s = stats.get(String(r._id.user));
    if (!s) continue;
    s.rows++;

    if (r.hasLeave) {
      const t = r.leaveType || (r.paidFlag ? 'paid' : 'unpaid');
      if (t === 'paid') s.paidLeave++;
      else if (t === 'sick') s.sickLeave++;
      else if (t === 'casual') s.casualLeave++;
      else s.unpaidLeave++;
      continue;
    }

    if (!r.inCount && !r.outCount) {
      s.absent++;
      continue;
    }

    if (r.inCount && r.outCount) {
      const minutes = Math.round((r.lastOut - r.firstIn) / 60000);
      if (minutes >= 480) s.present++;
      else if (minutes >= 240) s.halfDay++;
      else s.absent++;
      if (minutes > 540) s.overtime++;
    } else {
      s.halfDay++; // only an "in" or only an "out"
    }
  }

  return users.map((u) => {
    const { rows, ...s } = stats.get(String(u._id));
    s.absent += days.length - rows; // days with no records at all
    return { name: u.name, employeeId: u.employeeId || '-', ...s };
  });
};

router.get('/summary', authMiddleware, async (req, res) => {
  try {
    const { project, role, month, year, startDate: requestedStart, endDate: requestedEnd } = req.query;
    const hasDateRange = requestedStart !== undefined || requestedEnd !== undefined;

    // Calendar range as UTC-midnight dates: [calStart, calEndExcl).
    let calStart;
    let calEndExcl;

    if (hasDateRange) {
      const parseDateOnly = (value) => {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
        const parsed = new Date(`${value}T00:00:00.000Z`);
        return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
          ? parsed
          : null;
      };
      const s = parseDateOnly(requestedStart);
      const e = parseDateOnly(requestedEnd);
      if (!s || !e) {
        return res.status(400).json({ message: 'Valid startDate and endDate in YYYY-MM-DD format are required' });
      }
      if (s > e) return res.status(400).json({ message: 'startDate cannot be after endDate' });
      calStart = s;
      calEndExcl = new Date(e.getTime() + DAY_MS);
    } else {
      const monthNum = parseInt(month) || new Date().getMonth() + 1;
      const yearNum = parseInt(year) || new Date().getFullYear();
      if (monthNum < 1 || monthNum > 12) return res.status(400).json({ message: 'Invalid month' });
      calStart = new Date(Date.UTC(yearNum, monthNum - 1, 1));
      calEndExcl = new Date(Date.UTC(yearNum, monthNum, 1));
    }

    const dayCount = Math.round((calEndExcl - calStart) / DAY_MS);
    if (dayCount > 366) return res.status(400).json({ message: 'Date range cannot exceed 366 days' });

    const days = Array.from({ length: dayCount }, (_, i) =>
      new Date(calStart.getTime() + i * DAY_MS).toISOString().slice(0, 10)
    );
    // Query bounds are IST midnights, matching the IST day grouping above.
    const startDate = new Date(calStart.getTime() - IST_OFFSET_MS);
    const endDateExclusive = new Date(calEndExcl.getTime() - IST_OFFSET_MS);

    const userQuery = {};
    if (role) userQuery.role = String(role).toLowerCase();
    if (project && mongoose.Types.ObjectId.isValid(project)) userQuery.project = project;

    const key = `summary:${userQuery.role || ''}|${userQuery.project || ''}|${days[0]}|${dayCount}`;
    const results = await cached(key, 30_000, () =>
      buildSummary({ userQuery, startDate, endDateExclusive, days })
    );
    res.json(results);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to generate summary' });
  }
});

// GET: one user's attendance for a date range (AttendanceGraphModal)
router.get('/user/:userId', authMiddleware, async (req, res) => {
  try {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;

    if (!mongoose.Types.ObjectId.isValid(userId)) {
      return res.status(400).json({ message: 'Invalid userId' });
    }
    if (!startDate || !endDate || isNaN(new Date(startDate)) || isNaN(new Date(endDate))) {
      return res.status(400).json({ message: 'Valid startDate and endDate are required' });
    }

    // Authorization: self, admin/supervisor, or the user's reporting manager.
    const isSelf = String(req.user.id) === String(userId);
    const privileged = ['admin', 'supervisor'].includes(req.user.role);
    if (!isSelf && !privileged) {
      const reportsToMe = await User.exists({ _id: userId, reportingManager: req.user.id });
      if (!reportsToMe) {
        return res.status(403).json({ message: "Not allowed to view this user's attendance" });
      }
    }

    const filterStart = new Date(startDate);
    filterStart.setHours(0, 0, 0, 0);
    const filterEnd = new Date(endDate);
    filterEnd.setHours(23, 59, 59, 999);

    // Notes are "YYYY-MM-DD" strings; pad the range by a day.
    const noteFrom = dayKey(new Date(filterStart.getTime() - DAY_MS));
    const noteTo = dayKey(new Date(filterEnd.getTime() + DAY_MS));

    // The user is fetched once instead of being populated on every record.
    const [rawRecords, notes, user, { list: branches, map: branchMap }] = await Promise.all([
      Attendance.find({ user: userId, createdAt: { $gte: filterStart, $lte: filterEnd } })
        .sort({ createdAt: -1 })
        .populate('leaveId', 'type')
        .lean(),
      AttendanceNote.find({ userId, date: { $gte: noteFrom, $lte: noteTo } }).lean(),
      User.findById(userId).select('name role email employeeId assignedBranches').lean(),
      getBranches(),
    ]);
    if (!user) return res.json([]);

    const notesMap = new Map(notes.map((n) => [`${n.userId}_${n.date}`, n.note]));

    // Same response shape as GET /attendance.
    res.json(enrichRecords(rawRecords, () => user, notesMap, branchMap, branches));
  } catch (err) {
    console.error('Error in GET /attendance/user/:userId:', err);
    res.status(500).json({ message: 'Failed to fetch attendance records' });
  }
});

// GET: has the user already punched in/out today (IST day)?
router.get('/today', authMiddleware, async (req, res) => {
  try {
    const types = await Attendance.distinct('punchType', {
      user: req.user.id,
      createdAt: { $gte: getServerDay() },
    });
    res.json({ punchedIn: types.includes('in'), punchedOut: types.includes('out') });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Failed to fetch today's attendance" });
  }
});

// GET: live dashboard attendance (admin). Polled often, so cached for 10s.
router.get('/live', authMiddleware, async (req, res) => {
  try {
    const { project, role, branch } = req.query;

    const userQuery = {};
    if (project && mongoose.Types.ObjectId.isValid(project)) userQuery.project = project;
    if (role) userQuery.role = role;
    if (branch && mongoose.Types.ObjectId.isValid(branch)) {
      userQuery.assignedBranches = new mongoose.Types.ObjectId(branch);
    }

    const key = `live:${userQuery.project || ''}|${userQuery.role || ''}|${userQuery.assignedBranches || ''}`;
    const liveData = await cached(key, 10_000, async () => {
      const startOfDay = getServerDay();
      const endOfDay = new Date(startOfDay.getTime() + DAY_MS - 1);

      const [users, { list: branches, map: branchMap }] = await Promise.all([
        User.find(userQuery).select('name role photo assignedBranches').lean(),
        getBranches(),
      ]);
      const userIds = users.map((u) => u._id);

      // Only fetch data for the filtered users, with only the needed fields.
      const [attendanceToday, leavesToday] = await Promise.all([
        Attendance.find({ user: { $in: userIds }, createdAt: { $gte: startOfDay, $lte: endOfDay } })
          .select('user punchType createdAt lat lng selfieUrl')
          .sort({ createdAt: 1 })
          .lean(),
        Leave.find({
          user: { $in: userIds },
          status: 'approved',
          startDate: { $lte: endOfDay },
          endDate: { $gte: startOfDay },
        })
          .select('user type')
          .lean(),
      ]);

      // Group once (O(n)) instead of filtering all records per user.
      const punchesByUser = new Map();
      for (const a of attendanceToday) {
        const k = String(a.user);
        if (!punchesByUser.has(k)) punchesByUser.set(k, []);
        punchesByUser.get(k).push(a);
      }
      const leaveByUser = new Map(leavesToday.map((l) => [String(l.user), l]));

      const fmtTime = (d) =>
        new Date(d).toLocaleTimeString('en-US', {
          hour: '2-digit',
          minute: '2-digit',
          timeZone: 'Asia/Kolkata',
        });

      return users.map((user) => {
        const records = punchesByUser.get(String(user._id)) || [];
        const punchIn = records.find((r) => r.punchType === 'in');
        const punchOut = records.find((r) => r.punchType === 'out');
        const leaveToday = leaveByUser.get(String(user._id));
        const assigned = (user.assignedBranches || [])
          .map((id) => branchMap.get(String(id)))
          .filter(Boolean);
        const branchOf = (p) =>
          findBranchForPunch(Number(p.lat), Number(p.lng), assigned, branches) ||
          'Outside Assigned Branch';

        let status = 'no_punch'; // "in" | "out" | "paidleave" | "unpaidleave" | "no_punch"
        let punchTime = null;
        let branchName = 'Outside Assigned Branch';
        let selfieUrl = null;

        if (leaveToday) {
          status = leaveToday.type === 'paid' ? 'paidleave' : 'unpaidleave';
          branchName = 'On Leave';
        } else if (punchIn && !punchOut) {
          status = 'in';
          punchTime = fmtTime(punchIn.createdAt);
          branchName = branchOf(punchIn);
          selfieUrl = optimizeSelfie(punchIn.selfieUrl);
        } else if (punchIn && punchOut) {
          status = 'out';
          punchTime = fmtTime(punchOut.createdAt);
          branchName = branchOf(punchOut);
          selfieUrl = optimizeSelfie(punchOut.selfieUrl);
        }

        return {
          _id: user._id,
          name: user.name,
          role: user.role,
          status,
          punchTime,
          branch: branchName,
          selfieUrl,
          avatar: user.photo || null,
        };
      });
    });

    res.json(liveData);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch live attendance' });
  }
});

/* -------------------------------------------------------------------------- */
/* POST /bulk (Labour Management)                                             */
/* -------------------------------------------------------------------------- */

// Loads existing rows once, validates in memory, writes with a single bulkWrite.
router.post('/bulk', authMiddleware, async (req, res) => {
  try {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ message: 'Records array is required' });
    }

    // bulkWrite skips schema validation, so check status/ids/dates here.
    const allowedStatus = new Set(Attendance.schema.path('punchType').enumValues);
    const errors = [];
    const valid = [];
    for (const r of records) {
      const { user, branch, status, date } = r;
      if (!user || !status || !date) {
        errors.push({ user, message: 'Missing required fields' });
      } else if (
        !mongoose.isValidObjectId(user) ||
        (branch && !mongoose.isValidObjectId(branch)) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !allowedStatus.has(status)
      ) {
        errors.push({ user, message: 'Invalid user, branch, date or status' });
      } else {
        valid.push(r);
      }
    }

    // in/out are separate per direction; other states share one slot per day.
    const bucket = (t) => (t === 'in' || t === 'out' ? t : 'state');
    const keyOf = (u, d, t) => `${u}|${d}|${bucket(t)}`;
    const touched = new Map();
    const ops = [];

    if (valid.length) {
      const dates = valid.map((r) => r.date).sort();
      const existingDocs = await Attendance.find({
        user: { $in: [...new Set(valid.map((r) => String(r.user)))] },
        date: {
          $gte: new Date(`${dates[0]}T00:00:00.000Z`),
          $lte: new Date(`${dates[dates.length - 1]}T23:59:59.999Z`),
        },
        punchType: { $in: ['in', 'out', 'absent', 'present', 'half-day', 'half'] },
      }).lean();

      // Live view of the DB state, updated as we queue ops (so in/out order works in-batch).
      const state = new Map(existingDocs.map((d) => [keyOf(d.user, dayKey(d.date), d.punchType), d]));

      for (const { user, branch, status, date, punchTime } of valid) {
        // Punch-out needs a punch-in the same day, and must be later than it.
        if (status === 'out') {
          const hasIn = state.get(keyOf(user, date, 'in'));
          if (!hasIn) {
            errors.push({ user, message: 'Cannot punch out without a punch in record for this date' });
            continue;
          }
          if (punchTime && new Date(punchTime) <= new Date(hasIn.punchTime || hasIn.createdAt)) {
            errors.push({ user, message: 'Punch out time must be after punch in time' });
            continue;
          }
        }

        const resolvedPunchTime = punchTime ? new Date(punchTime) : undefined;
        const key = keyOf(user, date, status);
        const existing = state.get(key);

        if (existing) {
          const set = {
            punchType: status,
            ...(resolvedPunchTime && { punchTime: resolvedPunchTime }),
            ...(branch && { branch }),
          };
          ops.push({ updateOne: { filter: { _id: existing._id }, update: { $set: set } } });
          Object.assign(existing, set);
          touched.set(key, existing);
        } else {
          const doc = {
            _id: new mongoose.Types.ObjectId(),
            user,
            branch,
            punchType: status,
            date: new Date(date),
            ...(resolvedPunchTime && { punchTime: resolvedPunchTime }),
            lat: 0,
            lng: 0,
            selfieUrl: null,
          };
          ops.push({ insertOne: { document: doc } });
          const stored = { ...doc, createdAt: new Date(), updatedAt: new Date() };
          state.set(key, stored);
          touched.set(key, stored);
        }
      }

      if (ops.length) await Attendance.bulkWrite(ops, { ordered: false });
      memo.clear();
    }

    const results = [...touched.values()];
    if (errors.length > 0) {
      return res.status(207).json({ message: 'Partial success', results, errors });
    }
    res.status(201).json({ message: 'Attendance marked successfully', results });
  } catch (err) {
    console.error('Bulk attendance error:', err);
    res.status(500).json({ message: 'Failed to mark attendance', error: err.message });
  }
});

// GET: attendance by branch and date (Labour Management)
router.get('/by-date', authMiddleware, async (req, res) => {
  try {
    const { branch, date } = req.query;

    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ message: 'Date (YYYY-MM-DD) is required' });
    }

    // Full-day UTC range so records stored at any time of the day match.
    const query = {
      date: {
        $gte: new Date(`${date}T00:00:00.000Z`),
        $lte: new Date(`${date}T23:59:59.999Z`),
      },
    };
    if (branch) query.branch = branch;

    const attendance = await Attendance.find(query)
      .populate('user', 'name username mobileNumber jobTitle role')
      .lean();

    res.json(attendance);
  } catch (err) {
    console.error('Fetch attendance by date error:', err);
    res.status(500).json({ message: 'Failed to fetch attendance', error: err.message });
  }
});

/* -------------------------------------------------------------------------- */
/* Notes                                                                      */
/* -------------------------------------------------------------------------- */

router.get('/notes/:userId/:date', authMiddleware, async (req, res) => {
  try {
    const { userId, date } = req.params;
    const note = await AttendanceNote.findOne({ userId, date }).lean();
    res.json(note || { note: '' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to fetch note' });
  }
});

router.post('/notes/:userId/:date', authMiddleware, async (req, res) => {
  try {
    const { userId, date } = req.params;
    const { note } = req.body;

    const updated = await AttendanceNote.findOneAndUpdate(
      { userId, date },
      { userId, date, note },
      { upsert: true, new: true, lean: true }
    );

    res.json(updated);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Failed to save note' });
  }
});

/* -------------------------------------------------------------------------- */
/* Admin: bulk delete                                                         */
/* -------------------------------------------------------------------------- */

// GET: how many records a date-range delete would affect (confirmation screen)
router.get('/admin/delete-preview', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Only admins can perform this action' });
    }

    const { startDate, endDate } = req.query;
    const range = resolveDeleteRange(startDate, endDate);
    if (range.error) return res.status(400).json({ message: range.error });
    const { rangeStart, rangeEnd } = range;

    const query = { date: { $gte: rangeStart, $lte: rangeEnd } };
    const [count, withSelfies] = await Promise.all([
      Attendance.countDocuments(query),
      Attendance.countDocuments({ ...query, selfieUrl: { $nin: [null, ''] } }),
    ]);

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

// DELETE: bulk-delete attendance records and/or their Cloudinary selfies (admin only).
// Requires the exact confirmation phrase, re-checked here for direct API calls.
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
    if (range.error) return res.status(400).json({ message: range.error });
    const { rangeStart, rangeEnd } = range;

    const query = { date: { $gte: rangeStart, $lte: rangeEnd } };

    // Count first; only load documents when selfies actually need deleting.
    const total = await Attendance.countDocuments(query);
    if (!total) {
      return res.status(404).json({ message: 'No attendance records found in the selected period' });
    }

    let cloudinaryDeleted = 0;
    let cloudinaryFailed = 0;

    if (deleteFromCloudinary) {
      const records = await Attendance.find({ ...query, selfieUrl: { $nin: [null, ''] } })
        .select('selfieUrl')
        .lean();

      // public_id -> record, so a Cloudinary-only delete can null the dangling selfieUrl.
      const publicIdToRecordId = new Map();
      records.forEach((r) => {
        const publicId = extractCloudinaryPublicId(r.selfieUrl);
        if (publicId) publicIdToRecordId.set(publicId, r._id);
      });
      const publicIds = [...publicIdToRecordId.keys()];
      const deletedRecordIds = [];

      // Batches of 100 (Admin API limit), sequential to respect rate limits.
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

      // Records kept in the DB must not point at deleted images.
      if (!deleteFromDatabase && deletedRecordIds.length) {
        await Attendance.updateMany({ _id: { $in: deletedRecordIds } }, { $set: { selfieUrl: null } });
      }
    }

    let deletedCount = 0;
    if (deleteFromDatabase) {
      const deleteResult = await Attendance.deleteMany(query);
      deletedCount = deleteResult.deletedCount;
      memo.clear();
    }

    console.log(
      `Admin ${req.user.email || req.user.id} bulk-deleted attendance for ` +
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