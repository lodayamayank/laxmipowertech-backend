import mongoose from "mongoose";
import {
  auditEntrySchema,
  deleteRequestSchema,
  SAFE_NAME_RE,
} from "./documentCommon.js";

const FILE_CATEGORIES = ["cad", "spreadsheet", "document", "image", "other"];

const projectDocumentSchema = new mongoose.Schema(
  {
    projectId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Project",
      required: true,
    },

    // null = directly in the project root
    folderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ProjectFolder",
      default: null,
    },

    // Display name (editable via rename). Never used to build storage keys.
    originalName: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
      validate: {
        validator: (v) => SAFE_NAME_RE.test(v),
        message: "File name contains invalid characters",
      },
    },
    // Lowercased copy of `originalName`; used for search and the duplicate index.
    nameLower: { type: String, required: true },

    // Server-generated: "<uuid>.<ext>". objectKey is the full R2 key.
    storedName: { type: String, required: true },
    objectKey: { type: String, required: true },

    mimeType: { type: String, required: true },
    extension: {
      type: String,
      required: true,
      lowercase: true,
      match: /^[a-z0-9]{1,10}$/,
    },
    fileType: { type: String, enum: FILE_CATEGORIES, required: true },
    fileSize: {
      type: Number,
      required: true,
      min: 1,
      validate: {
        validator: Number.isInteger,
        message: "fileSize must be an integer",
      },
    },

    storageProvider: { type: String, enum: ["r2"], default: "r2" },

    // Result of the confirm-time checks (see services/r2Storage.js scanObject).
    scan: {
      status: {
        type: String,
        enum: ["not_scanned", "clean"],
        default: "not_scanned",
      },
      scanner: String,
      scannedAt: Date,
    },

    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    description: { type: String, trim: true, maxlength: 1000 },
    // Reserved for future file versioning. No versioning logic exists yet.
    version: { type: Number, default: 1, min: 1 },

    // Soft delete: the R2 object is removed, the record is kept for audit.
    isDeleted: { type: Boolean, default: false },
    deletedAt: Date,
    deletedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    deleteRequest: { type: deleteRequestSchema, default: undefined },
    audit: { type: [auditEntrySchema], default: [] },
  },
  { timestamps: true },
);

projectDocumentSchema.pre("validate", function () {
  if (this.originalName)
    this.nameLower = this.originalName.normalize("NFC").toLowerCase();
});

// { totalDocuments, totalSize } for the summary cards (active documents only).
projectDocumentSchema.statics.getProjectSummary = async function (projectId) {
  const [row] = await this.aggregate([
    {
      $match: {
        projectId: new mongoose.Types.ObjectId(String(projectId)),
        isDeleted: false,
      },
    },
    {
      $group: {
        _id: null,
        totalDocuments: { $sum: 1 },
        totalSize: { $sum: "$fileSize" },
      },
    },
  ]);
  return {
    totalDocuments: row?.totalDocuments || 0,
    totalSize: row?.totalSize || 0,
  };
};

// Every R2 object belongs to exactly one record.
projectDocumentSchema.index(
  { objectKey: 1 },
  { unique: true, name: "uniq_object_key" },
);

// Main listing: a folder's documents, newest first.
projectDocumentSchema.index(
  { projectId: 1, folderId: 1, isDeleted: 1, createdAt: -1 },
  { name: "doc_listing" },
);
// File-type filter (category and extension).
projectDocumentSchema.index(
  { projectId: 1, fileType: 1, isDeleted: 1, createdAt: -1 },
  { name: "doc_by_category" },
);
projectDocumentSchema.index(
  { projectId: 1, extension: 1, isDeleted: 1 },
  { name: "doc_by_extension" },
);

// No two active documents with the same name in one folder (case-insensitive).
// The upload service auto-renames ("plan (1).pdf") and retries on conflict.
projectDocumentSchema.index(
  { projectId: 1, folderId: 1, nameLower: 1 },
  {
    unique: true,
    partialFilterExpression: { isDeleted: false },
    name: "uniq_active_doc_name",
  },
);

// Admin queue of pending delete requests.
projectDocumentSchema.index(
  { "deleteRequest.requestedAt": 1 },
  {
    partialFilterExpression: { "deleteRequest.requestedAt": { $exists: true } },
    name: "doc_delete_requests",
  },
);
const ProjectDocument =
  mongoose.models.ProjectDocument ||
  mongoose.model("ProjectDocument", projectDocumentSchema);

export default ProjectDocument;