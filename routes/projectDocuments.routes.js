import express from "express";
import crypto from "node:crypto";
import authMiddleware from "../middleware/authMiddleware.js";
import Project from "../models/Project.js";
import ProjectFolder from "../models/ProjectFolder.js";
import ProjectDocument from "../models/ProjectDocument.js";
import {
  DOCUMENT_ALLOWED_ROLES,
  FILE_TYPES,
  getDocumentLimits,
  getPublicUploadConfig,
  sanitizeOriginalName,
  validateUploadRequest,
} from "../config/documentRules.js";
import * as r2 from "../services/r2Storage.js";

// Mounted at /api (see server.js). Auth is applied PER ROUTE through `guard`,
// never with router.use(), because this router sits on the broad /api prefix
// and must not intercept requests meant for other routers.
const router = express.Router();

const ID_RE = /^[a-f0-9]{24}$/i;
const MAX_AUDIT = 200;
const CATEGORIES = ["cad", "spreadsheet", "document", "image", "other"];
const TICKET_TTL_MS = 60 * 60 * 1000; // confirm window after requesting an upload URL

/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}
const fail = (status, message, extra) => new HttpError(status, message, extra);

// Same shape as the rest of the app: { message, error }.
function sendError(res, err, failMessage) {
  if (err instanceof HttpError)
    return res.status(err.status).json({ message: err.message, ...err.extra });
  if (err?.name === "ValidationError" && err.errors) {
    const first = Object.values(err.errors)[0];
    return res
      .status(400)
      .json({ message: first?.message || "Validation failed" });
  }
  if (err?.name === "CastError")
    return res.status(400).json({ message: "Invalid id or value" });
  if (typeof err?.status === "number" && err.status < 500) {
    return res
      .status(err.status)
      .json({ message: err.message, ...(err.code ? { code: err.code } : {}) });
  }
  if (err?.code === 11000)
    return res
      .status(409)
      .json({ message: "A conflicting item already exists" });
  console.error(`${failMessage}:`, err);
  return res.status(500).json({ message: failMessage, error: err?.message });
}

const handle = (failMessage, fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (err) {
    sendError(res, err, failMessage);
  }
};

/* ------------------------------------------------------------------ */
/* Authentication, roles, project access                               */
/* ------------------------------------------------------------------ */

const isAdmin = (user) => user?.role === "admin";

const requireDocumentRole = (req, res, next) => {
  if (DOCUMENT_ALLOWED_ROLES.includes(req.user?.role)) return next();
  return res
    .status(403)
    .json({ message: "You do not have permission to use project documents" });
};
const requireAdmin = (req, res, next) => {
  if (isAdmin(req.user)) return next();
  return res
    .status(403)
    .json({ message: "Only admins can perform this action" });
};

const guard = [authMiddleware, requireDocumentRole];
const adminGuard = [authMiddleware, requireDocumentRole, requireAdmin];

// Admin: any project. Others: only the project assigned on their user record.
async function assertProjectAccess(user, projectId) {
  if (!ID_RE.test(String(projectId))) throw fail(400, 'Invalid project id');

  const project = await Project.findById(projectId).select('branches').lean();

  if (isAdmin(user)) {
    if (!project) throw fail(404, 'Project not found');
    return;
  }

  const assigned = new Set(
    (user.assignedBranches || []).map((b) => String(b?._id || b))
  );

  const hasAccess =
    String(user.project || '') === String(projectId) ||
    (project?.branches || []).some((b) => assigned.has(String(b)));

  // Same 403 for "missing" and "not yours" so IDs can't be probed.
  if (!project || !hasAccess) throw fail(403, 'You do not have access to this project');
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

const str = (v) => (typeof v === "string" ? v : undefined); // req.query values may be arrays/objects
const body = (req) =>
  req.body && typeof req.body === "object" ? req.body : {};
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function parseId(value, label) {
  if (!ID_RE.test(String(value))) throw fail(400, `Invalid ${label} id`);
  return String(value);
}

// null | 'root' | '' | undefined -> null (root); otherwise a valid id string.
function parseNullableId(value, label) {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    value === "root" ||
    value === "null"
  )
    return null;
  return parseId(value, label);
}

function pushAudit(doc, user, action, detail) {
  doc.audit.push({
    action,
    by: user._id,
    at: new Date(),
    ...(detail ? { detail: String(detail).slice(0, 500) } : {}),
  });
  if (doc.audit.length > MAX_AUDIT)
    doc.audit.splice(0, doc.audit.length - MAX_AUDIT);
}

async function saveOr409(doc, conflictMessage) {
  try {
    await doc.save();
  } catch (err) {
    if (err?.code === 11000) throw fail(409, conflictMessage);
    throw err;
  }
}

async function getFolder(projectId, folderId) {
  parseId(folderId, "folder");
  const folder = await ProjectFolder.findOne({
    _id: folderId,
    projectId,
    isDeleted: false,
  });
  if (!folder) throw fail(404, "Folder not found");
  return folder;
}

// Returns null for root, or the folder id after confirming it is an active
// folder of THIS project.
async function resolveFolderParam(projectId, raw) {
  const id = parseNullableId(raw, "folder");
  if (id === null) return null;
  const exists = await ProjectFolder.exists({
    _id: id,
    projectId,
    isDeleted: false,
  });
  if (!exists) throw fail(404, "Folder not found in this project");
  return id;
}

async function loadDocument(user, documentId, projectId) {
  if (!ID_RE.test(String(documentId))) throw fail(400, "Invalid document id");
  const filter = { _id: documentId, isDeleted: false };
  if (projectId) filter.projectId = projectId;
  const doc = await ProjectDocument.findOne(filter);
  if (!doc) throw fail(404, "Document not found");
  try {
    await assertProjectAccess(user, doc.projectId);
  } catch (err) {
    // Do not reveal that a document exists in a project the user cannot access.
    if (err instanceof HttpError && err.status === 403)
      throw fail(404, "Document not found");
    throw err;
  }
  return doc;
}

/* ------------------------------------------------------------------ */
/* DTOs (never expose objectKey / storedName to clients)               */
/* ------------------------------------------------------------------ */

const plain = (d) => (typeof d?.toObject === "function" ? d.toObject() : d);

function folderDto(f, { includeAudit = false } = {}) {
  const o = plain(f);
  return {
    _id: o._id,
    projectId: o.projectId,
    name: o.name,
    parentFolderId: o.parentFolderId ?? null,
    createdBy: o.createdBy,
    updatedBy: o.updatedBy,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    deleteRequest: o.deleteRequest || null,
    ...(includeAudit ? { audit: o.audit } : {}),
  };
}

function documentDto(d, { includeAudit = false } = {}) {
  const o = plain(d);
  return {
    _id: o._id,
    projectId: o.projectId,
    folderId: o.folderId ?? null,
    originalName: o.originalName,
    extension: o.extension,
    fileType: o.fileType,
    mimeType: o.mimeType,
    fileSize: o.fileSize,
    description: o.description || "",
    version: o.version,
    previewable: FILE_TYPES[o.extension]?.preview === "inline",
    uploadedBy: o.uploadedBy,
    updatedBy: o.updatedBy,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    deleteRequest: o.deleteRequest || null,
    ...(includeAudit ? { audit: o.audit } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* Upload tickets: HMAC-signed note of what the server approved        */
/* ------------------------------------------------------------------ */

function ticketKey() {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error("JWT_SECRET is not configured");
  return crypto
    .createHmac("sha256", secret)
    .update("project-document-upload-ticket")
    .digest();
}
const b64 = (buf) => Buffer.from(buf).toString("base64url");

function signTicket(payload) {
  const data = b64(JSON.stringify(payload));
  const sig = b64(
    crypto.createHmac("sha256", ticketKey()).update(data).digest(),
  );
  return `${data}.${sig}`;
}

function verifyTicket(token) {
  const bad = () => fail(400, "Invalid upload ticket");
  if (typeof token !== "string" || token.length > 4000) throw bad();
  const parts = token.split(".");
  if (parts.length !== 2) throw bad();
  const [data, sig] = parts;
  const expected = b64(
    crypto.createHmac("sha256", ticketKey()).update(data).digest(),
  );
  const a = Buffer.from(sig);
  const e = Buffer.from(expected);
  if (a.length !== e.length || !crypto.timingSafeEqual(a, e)) throw bad();
  let payload;
  try {
    payload = JSON.parse(Buffer.from(data, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!payload || payload.v !== 1) throw bad();
  if (Date.now() > payload.exp)
    throw fail(400, "Upload ticket expired. Please upload the file again.");
  return payload;
}

/* ------------------------------------------------------------------ */
/* Storage-aware deletion helpers                                      */
/* ------------------------------------------------------------------ */

// Removes each document's R2 object, then marks it deleted. Progress is
// recorded per batch, so a retry after a partial failure continues cleanly.
async function removeDocuments(user, docs) {
  let removed = 0;
  let failed = 0;
  for (let i = 0; i < docs.length; i += 10) {
    const batch = docs.slice(i, i + 10);
    const results = await Promise.allSettled(
      batch.map((d) => r2.deleteObject(d.objectKey)),
    );
    const okDocs = batch.filter(
      (_, idx) => results[idx].status === "fulfilled",
    );
    failed += batch.length - okDocs.length;
    removed += okDocs.length;
    const now = new Date();
    for (const d of okDocs) {
      await ProjectDocument.updateOne(
        { _id: d._id },
        {
          $set: {
            isDeleted: true,
            deletedAt: now,
            deletedBy: user._id,
            updatedBy: user._id,
          },
          $unset: { deleteRequest: "" },
          $push: {
            audit: {
              $each: [
                {
                  action: "deleted",
                  by: user._id,
                  at: now,
                  detail: `Deleted "${d.originalName}"`,
                },
              ],
              $slice: -MAX_AUDIT,
            },
          },
        },
      );
    }
  }
  if (failed) {
    throw fail(
      502,
      "Some files could not be removed from storage. Please try again.",
      {
        removed,
        failed,
      },
    );
  }
  return removed;
}

// Deletes a folder, every subfolder, and every document inside them.
async function purgeFolderTree(user, folder) {
  const ids = [folder._id];
  let frontier = [folder._id];
  while (frontier.length) {
    const kids = await ProjectFolder.find({
      projectId: folder.projectId,
      parentFolderId: { $in: frontier },
      isDeleted: false,
    })
      .select("_id")
      .lean();
    frontier = kids.map((k) => k._id);
    ids.push(...frontier);
    if (ids.length > 5000)
      throw fail(
        413,
        "This folder tree is too large to delete in one operation",
      );
  }

  const docs = await ProjectDocument.find({
    projectId: folder.projectId,
    folderId: { $in: ids },
    isDeleted: false,
  })
    .select("_id objectKey originalName")
    .lean();

  const deletedDocuments = await removeDocuments(user, docs);

  const now = new Date();
  await ProjectFolder.updateMany(
    { _id: { $in: ids } },
    {
      $set: {
        isDeleted: true,
        deletedAt: now,
        deletedBy: user._id,
        updatedBy: user._id,
      },
      $unset: { deleteRequest: "" },
      $push: {
        audit: {
          $each: [
            {
              action: "deleted",
              by: user._id,
              at: now,
              detail: `Deleted folder "${folder.name}"`,
            },
          ],
          $slice: -MAX_AUDIT,
        },
      },
    },
  );
  return { deletedFolders: ids.length, deletedDocuments };
}

async function countFolderContents(folder) {
  const [folders, documents] = await Promise.all([
    ProjectFolder.countDocuments({
      projectId: folder.projectId,
      parentFolderId: folder._id,
      isDeleted: false,
    }),
    ProjectDocument.countDocuments({
      projectId: folder.projectId,
      folderId: folder._id,
      isDeleted: false,
    }),
  ]);
  return { folders, documents };
}

async function subtreeHeight(projectId, folderId) {
  let height = 1;
  let frontier = [folderId];
  while (frontier.length) {
    const kids = await ProjectFolder.find({
      projectId,
      parentFolderId: { $in: frontier },
      isDeleted: false,
    })
      .select("_id")
      .lean();
    if (!kids.length) break;
    height += 1;
    frontier = kids.map((k) => k._id);
    if (height > 100) break;
  }
  return height;
}

async function requestDelete(item, user, reason, label) {
  if (item.deleteRequest)
    throw fail(409, "A delete request is already pending for this item");
  const cleanReason =
    typeof reason === "string" ? reason.trim().slice(0, 500) : undefined;
  item.deleteRequest = {
    requestedBy: user._id,
    requestedAt: new Date(),
    ...(cleanReason ? { reason: cleanReason } : {}),
  };
  pushAudit(
    item,
    user,
    "delete_requested",
    cleanReason ? `${label}: ${cleanReason}` : label,
  );
  await item.save();
}

async function rejectDelete(item, user, note) {
  if (!item.deleteRequest)
    throw fail(409, "There is no pending delete request for this item");
  item.deleteRequest = undefined;
  item.updatedBy = user._id;
  pushAudit(
    item,
    user,
    "delete_rejected",
    typeof note === "string" ? note.trim().slice(0, 400) : undefined,
  );
  await item.save();
}

/* ================================================================== */
/* GENERAL                                                             */
/* ================================================================== */

// Limits and allowed extensions, so the UI never hardcodes them.
router.get(
  "/documents/config",  
  ...guard,
  handle("Failed to load document settings", async (_req, res) => {
    res.json(getPublicUploadConfig());
  }),
);

router.get(
  "/documents/project-for-branch/:branchId",
  ...guard,
  handle("Failed to find the branch project", async (req, res) => {
    const branchId = parseId(req.params.branchId, "branch");
    if (!isAdmin(req.user)) {
      // assignedBranches may hold ids or populated docs (same as assertProjectAccess)
      const assigned = (req.user.assignedBranches || []).map((b) =>
        String(b?._id || b),
      );
      if (!assigned.includes(branchId)) throw fail(404, "Branch not found");
    }
    const projects = await Project.find({ branches: branchId })
      .select("name")
      .limit(2)
      .lean();
    if (!projects.length)
      throw fail(404, "This branch is not assigned to any project yet");
    // A branch in several projects: prefer the user's own project.
    const own = projects.find((p) => String(p._id) === String(req.user.project));
    const chosen = own || projects[0];
    res.json({
      projectId: chosen._id,
      projectName: chosen.name,
      ambiguous: projects.length > 1 && !own,
    });
  }),
);
// Admin queue: every pending delete request (documents and folders).
router.get(
  "/documents/delete-requests",
  ...adminGuard,
  handle("Failed to load delete requests", async (_req, res) => {
    const [documents, folders] = await Promise.all([
      ProjectDocument.find({
        isDeleted: false,
        "deleteRequest.requestedAt": { $exists: true },
      })
        .sort({ "deleteRequest.requestedAt": 1 })
        .limit(200)
        .populate("projectId", "name")
        .populate("deleteRequest.requestedBy", "name")
        .lean(),
      ProjectFolder.find({
        isDeleted: false,
        "deleteRequest.requestedAt": { $exists: true },
      })
        .sort({ "deleteRequest.requestedAt": 1 })
        .limit(200)
        .populate("projectId", "name")
        .populate("deleteRequest.requestedBy", "name")
        .lean(),
    ]);
    res.json({
      documents: documents.map((d) => documentDto(d)),
      folders: folders.map((f) => folderDto(f)),
    });
  }),
);

router.get(
  "/projects/:projectId/documents/summary",
  ...guard,
  handle("Failed to load summary", async (req, res) => {
    const { projectId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const [docs, totalFolders, project] = await Promise.all([
      ProjectDocument.getProjectSummary(projectId),
      ProjectFolder.countDocuments({ projectId, isDeleted: false }),
      Project.findById(projectId).select("name").lean(),
    ]);
    res.json({ ...docs, totalFolders, projectName: project?.name || "" });
  }),
);

/* ================================================================== */
/* FOLDERS                                                             */
/* ================================================================== */

router.post(
  "/projects/:projectId/folders",
  ...guard,
  handle("Failed to create folder", async (req, res) => {
    const { projectId } = req.params;
    await assertProjectAccess(req.user, projectId);

    const name = (str(body(req).name) || "").trim();
    if (!name) throw fail(400, "Folder name is required");
    const parentFolderId = parseNullableId(
      body(req).parentFolderId,
      "parent folder",
    );

    const folder = new ProjectFolder({
      projectId,
      name,
      parentFolderId,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });
    pushAudit(folder, req.user, "created", `Created "${name}"`);
    await saveOr409(folder, "A folder with this name already exists here");
    res.status(201).json(folderDto(folder));
  }),
);

// ?parentFolderId=<id>  children of that folder
// ?parentFolderId=root  top-level folders only
// (omitted)             every folder in the project (e.g. for a "move to" picker)
router.get(
  "/projects/:projectId/folders",
  ...guard,
  handle("Failed to fetch folders", async (req, res) => {
    const { projectId } = req.params;
    await assertProjectAccess(req.user, projectId);

    const filter = { projectId, isDeleted: false };
    const parent = str(req.query.parentFolderId);
    if (parent !== undefined)
      filter.parentFolderId = parseNullableId(parent, "parent folder");

    const folders = await ProjectFolder.find(filter)
      .sort({ nameLower: 1 })
      .limit(1000)
      .populate("createdBy", "name")
      .lean();
    res.json(folders.map((f) => folderDto(f)));
  }),
);

router.get(
  "/projects/:projectId/folders/:folderId",
  ...guard,
  handle("Failed to fetch folder", async (req, res) => {
    const { projectId, folderId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const folder = await getFolder(projectId, folderId);
    await folder.populate("createdBy", "name");
    if (isAdmin(req.user)) await folder.populate("audit.by", "name");

    const result = {
      folder: folderDto(folder, { includeAudit: isAdmin(req.user) }),
      breadcrumbs: await ProjectFolder.getBreadcrumbs(projectId, folder._id),
    };

    if (str(req.query.includeChildren) === "true") {
      const [childFolders, documents] = await Promise.all([
        ProjectFolder.find({
          projectId,
          parentFolderId: folder._id,
          isDeleted: false,
        })
          .sort({ nameLower: 1 })
          .limit(1000)
          .populate("createdBy", "name")
          .lean(),
        ProjectDocument.find({
          projectId,
          folderId: folder._id,
          isDeleted: false,
        })
          .sort({ nameLower: 1 })
          .limit(500)
          .populate("uploadedBy", "name")
          .lean(),
      ]);
      result.childFolders = childFolders.map((f) => folderDto(f));
      result.documents = documents.map((d) => documentDto(d));
    }
    res.json(result);
  }),
);

router.patch(
  "/projects/:projectId/folders/:folderId",
  ...guard,
  handle("Failed to rename folder", async (req, res) => {
    const { projectId, folderId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const folder = await getFolder(projectId, folderId);

    const name = (str(body(req).name) || "").trim();
    if (!name) throw fail(400, "Folder name is required");
    const oldName = folder.name;
    if (name === oldName) return res.json(folderDto(folder));

    folder.name = name;
    folder.updatedBy = req.user._id;
    pushAudit(folder, req.user, "renamed", `"${oldName}" -> "${name}"`);
    await saveOr409(folder, "A folder with this name already exists here");
    res.json(folderDto(folder));
  }),
);

router.patch(
  "/projects/:projectId/folders/:folderId/move",
  ...guard,
  handle("Failed to move folder", async (req, res) => {
    const { projectId, folderId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const folder = await getFolder(projectId, folderId);

    const newParent = parseNullableId(
      body(req).parentFolderId,
      "parent folder",
    );
    if (String(folder.parentFolderId || "") === String(newParent || ""))
      return res.json(folderDto(folder));

    // Checks existence, same project, no cycles, and depth of the destination.
    const { depth } = await ProjectFolder.assertValidParent({
      projectId,
      folderId: folder._id,
      parentFolderId: newParent,
    });
    const height = await subtreeHeight(projectId, folder._id);
    const { maxFolderDepth } = getDocumentLimits();
    if (depth + height - 1 > maxFolderDepth) {
      throw fail(
        400,
        `Folders cannot be nested more than ${maxFolderDepth} levels deep`,
      );
    }

    const fromParent = folder.parentFolderId;
    folder.parentFolderId = newParent;
    folder.updatedBy = req.user._id;
    pushAudit(
      folder,
      req.user,
      "moved",
      `From ${fromParent || "root"} to ${newParent || "root"}`,
    );
    await saveOr409(
      folder,
      "A folder with this name already exists in the destination",
    );
    res.json(folderDto(folder));
  }),
);

// Admin: deletes directly. Empty folders go immediately; folders with contents
// need ?cascade=true (the response to the first attempt says how much is inside).
// Non-admin: files a delete request for an admin to review.
router.delete(
  "/projects/:projectId/folders/:folderId",
  ...guard,
  handle("Failed to delete folder", async (req, res) => {
    const { projectId, folderId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const folder = await getFolder(projectId, folderId);

    if (!isAdmin(req.user)) {
      await requestDelete(
        folder,
        req.user,
        body(req).reason,
        `Requested deletion of folder "${folder.name}"`,
      );
      return res
        .status(202)
        .json({ message: "Delete request submitted for admin approval" });
    }

    const contents = await countFolderContents(folder);
    const hasContents = contents.folders > 0 || contents.documents > 0;
    if (hasContents && str(req.query.cascade) !== "true") {
      throw fail(
        409,
        "Folder is not empty. Confirm to delete it together with everything inside.",
        {
          requiresCascade: true,
          folders: contents.folders,
          documents: contents.documents,
        },
      );
    }
    const result = await purgeFolderTree(req.user, folder);
    res.json({ message: "Folder deleted", ...result });
  }),
);

router.patch(
  "/projects/:projectId/folders/:folderId/delete-request/approve",
  ...adminGuard,
  handle("Failed to approve delete request", async (req, res) => {
    const { projectId, folderId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const folder = await getFolder(projectId, folderId);
    if (!folder.deleteRequest)
      throw fail(409, "There is no pending delete request for this folder");
    const result = await purgeFolderTree(req.user, folder);
    res.json({
      message: "Delete request approved. Folder deleted.",
      ...result,
    });
  }),
);

router.patch(
  "/projects/:projectId/folders/:folderId/delete-request/reject",
  ...adminGuard,
  handle("Failed to reject delete request", async (req, res) => {
    const { projectId, folderId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const folder = await getFolder(projectId, folderId);
    await rejectDelete(folder, req.user, body(req).note);
    res.json({ message: "Delete request rejected" });
  }),
);

/* ================================================================== */
/* DOCUMENTS: upload                                                   */
/* ================================================================== */

router.post(
  "/projects/:projectId/documents/upload-url",
  ...guard,
  handle("Failed to create upload URL", async (req, res) => {
    const { projectId } = req.params;
    await assertProjectAccess(req.user, projectId);

    const b = body(req);
    const folderId = await resolveFolderParam(projectId, b.folderId);
    // Everything from the browser is untrusted; this validates and normalizes it.
    const file = validateUploadRequest({
      originalName: str(b.originalName),
      mimeType: str(b.mimeType),
      size: b.size,
    });

    const uploadId = crypto.randomUUID();
    const key = r2.buildPendingKey(projectId, uploadId);
    const upload = await r2.createUploadUrl({
      key,
      contentType: file.contentType,
      size: file.size,
    });

    const ticket = signTicket({
      v: 1,
      pid: projectId,
      uid: String(req.user._id),
      uploadId,
      name: file.originalName,
      ext: file.extension,
      mime: file.contentType,
      size: file.size,
      folderId,
      exp: Date.now() + TICKET_TTL_MS,
    });

    res.status(201).json({
      uploadId,
      upload, // { url, method, headers, expiresInSeconds }
      ticket,
      file: {
        originalName: file.originalName,
        extension: file.extension,
        fileType: file.fileType,
        size: file.size,
      },
    });
  }),
);

// Picks "name.pdf", else "name (1).pdf", "name (2).pdf", ...
async function pickAvailableName(projectId, folderId, name) {
  const dot = name.lastIndexOf(".");
  const suffix = dot > 0 ? name.slice(dot) : "";
  const base = (dot > 0 ? name.slice(0, dot) : name).slice(
    0,
    Math.max(1, 255 - suffix.length - 12),
  );
  const candidates = [
    name,
    ...Array.from({ length: 50 }, (_, i) => `${base} (${i + 1})${suffix}`),
  ];
  const norm = (s) => s.normalize("NFC").toLowerCase();
  const taken = await ProjectDocument.find({
    projectId,
    folderId,
    isDeleted: false,
    nameLower: { $in: candidates.map(norm) },
  })
    .select("nameLower")
    .lean();
  const takenSet = new Set(taken.map((t) => t.nameLower));
  return (
    candidates.find((c) => !takenSet.has(norm(c))) ||
    `${base} (${Date.now()})${suffix}`
  );
}

router.post(
  "/projects/:projectId/documents/confirm",
  ...guard,
  handle("Failed to confirm upload", async (req, res) => {
    const { projectId } = req.params;
    await assertProjectAccess(req.user, projectId);

    const t = verifyTicket(body(req).ticket);
    if (t.pid !== String(projectId) || t.uid !== String(req.user._id)) {
      throw fail(403, "This upload ticket does not belong to you");
    }
    const rule = FILE_TYPES[t.ext];
    if (!rule) throw fail(422, "File type is no longer allowed");

    const pendingKey = r2.buildPendingKey(projectId, t.uploadId);
    const finalKey = r2.buildFinalKey(projectId, t.uploadId, t.ext);

    // The folder must still exist (it may have been deleted during the upload).
    const folderId = await resolveFolderParam(projectId, t.folderId);

    // Idempotent: a repeated confirm returns the existing record.
    const existing = await ProjectDocument.findOne({
      objectKey: finalKey,
    }).populate("uploadedBy", "name");
    if (existing) return res.json(documentDto(existing));

    // 1. Verify the uploaded bytes. Bad files are discarded; outages are retryable.
    try {
      await r2.verifyUploadedObject({
        key: pendingKey,
        expectedSize: t.size,
        extension: t.ext,
      });
    } catch (err) {
      if (
        [
          "SIZE_MISMATCH",
          "SIGNATURE_MISMATCH",
          "TOO_LARGE",
          "INVALID_TYPE",
        ].includes(err?.code)
      ) {
        await r2.discardPending(pendingKey);
      }
      throw err;
    }

    // 2. Promote from pending/ to its permanent, downloadable location.
    await r2.copyObject(pendingKey, finalKey);

    // 3. Save the record, auto-renaming on a duplicate name. If the database
    //    save fails, remove the copy so no orphan is left (pending stays, so
    //    the client can retry the confirm).
    const description = (str(body(req).description) || "")
      .trim()
      .slice(0, 1000);
    let doc;
    try {
      for (let attempt = 0; attempt < 5 && !doc; attempt += 1) {
        const name = await pickAvailableName(projectId, folderId, t.name);
        const candidate = new ProjectDocument({
          projectId,
          folderId,
          originalName: name,
          storedName: `${t.uploadId}.${t.ext}`,
          objectKey: finalKey,
          mimeType: t.mime,
          extension: t.ext,
          fileType: CATEGORIES.includes(rule.category)
            ? rule.category
            : "other",
          fileSize: t.size,
          storageProvider: "r2",
          scan: {
            status: "not_scanned",
            scanner: "none",
            scannedAt: new Date(),
          },
          uploadedBy: req.user._id,
          updatedBy: req.user._id,
          ...(description ? { description } : {}),
        });
        pushAudit(
          candidate,
          req.user,
          "uploaded",
          `Uploaded "${name}" (${t.size} bytes)`,
        );
        try {
          await candidate.save();
          doc = candidate;
        } catch (err) {
          if (err?.code !== 11000) throw err;
          if (err.keyPattern && "objectKey" in err.keyPattern) {
            // Concurrent confirm of the same ticket already saved it.
            doc = await ProjectDocument.findOne({ objectKey: finalKey });
            break;
          }
          // Name taken in a race: loop and pick the next free name.
        }
      }
      if (!doc)
        throw fail(
          409,
          "Could not find a free file name. Please rename the file and try again.",
        );
    } catch (err) {
      await r2
        .deleteObject(finalKey)
        .catch((e) =>
          console.error(`Orphan cleanup failed for ${finalKey}:`, e.message),
        );
      throw err;
    }

    await r2.discardPending(pendingKey);
    await doc.populate("uploadedBy", "name");
    res.status(201).json(documentDto(doc));
  }),
);

/* ================================================================== */
/* DOCUMENTS: read                                                     */
/* ================================================================== */

// Scope rules:
//   ?folderId=<id|root>   only that folder
//   no folderId, with q / fileType / extension   whole project (search)
//   no folderId and no filters                   project root
router.get(
  "/projects/:projectId/documents",
  ...guard,
  handle("Failed to fetch documents", async (req, res) => {
    const { projectId } = req.params;
    await assertProjectAccess(req.user, projectId);

    const q = (str(req.query.q) || "").trim().slice(0, 100);
    const fileType = str(req.query.fileType);
    const extension = str(req.query.extension)?.toLowerCase();
    if (fileType && !CATEGORIES.includes(fileType))
      throw fail(400, "Invalid fileType filter");
    if (extension && !/^[a-z0-9]{1,10}$/.test(extension))
      throw fail(400, "Invalid extension filter");

    const filter = { projectId, isDeleted: false };
    const folderParam = str(req.query.folderId);
    if (folderParam !== undefined) {
      filter.folderId = await resolveFolderParam(projectId, folderParam);
    } else if (!q && !fileType && !extension) {
      filter.folderId = null;
    }
    if (q)
      filter.nameLower = {
        $regex: escapeRegex(q.normalize("NFC").toLowerCase()),
      };
    if (fileType) filter.fileType = fileType;
    if (extension) filter.extension = extension;

    const limit = Math.min(
      Math.max(parseInt(str(req.query.limit), 10) || 25, 1),
      100,
    );
    const page = Math.max(parseInt(str(req.query.page), 10) || 1, 1);
    const sortFields = {
      name: "nameLower",
      size: "fileSize",
      type: "extension",
      date: "createdAt",
      createdAt: "createdAt",
    };
    const sortField = sortFields[str(req.query.sortBy)] || "createdAt";
    const sortDir =
      str(req.query.order) === "asc"
        ? 1
        : str(req.query.order) === "desc"
        ? -1
        : sortField === "createdAt"
        ? -1
        : 1;

    const [total, items] = await Promise.all([
      ProjectDocument.countDocuments(filter),
      ProjectDocument.find(filter)
        .sort({ [sortField]: sortDir, _id: 1 })
        .skip((page - 1) * limit)
        .limit(limit)
        .populate("uploadedBy", "name")
        .lean(),
    ]);
    res.json({ items: items.map((d) => documentDto(d)), total, page, limit });
  }),
);

router.get(
  "/projects/:projectId/documents/:documentId",
  ...guard,
  handle("Failed to fetch document", async (req, res) => {
    const { projectId, documentId } = req.params;
    await assertProjectAccess(req.user, projectId);
    const doc = await loadDocument(req.user, documentId, projectId);
    await doc.populate([
      { path: "uploadedBy", select: "name" },
      { path: "updatedBy", select: "name" },
    ]);
    if (isAdmin(req.user)) await doc.populate("audit.by", "name");
    const breadcrumbs = doc.folderId
      ? await ProjectFolder.getBreadcrumbs(projectId, doc.folderId)
      : [];
    res.json({
      document: documentDto(doc, { includeAudit: isAdmin(req.user) }),
      breadcrumbs,
    });
  }),
);

// Short-lived signed link. ?inline=true opens in the browser, only for types
// marked previewable in config/documentRules.js; everything else downloads.
router.get(
  "/documents/:documentId/download-url",
  ...guard,
  handle("Failed to create download URL", async (req, res) => {
    const doc = await loadDocument(req.user, req.params.documentId);
    const previewable = FILE_TYPES[doc.extension]?.preview === "inline";
    const inline = previewable && str(req.query.inline) === "true";
    const contentType =
      doc.extension === "txt" ? "text/plain; charset=utf-8" : doc.mimeType;

    const link = await r2.createDownloadUrl({
      key: doc.objectKey,
      fileName: doc.originalName,
      contentType,
      inline,
    });
    res.json({ ...link, fileName: doc.originalName, inline, previewable });
  }),
);

/* ================================================================== */
/* DOCUMENTS: change                                                   */
/* ================================================================== */

router.patch(
  "/documents/:documentId/move",
  ...guard,
  handle("Failed to move document", async (req, res) => {
    const doc = await loadDocument(req.user, req.params.documentId);
    const target = await resolveFolderParam(doc.projectId, body(req).folderId);
    if (String(doc.folderId || "") === String(target || ""))
      return res.json(documentDto(doc));

    const from = doc.folderId;
    doc.folderId = target;
    doc.updatedBy = req.user._id;
    pushAudit(
      doc,
      req.user,
      "moved",
      `From ${from || "root"} to ${target || "root"}`,
    );
    await saveOr409(
      doc,
      "A file with this name already exists in the destination folder",
    );
    res.json(documentDto(doc));
  }),
);

router.patch(
  "/documents/:documentId/rename",
  ...guard,
  handle("Failed to rename document", async (req, res) => {
    const doc = await loadDocument(req.user, req.params.documentId);

    let name = sanitizeOriginalName(str(body(req).name));
    if (!name) throw fail(400, "File name is required");
    // The extension never changes, so a file cannot be re-labelled as another type.
    if (!name.toLowerCase().endsWith(`.${doc.extension}`))
      name = `${name}.${doc.extension}`;
    if (name.length > 255) throw fail(400, "File name is too long");
    if (name === doc.originalName) return res.json(documentDto(doc));

    const oldName = doc.originalName;
    doc.originalName = name;
    doc.updatedBy = req.user._id;
    pushAudit(doc, req.user, "renamed", `"${oldName}" -> "${name}"`);
    await saveOr409(doc, "A file with this name already exists in this folder");
    res.json(documentDto(doc));
  }),
);

// Admin: deletes immediately (file removed from R2, record kept for audit).
// Non-admin: files a delete request for an admin to review.
router.delete(
  "/documents/:documentId",
  ...guard,
  handle("Failed to delete document", async (req, res) => {
    const doc = await loadDocument(req.user, req.params.documentId);

    if (!isAdmin(req.user)) {
      await requestDelete(
        doc,
        req.user,
        body(req).reason,
        `Requested deletion of "${doc.originalName}"`,
      );
      return res
        .status(202)
        .json({ message: "Delete request submitted for admin approval" });
    }
    await removeDocuments(req.user, [doc]);
    res.json({ message: "Document deleted" });
  }),
);

router.patch(
  "/documents/:documentId/delete-request/approve",
  ...adminGuard,
  handle("Failed to approve delete request", async (req, res) => {
    const doc = await loadDocument(req.user, req.params.documentId);
    if (!doc.deleteRequest)
      throw fail(409, "There is no pending delete request for this document");
    await removeDocuments(req.user, [doc]);
    res.json({ message: "Delete request approved. Document deleted." });
  }),
);

router.patch(
  "/documents/:documentId/delete-request/reject",
  ...adminGuard,
  handle("Failed to reject delete request", async (req, res) => {
    const doc = await loadDocument(req.user, req.params.documentId);
    await rejectDelete(doc, req.user, body(req).note);
    res.json({ message: "Delete request rejected" });
  }),
);

export default router;
