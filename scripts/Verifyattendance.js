// Read-only checks for the attendance optimization. Run against staging or a copy first.
//   node scripts/verifyAttendance.js --role=labour --month=11 --year=2026
// Needs MONGO_URI (or MONGODB_URI) in the environment / .env.
import "dotenv/config";
import mongoose from "mongoose";
import Attendance from "../models/Attendance.js";
import AttendanceNote from "../models/AttendanceNote.js";
import SupervisorAttendanceCode from "../models/SupervisorAttendanceCode.js";
import User from "../models/User.js";
import Leave from "../models/Leave.js";
import { buildSummary } from "../routes/attendance.routes.js";

const arg = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=")[1] : fallback;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const istKey = (d) =>
  new Date(new Date(d).getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

let failures = 0;
const report = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? "[OK]  " : "[FAIL]"} ${msg}`);
};

/* 1. Indexes ---------------------------------------------------------------- */
const checkIndexes = async () => {
  console.log("\n== Indexes ==");
  const expected = [
    [Attendance, { user: 1, date: 1, punchType: 1 }, {}],
    [Attendance, { user: 1, createdAt: -1 }, {}],
    [Attendance, { branch: 1, date: 1 }, {}],
    [Attendance, { date: 1 }, {}],
    [Attendance, { clientId: 1 }, { unique: true }],
    [AttendanceNote, { userId: 1, date: 1 }, { unique: true }],
    [
      SupervisorAttendanceCode,
      { supervisor: 1, branch: 1, date: 1 },
      { unique: true },
    ],
    [
      SupervisorAttendanceCode,
      { branch: 1, date: 1, code: 1 },
      { unique: true },
    ],
    [SupervisorAttendanceCode, { date: 1 }, { ttl: 172800 }],
    [User, { role: 1, project: 1 }, {}],
    [Leave, { user: 1, status: 1, startDate: 1, endDate: 1 }, {}],
  ];

  const cache = new Map();
  const indexesOf = async (Model) => {
    if (!cache.has(Model))
      cache.set(Model, await Model.collection.indexes().catch(() => []));
    return cache.get(Model);
  };

  for (const [Model, key, opts] of expected) {
    const found = (await indexesOf(Model)).find((i) => sameKey(i.key, key));
    const problems = [];
    if (!found) problems.push("missing");
    else {
      if (opts.unique && !found.unique) problems.push("not unique");
      if (opts.ttl !== undefined && found.expireAfterSeconds !== opts.ttl) {
        problems.push(`TTL is ${found.expireAfterSeconds}`);
      }
    }
    report(
      !problems.length,
      `${Model.modelName} ${JSON.stringify(key)} ${problems.join(", ")}`,
    );
  }

  const stale = (await indexesOf(Attendance)).find((i) =>
    sameKey(i.key, { user: 1, date: 1 }),
  );
  if (stale)
    console.log(
      "[WARN] Old Attendance index user_1_date_1 still exists (safe to drop).",
    );
};

/* 2. Data sanity ------------------------------------------------------------ */
const checkData = async () => {
  console.log("\n== Data sanity ==");
  const dupes = await AttendanceNote.aggregate([
    { $group: { _id: { userId: "$userId", date: "$date" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $limit: 5 },
  ]);
  report(
    !dupes.length,
    `No duplicate (userId, date) notes${
      dupes.length ? ` e.g. ${JSON.stringify(dupes[0]._id)}` : ""
    }`,
  );

  const hasLocationField = Boolean(Attendance.schema.path("location"));
  console.log(
    hasLocationField
      ? "[OK]   Attendance schema defines `location`"
      : "[WARN] Attendance schema has no `location`: /punch geocoding is not being stored",
  );

  const leaveLike = await Attendance.countDocuments({
    punchType: { $in: ["paidleave", "unpaidleave"] },
  });
  const withLeaveId = await Attendance.countDocuments({
    punchType: { $in: ["paidleave", "unpaidleave"] },
    leaveId: { $ne: null },
  });
  console.log(
    `[INFO] paidleave/unpaidleave punches: ${leaveLike} (with leaveId: ${withLeaveId})`,
  );
};

/* 3. /summary: old logic (IST days) vs new aggregation ----------------------- */
const FIELDS = [
  "present",
  "absent",
  "halfDay",
  "weekOff",
  "paidLeave",
  "unpaidLeave",
  "sickLeave",
  "casualLeave",
  "overtime",
];

const legacySummary = async ({
  userQuery,
  startDate,
  endDateExclusive,
  days,
}) => {
  const users = await User.find(userQuery).lean();
  const out = [];
  for (const u of users) {
    const punches = await Attendance.find({
      user: u._id,
      date: { $gte: startDate, $lt: endDateExclusive },
    })
      .populate("leaveId", "type")
      .lean();
    const byDay = {};
    punches.forEach((p) => (byDay[istKey(p.date)] ??= []).push(p));

    const c = Object.fromEntries(FIELDS.map((f) => [f, 0]));
    for (const key of days) {
      const today = byDay[key] || [];
      const leave = today.find((p) =>
        ["leave", "paidleave", "unpaidleave"].includes(p.punchType),
      );
      if (leave) {
        const t =
          leave.leaveId?.type ||
          (leave.punchType === "paidleave" ? "paid" : "unpaid");
        if (t === "paid") c.paidLeave++;
        else if (t === "sick") c.sickLeave++;
        else if (t === "casual") c.casualLeave++;
        else c.unpaidLeave++;
        continue;
      }
      const ins = today
        .filter((p) => p.punchType === "in")
        .map((x) => new Date(x.createdAt).getTime());
      const outs = today
        .filter((p) => p.punchType === "out")
        .map((x) => new Date(x.createdAt).getTime());
      if (!ins.length && !outs.length) {
        c.absent++;
        continue;
      }
      if (ins.length && outs.length) {
        const minutes = Math.round(
          (Math.max(...outs) - Math.min(...ins)) / 60000,
        );
        if (minutes >= 480) c.present++;
        else if (minutes >= 240) c.halfDay++;
        else c.absent++;
        if (minutes > 540) c.overtime++;
      } else c.halfDay++;
    }
    out.push({ name: u.name, employeeId: u.employeeId || "-", ...c });
  }
  return out;
};

const checkSummary = async () => {
  const role = arg("role");
  const now = new Date();
  const month = Number(arg("month", now.getMonth() + 1));
  const year = Number(arg("year", now.getFullYear()));
  console.log(
    `\n== /summary old vs new (role=${role || "all"}, ${year}-${String(
      month,
    ).padStart(2, "0")}) ==`,
  );

  const calStart = new Date(Date.UTC(year, month - 1, 1));
  const calEndExcl = new Date(Date.UTC(year, month, 1));
  const dayCount = Math.round((calEndExcl - calStart) / DAY_MS);
  const params = {
    userQuery: role ? { role: role.toLowerCase() } : {},
    startDate: new Date(calStart.getTime() - IST_OFFSET_MS),
    endDateExclusive: new Date(calEndExcl.getTime() - IST_OFFSET_MS),
    days: Array.from({ length: dayCount }, (_, i) =>
      new Date(calStart.getTime() + i * DAY_MS).toISOString().slice(0, 10),
    ),
  };

  let t = performance.now();
  const legacy = await legacySummary(params);
  const legacyMs = Math.round(performance.now() - t);

  t = performance.now();
  const fresh = await buildSummary(params);
  const freshMs = Math.round(performance.now() - t);

  console.log(
    `[INFO] users: ${legacy.length}   old: ${legacyMs} ms   new: ${freshMs} ms`,
  );

  const sortKey = (r) => `${r.name}|${r.employeeId}`;
  const a = [...legacy].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));
  const b = [...fresh].sort((x, y) => sortKey(x).localeCompare(sortKey(y)));

  let mismatches = 0;
  if (a.length !== b.length) {
    report(false, `Row count differs: old ${a.length}, new ${b.length}`);
    return;
  }
  a.forEach((row, i) => {
    const diff = FIELDS.filter((f) => row[f] !== b[i][f]);
    if (diff.length && mismatches++ < 10) {
      console.log(
        `       ${row.name} (${row.employeeId}): ` +
          diff.map((f) => `${f} ${row[f]} -> ${b[i][f]}`).join(", "),
      );
    }
  });
  report(
    mismatches === 0,
    `Summary results identical (${mismatches} users differ)`,
  );
  if (mismatches) {
    console.log(
      "       Leave-type diffs usually mean paidleave/unpaidleave punches carry a leaveId:",
    );
    console.log(
      "       make sure the aggregation's leaveId uses isType('leave', 'paidleave', 'unpaidleave').",
    );
  }
};

/* Run ----------------------------------------------------------------------- */
const uri = process.env.MONGO_URI || process.env.MONGODB_URI;
if (!uri) {
  console.error("Set MONGO_URI (or MONGODB_URI) first.");
  process.exit(1);
}

await mongoose.connect(uri);
try {
  await checkIndexes();
  await checkData();
  await checkSummary();
} finally {
  await mongoose.disconnect();
}
console.log(
  failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.",
);
process.exit(failures ? 1 : 0);
