import mongoose from 'mongoose';

export const AUDIT_ACTIONS = Object.freeze([
  'created',
  'uploaded',
  'renamed',
  'moved',
  'delete_requested',
  'delete_rejected',
  'deleted',
]);

export const auditEntrySchema = new mongoose.Schema(
  {
    action: {
      type: String,
      enum: AUDIT_ACTIONS,
      required: true,
    },
    by: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    at: {
      type: Date,
      default: Date.now,
    },
    detail: {
      type: String,
      maxlength: 500,
    },
  },
  { _id: false }
);

export const deleteRequestSchema = new mongoose.Schema(
  {
    requestedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    requestedAt: {
      type: Date,
      default: Date.now,
    },
    reason: {
      type: String,
      trim: true,
      maxlength: 500,
    },
  },
  { _id: false }
);

export const SAFE_NAME_RE = /^[^\\/\u0000-\u001f\u007f]*$/;

