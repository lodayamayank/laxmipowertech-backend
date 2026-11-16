const MB = 1024 * 1024;
const MAX_NAME_LENGTH = 255;

export const DOCUMENT_ALLOWED_ROLES = Object.freeze([
  "admin",
  "staff",
  "supervisor",
  "subcontractor",
]);

export const VALIDATION_ERROR_CODES = Object.freeze({
  GENERIC: "VALIDATION_ERROR",
  FILE_NAME_REQUIRED: "FILE_NAME_REQUIRED",
  FILE_NAME_INVALID: "FILE_NAME_INVALID",
  FILE_NAME_TOO_LONG: "FILE_NAME_TOO_LONG",
  FILE_TYPE_NOT_ALLOWED: "FILE_TYPE_NOT_ALLOWED",
  MIME_MISMATCH: "MIME_MISMATCH",
  FILE_SIZE_INVALID: "FILE_SIZE_INVALID",
  FILE_TOO_LARGE: "FILE_TOO_LARGE",
});

export class ValidationError extends Error {
  constructor(message, status = 400, code = VALIDATION_ERROR_CODES.GENERIC) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
    this.code = code;
  }
}

export class DocumentConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "DocumentConfigError";
    this.status = 500;
    this.code = "DOCUMENT_CONFIG_INVALID";
  }
}

const LIMIT_BOUNDS = Object.freeze({
  DOCUMENT_MAX_SIZE_MB: { min: 1, max: 1024, fallback: 100 },
  DOCUMENT_UPLOAD_URL_TTL: { min: 30, max: 3600, fallback: 600 },
  DOCUMENT_DOWNLOAD_URL_TTL: { min: 30, max: 900, fallback: 300 },
  DOCUMENT_MAX_FOLDER_DEPTH: { min: 1, max: 50, fallback: 10 },
});

function readIntEnv(name) {
  const { min, max, fallback } = LIMIT_BOUNDS[name];
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") return fallback;

  const text = raw.trim();
  const value = Number(text);

  if (
    !/^\d+$/.test(text) ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new DocumentConfigError(
      `${name} must be an integer between ${min} and ${max}`,
    );
  }

  return value;
}

function readBoolEnv(name, fallback) {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === "") return fallback;

  const value = raw.trim().toLowerCase();

  if (value === "true") return true;
  if (value === "false") return false;

  throw new DocumentConfigError(`${name} must be "true" or "false"`);
}

// Read lazily (on each call) so values are correct even though server.js
// loads .env after its imports run.
export function getDocumentLimits() {
  return {
    maxUploadBytes: readIntEnv("DOCUMENT_MAX_SIZE_MB") * MB,
    uploadUrlTtlSeconds: readIntEnv("DOCUMENT_UPLOAD_URL_TTL"),
    downloadUrlTtlSeconds: readIntEnv("DOCUMENT_DOWNLOAD_URL_TTL"),
    maxFolderDepth: readIntEnv("DOCUMENT_MAX_FOLDER_DEPTH"),
    signContentLength: readBoolEnv("R2_SIGN_CONTENT_LENGTH", true),
  };
}

// Optional: call once at startup so a bad .env value fails fast.
export function assertDocumentConfig() {
  getDocumentLimits();
}

const FILE_TYPE_DEFINITIONS = {
  dwg: {
    category: "cad",
    signature: "dwg",
    mimes: [
      "application/acad",
      "application/x-acad",
      "application/autocad_dwg",
      "application/dwg",
      "image/vnd.dwg",
      "image/x-dwg",
      "application/octet-stream",
    ],
  },

  dxf: {
    category: "cad",
    signature: "dxf",
    mimes: [
      "image/vnd.dxf",
      "application/dxf",
      "application/x-dxf",
      "application/octet-stream",
      "text/plain",
    ],
  },

  xls: {
    category: "spreadsheet",
    signature: "ole2",
    mimes: ["application/vnd.ms-excel", "application/octet-stream"],
  },

  xlsx: {
    category: "spreadsheet",
    signature: "zip",
    mimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/octet-stream",
    ],
  },

  csv: {
    category: "spreadsheet",
    signature: "text",
    mimes: [
      "text/csv",
      "application/csv",
      "application/vnd.ms-excel",
      "text/plain",
    ],
  },

  pdf: {
    category: "document",
    signature: "pdf",
    preview: "inline",
    mimes: ["application/pdf"],
  },

  doc: {
    category: "document",
    signature: "ole2",
    mimes: ["application/msword", "application/octet-stream"],
  },

  docx: {
    category: "document",
    signature: "zip",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/octet-stream",
    ],
  },

  txt: {
    category: "document",
    signature: "text",
    preview: "inline",
    mimes: ["text/plain"],
  },

  jpg: {
    category: "image",
    signature: "jpeg",
    preview: "inline",
    mimes: ["image/jpeg"],
  },

  jpeg: {
    category: "image",
    signature: "jpeg",
    preview: "inline",
    mimes: ["image/jpeg"],
  },

  png: {
    category: "image",
    signature: "png",
    preview: "inline",
    mimes: ["image/png"],
  },

  webp: {
    category: "image",
    signature: "webp",
    preview: "inline",
    mimes: ["image/webp"],
  },
};

for (const rule of Object.values(FILE_TYPE_DEFINITIONS)) {
  Object.freeze(rule.mimes);
  Object.freeze(rule);
}

export const FILE_TYPES = Object.freeze(FILE_TYPE_DEFINITIONS);

function getRule(extension) {
  return Object.prototype.hasOwnProperty.call(FILE_TYPES, extension)
    ? FILE_TYPES[extension]
    : null;
}

function cleanName(name) {
  return String(name ?? "")
    .normalize("NFC")
    .replace(/[\\/]+/g, "_")
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "")
    .trim();
}

export function sanitizeOriginalName(name) {
  return cleanName(name).slice(0, MAX_NAME_LENGTH);
}

export function getExtension(name) {
  const str = String(name ?? "");
  const i = str.lastIndexOf(".");

  if (i <= 0 || i === str.length - 1) return "";

  return str.slice(i + 1).toLowerCase();
}

export function validateUploadRequest(input = {}) {
  const { originalName, mimeType, size } = input;
  const E = VALIDATION_ERROR_CODES;

  if (typeof originalName !== "string") {
    throw new ValidationError(
      "File name is required",
      400,
      E.FILE_NAME_REQUIRED,
    );
  }

  const cleanedName = cleanName(originalName);

  if (!cleanedName) {
    throw new ValidationError(
      "File name is required",
      400,
      E.FILE_NAME_REQUIRED,
    );
  }

  if (cleanedName === "." || cleanedName === "..") {
    throw new ValidationError("File name is invalid", 400, E.FILE_NAME_INVALID);
  }

  if (cleanedName.length > MAX_NAME_LENGTH) {
    throw new ValidationError(
      `File name exceeds ${MAX_NAME_LENGTH} characters`,
      400,
      E.FILE_NAME_TOO_LONG,
    );
  }

  const extension = getExtension(cleanedName);
  const rule = extension ? getRule(extension) : null;

  if (!rule) {
    throw new ValidationError(
      `File type ".${extension || "?"}" is not allowed`,
      400,
      E.FILE_TYPE_NOT_ALLOWED,
    );
  }

  const mime = String(mimeType || "")
    .toLowerCase()
    .split(";")[0]
    .trim();

  if (mime && !rule.mimes.includes(mime)) {
    throw new ValidationError(
      `MIME type "${mime}" does not match ".${extension}" files`,
      400,
      E.MIME_MISMATCH,
    );
  }

  const { maxUploadBytes } = getDocumentLimits();
  const bytes = Number(size);

  if (!Number.isSafeInteger(bytes) || bytes <= 0) {
    throw new ValidationError("Invalid file size", 400, E.FILE_SIZE_INVALID);
  }

  if (bytes > maxUploadBytes) {
    throw new ValidationError(
      `File exceeds ${Math.round(maxUploadBytes / MB)} MB limit`,
      413,
      E.FILE_TOO_LARGE,
    );
  }

  return {
    originalName: cleanedName,
    extension,
    fileType: rule.category,
    contentType: rule.mimes[0],
    signature: rule.signature,
    previewable: rule.preview === "inline",
    size: bytes,
  };
}

export function getPublicUploadConfig() {
  return {
    maxUploadBytes: getDocumentLimits().maxUploadBytes,
    allowedExtensions: Object.keys(FILE_TYPES),
  };
}
