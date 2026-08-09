// Helpers for accepting records created by the offline-first mobile client.
//
// The client queues writes in IndexedDB while offline and replays them once it
// reconnects, so two things have to be handled that a normal online request does
// not need:
//
//   1. The record must keep the time it was *captured* on the device, not the
//      time the replay happened to reach us.
//   2. A replay may arrive more than once (retry after a timeout, a second tab,
//      the user hitting sync manually). Every offline action carries a UUID in
//      `clientId`; the second arrival must return the original record instead of
//      creating a duplicate.

// A capturedAt further ahead than this is treated as a broken device clock.
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000; // 5 minutes
// A capturedAt older than this is treated as stale/garbage rather than a punch
// someone genuinely made two weeks ago and never synced.
const MAX_BACKDATE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

/**
 * Resolve the timestamp a record should be stored under.
 *
 * Returns the client-supplied capture time when it is present and plausible,
 * otherwise falls back to now. Never throws — a bad value just means "now".
 *
 * @param {string|number|undefined} raw  value of req.body.capturedAt
 * @returns {{ date: Date, backdated: boolean }}
 */
export function resolveCapturedAt(raw) {
  const now = new Date();
  if (!raw) return { date: now, backdated: false };

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return { date: now, backdated: false };

  const delta = parsed.getTime() - now.getTime();
  if (delta > MAX_CLOCK_SKEW_MS) return { date: now, backdated: false };
  if (-delta > MAX_BACKDATE_MS) return { date: now, backdated: false };

  // Within skew of now — not a real backdate, so don't flag it as one.
  return { date: parsed, backdated: delta < -MAX_CLOCK_SKEW_MS };
}

/**
 * Look up a record already created by this offline action.
 *
 * @param {import('mongoose').Model} Model
 * @param {string|undefined} clientId
 * @returns {Promise<Object|null>} the existing document, or null
 */
export async function findExistingByClientId(Model, clientId) {
  if (!clientId || typeof clientId !== 'string') return null;
  return Model.findOne({ clientId }).exec();
}

/**
 * True when a save failed because clientId collided with an existing record.
 *
 * Two replays racing each other both pass the findExistingByClientId check and
 * then both save; the unique index rejects the loser with E11000, which is a
 * success from the caller's point of view (the record exists).
 */
export function isDuplicateClientIdError(err) {
  return err?.code === 11000 && Object.keys(err?.keyPattern || {}).includes('clientId');
}

/** Normalise a clientId off a request body: a non-empty string, or undefined. */
export function readClientId(body) {
  const raw = body?.clientId;
  if (typeof raw !== 'string') return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 && trimmed.length <= 100 ? trimmed : undefined;
}
