import express from "express";
import Project from "../models/Project.js";
import ProjectFolder from "../models/ProjectFolder.js";
import ProjectDocument from "../models/ProjectDocument.js";
import { deleteProjectObjects } from "../services/r2Storage.js";
import authMiddleware from "../middleware/authMiddleware.js";
import compression from "compression";

const router = express.Router();
router.use(compression());

const BRANCH_FIELDS = "name address";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const listCache = new Map(); // url -> { body, total, exp }
const LIST_TTL = 10_000;
export const invalidateProjectsCache = () => listCache.clear();

const requireAdmin = (req, res, next) => {
  if (req.user?.role !== "admin") {
    return res.status(403).json({
      message: "Only admins can perform this action",
    });
  }

  next();
};

function isValidObjectId(id) {
  return OBJECT_ID_RE.test(String(id));
}
// Create a new project
router.post("/", authMiddleware,requireAdmin, async (req, res) => {
  try {
    const { name, address, branches, buildings } = req.body;
    const project = await Project.create({
      name,
      address,
      branches,
      buildings: buildings || [],
    });
    await project.populate("branches", BRANCH_FIELDS);
    invalidateProjectsCache();
    res.status(201).json(project);
  } catch (err) {
    res
      .status(400)
      .json({ message: "Failed to create project", error: err.message });
  }
});

// Get all projects (always returns a plain array)
//   GET /api/projects              -> full projects, same as before
//   GET /api/projects?lite=true    -> same list without `buildings` (much faster)
//   GET /api/projects?page=1&limit=20 -> optional pagination, total in X-Total-Count header
router.get("/",  authMiddleware, async (req, res) => {
  try {
    const key = req.originalUrl;
    const hit = listCache.get(key);
    if (hit && hit.exp > Date.now()) {
      if (hit.total != null) res.set("X-Total-Count", hit.total);
      return res.json(hit.body);
    }

    const { lite, page, limit } = req.query;

    let query = Project.find()
      .sort({ createdAt: -1 })
      .populate("branches", BRANCH_FIELDS)
      .lean();

    if (lite === "true") {
      query = query.select("-buildings");
    }

    let total = null;
    if (limit) {
      const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
      const p = Math.max(parseInt(page, 10) || 1, 1);
      query = query.skip((p - 1) * l).limit(l);
      total = String(await Project.countDocuments());
      res.set("X-Total-Count", total);
    }

    const body = await query;
    if (listCache.size > 200) listCache.clear();
    listCache.set(key, { body, total, exp: Date.now() + LIST_TTL });
    res.json(body);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch projects", error: err.message });
  }
});
// Update a project
router.put("/:id", authMiddleware, requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid project id" });
  }
  try {
    const { name, address, branches, buildings } = req.body;
    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (address !== undefined) updateData.address = address;
    if (branches !== undefined) updateData.branches = branches;
    if (buildings !== undefined) updateData.buildings = buildings;

    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $set: updateData },
      { new: true, runValidators: true },
    )
      .populate("branches", BRANCH_FIELDS)
      .lean();

    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
    invalidateProjectsCache();
  } catch (err) {
    res
      .status(400)
      .json({ message: "Failed to update project", error: err.message });
  }
});

// Get project by ID
router.get("/:id", authMiddleware, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid project id" });
  }
  try {
    const project = await Project.findById(req.params.id)
      .populate("branches", BRANCH_FIELDS)
      .lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json(project);
  } catch (err) {
    res
      .status(500)
      .json({ message: "Failed to fetch project", error: err.message });
  }
});

// Get project hierarchy
router.get("/:id/hierarchy", authMiddleware, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid project id" });
  }
  try {
    const project = await Project.findById(req.params.id)
      .select("buildings")
      .lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json({ buildings: project.buildings || [] });
  } catch (err) {
    console.error("Failed to fetch project:", err);
    res.status(500).json({
      message: "Failed to fetch project",
      error: "Internal server error",
    });
  }
});

// Update project hierarchy
router.put("/:id/hierarchy", authMiddleware,requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid project id" });
  }
  try {
    const project = await Project.findByIdAndUpdate(
      req.params.id,
      { $set: { buildings: req.body.buildings } },
      { new: true, runValidators: true },
    )
      .select("buildings")
      .lean();
    if (!project) return res.status(404).json({ message: "Project not found" });
    res.json({
      message: "Project hierarchy updated successfully",
      buildings: project.buildings,
    });
    invalidateProjectsCache();
  } catch (err) {
    res.status(400).json({
      message: "Failed to update project hierarchy",
      error: err.message,
    });
  }
});

// Delete a project (admin only).
// Also removes the project's documents: stored files first, then the
// folder/document records, then the project itself. If the stored files
// cannot be removed, the project is NOT deleted, so nothing is orphaned.
router.delete("/:id", authMiddleware,requireAdmin, async (req, res) => {
  if (!isValidObjectId(req.params.id)) {
    return res.status(400).json({ message: "Invalid project id" });
  }
  try {
    const { id } = req.params;
    if (!(await Project.exists({ _id: id }))) {
      return res.status(404).json({ message: "Project not found" });
    }

// Remove both pending uploads and permanent project documents from R2.
try {
  await deleteProjectObjects(id);
} catch (storageErr) {
  console.error("Project file cleanup failed:", storageErr);

  return res.status(502).json({
    message:
      "The project's files could not be removed from storage. The project was not deleted. Please try again.",
    error: "Storage cleanup failed",
  });

}

try {
  await ProjectDocument.deleteMany({ projectId: id });
  await ProjectFolder.deleteMany({ projectId: id });
  await Project.findByIdAndDelete(id);
  invalidateProjectsCache();

  return res.json({ message: "Project deleted successfully" });
  } catch (err) {
    console.error("Project database cleanup failed:", err);

    return res.status(500).json({
      message:
        "Project files were removed from storage, but the project could not be completely deleted from the database. Please contact support.",
      error: "Database cleanup failed",
    });
  }
} catch (err) {
  console.error("Failed to delete project:", err);

  return res.status(500).json({
    message: "Failed to delete project",
    error: "Internal server error",
  });
}
});

export default router;

