  import express from "express";
  import Project from "../models/Project.js";
  import authMiddleware from "../middleware/authMiddleware.js";

  const router = express.Router();

  const BRANCH_FIELDS = "name address";

  // Create a new project
  router.post("/", authMiddleware, async (req, res) => {
    try {
      const { name, address, branches, buildings } = req.body;
      const project = await Project.create({
        name,
        address,
        branches,
        buildings: buildings || [],
      });
      await project.populate("branches", BRANCH_FIELDS);
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
  router.get("/", authMiddleware, async (req, res) => {
    try {
      const { lite, page, limit } = req.query;

      let query = Project.find()
        .sort({ createdAt: -1 })
        .populate("branches", BRANCH_FIELDS)
        .lean();

      if (lite === "true") {
        query = query.select("-buildings");
      }

      if (limit) {
        const l = Math.min(Math.max(parseInt(limit, 10) || 20, 1), 100);
        const p = Math.max(parseInt(page, 10) || 1, 1);
        query = query.skip((p - 1) * l).limit(l);
        res.set("X-Total-Count", String(await Project.estimatedDocumentCount()));
      }

      res.json(await query);
    } catch (err) {
      res
        .status(500)
        .json({ message: "Failed to fetch projects", error: err.message });
    }
  });

  // Update a project
  router.put("/:id", authMiddleware, async (req, res) => {
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
    } catch (err) {
      res
        .status(400)
        .json({ message: "Failed to update project", error: err.message });
    }
  });

  // Get project by ID
  router.get("/:id", authMiddleware, async (req, res) => {
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
    try {
      const project = await Project.findById(req.params.id)
        .select("buildings")
        .lean();
      if (!project) return res.status(404).json({ message: "Project not found" });
      res.json({ buildings: project.buildings || [] });
    } catch (err) {
      res
        .status(500)
        .json({
          message: "Failed to fetch project hierarchy",
          error: err.message,
        });
    }
  });

  // Update project hierarchy
  router.put("/:id/hierarchy", authMiddleware, async (req, res) => {
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
    } catch (err) {
      res
        .status(400)
        .json({
          message: "Failed to update project hierarchy",
          error: err.message,
        });
    }
  });

  // Delete a project
  router.delete("/:id", authMiddleware, async (req, res) => {
    try {
      const project = await Project.findByIdAndDelete(req.params.id)
        .select("_id")
        .lean();
      if (!project) return res.status(404).json({ message: "Project not found" });
      res.json({ message: "Project deleted successfully" });
    } catch (err) {
      res
        .status(500)
        .json({ message: "Failed to delete project", error: err.message });
    }
  });

  export default router;
