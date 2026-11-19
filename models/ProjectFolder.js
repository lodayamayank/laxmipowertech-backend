import mongoose from "mongoose";
import {
  auditEntrySchema,
  deleteRequestSchema,
  SAFE_NAME_RE,
} from "./documentCommon.js";
import { ValidationError, getDocumentLimits } from "../config/documentRules.js";

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;

const projectFolderSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 100,
      validate: {
        validator: (v) => SAFE_NAME_RE.test(v) && v !== "." && v !== "..",
        message: "Folder name contains invalid characters",
      },
    },
    // Lowercased copy of `name`, maintained automatically. Used for the
    // case-insensitive duplicate-name index.
    nameLower: { type: String, required: true },

    // null = root folder of the project
    parentFolderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectFolder",
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    deleteRequest: { type: deleteRequestSchema, default: undefined },
    audit: { type: [auditEntrySchema], default: [] },
  },
  { timestamps: true },
);

projectFolderSchema.pre("validate", function () {
  if (this.name) this.nameLower = this.name.normalize("NFC").toLowerCase();
});


projectFolderSchema.pre("save", async function () {
  if (this.isNew || this.isModified("parentFolderId")) {
    await this.constructor.assertValidParent({
      projectId: this.projectId,
      folderId: this.isNew ? null : this._id,
      parentFolderId: this.parentFolderId,
    });
  }
});

projectFolderSchema.statics.assertValidParent = async function ({
  projectId,
  folderId = null,
  parentFolderId,
}) {
  if (parentFolderId === null || parentFolderId === undefined)
    return { depth: 1 };

  if (!OBJECT_ID_RE.test(String(parentFolderId))) {
    throw new ValidationError("Invalid parent folder id");
  }
  if (folderId && String(parentFolderId) === String(folderId)) {
    throw new ValidationError("A folder cannot be its own parent");
  }

  const { maxFolderDepth } = getDocumentLimits();
  const seen = new Set();
  let currentId = parentFolderId;
  let depth = 0;

  while (currentId) {
    const key = String(currentId);
    if (seen.has(key))
      throw new ValidationError(
        "Folder hierarchy is corrupted (loop detected)",
        500,
      );
    seen.add(key);

    const node = await this.findById(currentId)
      .select("projectId parentFolderId isDeleted")
      .lean();
    if (!node || node.isDeleted)
      throw new ValidationError("Parent folder not found", 404);
    if (String(node.projectId) !== String(projectId)) {
      throw new ValidationError(
        "Parent folder does not belong to this project",
      );
    }
    if (folderId && String(node._id) === String(folderId)) {
      throw new ValidationError(
        "A folder cannot be moved into itself or one of its subfolders",
      );
    }

    depth += 1;
    if (depth + 1 > maxFolderDepth) {
      throw new ValidationError(
        `Folders cannot be nested more than ${maxFolderDepth} levels deep`,
      );
    }
    currentId = node.parentFolderId;
  }
  return { depth: depth + 1 };
};


projectFolderSchema.statics.getBreadcrumbs = async function (
  projectId,
  folderId,
) {
  const trail = [];
  const seen = new Set();
  let currentId = folderId;
  const { maxFolderDepth } = getDocumentLimits();

  while (currentId && trail.length <= maxFolderDepth + 1) {
    if (seen.has(String(currentId))) break;
    seen.add(String(currentId));
    const node = await this.findOne({
      _id: currentId,
      projectId,
      isDeleted: false,
    })
      .select("name parentFolderId")
      .lean();
    if (!node) throw new ValidationError("Folder not found", 404);
    trail.unshift({ _id: node._id, name: node.name });
    currentId = node.parentFolderId;
  }
  return trail;
};

// Duplicate folder names are blocked per parent, case-insensitively, among
// active folders only (so a deleted folder's name can be reused).
projectFolderSchema.index(
  { projectId: 1, parentFolderId: 1, nameLower: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    name: "uniq_active_folder_name",
  },
);
// Listing children of a folder.
projectFolderSchema.index(
  { projectId: 1, parentFolderId: 1, isDeleted: 1 },
  { name: "folder_listing" },
);
// Admin queue of pending delete requests (only indexes folders that have one).
projectFolderSchema.index(
  { "deleteRequest.requestedAt": 1 },
  {
    partialFilterExpression: { "deleteRequest.requestedAt": { $exists: true } },
    name: "folder_delete_requests",
  },
);
const ProjectFolder =
  mongoose.models.ProjectFolder ||
  mongoose.model("ProjectFolder", projectFolderSchema);

export default ProjectFolder;