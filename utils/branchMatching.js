// utils/branchMatching.js

// Normalizes a populated Branch doc OR a raw ObjectId/string into a string id.
export const toBranchId = (branchRef) => {
  if (!branchRef) return null;

  const id = branchRef._id || branchRef;

  return id?.toString() || null;
};

// branches: array of Branch docs (lean)
// assignedBranchRefs: user.assignedBranches — may be populated objects or raw ids
export const findBranchForPunch = (
  lat,
  lng,
  assignedBranchRefs,
  branches
) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const assignedIds = new Set(
    (assignedBranchRefs || [])
      .map(toBranchId)
      .filter(Boolean)
  );

  const assigned = branches.filter((b) =>
    assignedIds.has(b._id.toString())
  );

  for (const b of assigned) {
    const distance = haversineMeters(lat, lng,b.lat, b.lng);

    if (distance <= (b.radius || 500)) {
      return b.name;
    }
  }

  return null;
};

export const findNearestAssignedBranch = (
  lat,
  lng,
  assignedBranchRefs,
  branches
) => {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return null;
  }

  const assignedIds = new Set(
    (assignedBranchRefs || [])
      .map(toBranchId)
      .filter(Boolean)
  );

  const assigned = (branches || []).filter((branch) =>
    assignedIds.has(branch._id.toString())
  );

  let nearestBranch = null;
  let minDistance = Infinity;

  for (const branch of assigned) {
    if (
      !Number.isFinite(Number(branch.lat)) ||
      !Number.isFinite(Number(branch.lng))
    ) {
      continue;
    }

    const radius = Number(branch.radius);
    const allowedRadius =
      Number.isFinite(radius) && radius > 0
        ? radius
        : 500;

    const distance = haversineMeters(
      lat,
      lng,
      Number(branch.lat),
      Number(branch.lng)
    );

    if (distance <= allowedRadius && distance < minDistance) {
      minDistance = distance;
      nearestBranch = branch;
    }
  }

  return nearestBranch;
};

const haversineMeters = (lat1, lng1, lat2, lng2) => {
  const R = 6371000;

  const toRad = (d) => (d * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);

  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLng / 2) ** 2;

  return R * 2 * Math.atan2(
    Math.sqrt(a),
    Math.sqrt(1 - a)
  );
};