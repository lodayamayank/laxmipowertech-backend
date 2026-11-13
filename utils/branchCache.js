import Branch from "../models/Branch.js";

const TTL_MS = 60_000;

let cache = { at: 0, list: [], map: new Map() };
let inflight = null;

// Returns { list, map } where map is branchId(string) -> branch doc.
// Concurrent callers share one DB fetch.
export const getBranches = async () => {
  if (Date.now() - cache.at < TTL_MS) return cache;
  inflight ??= Branch.find()
    .lean()
    .then((list) => {
      cache = {
        at: Date.now(),
        list,
        map: new Map(list.map((b) => [String(b._id), b])),
      };
      return cache;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
};

// Call this from your branch create/update/delete routes.
export const invalidateBranchCache = () => {
  cache.at = 0;
};
