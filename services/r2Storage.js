import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getR2Client, getBucketName } from '../config/cloudflareR2.js';
import { FILE_TYPES, getDocumentLimits } from '../config/documentRules.js';

export class StorageError extends Error {
  constructor(message, { code = 'STORAGE_ERROR', status = 500, cause } = {}) {
    super(message);
    this.name = 'StorageError';
    this.code = code;
    this.status = status;
    if (cause) this.cause = cause;
  }
}

const OBJECT_ID_RE = /^[a-f0-9]{24}$/i;
const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MANAGED_KEY_RE =
  /^(?:pending\/[a-f0-9]{24}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|projects\/[a-f0-9]{24}\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.[a-z0-9]{1,10})$/i;

function isAllowedExtension(extension) {
  return (
    typeof extension === "string" &&
    /^[a-z0-9]{1,10}$/.test(extension) &&
    Object.hasOwn(FILE_TYPES, extension)
  );
}

function assertProjectId(projectId) {
  if (!OBJECT_ID_RE.test(String(projectId))) {
    throw new StorageError('Invalid project id', { code: 'INVALID_KEY', status: 400 });
  }
}

export function buildPendingKey(projectId, uploadId) {
  assertProjectId(projectId);
  if (!UUID_RE.test(String(uploadId))) {
    throw new StorageError('Invalid upload id', { code: 'INVALID_KEY', status: 400 });
  }
  return `pending/${projectId}/${uploadId}`;
}

export function buildFinalKey(projectId, storedId, extension) {
  assertProjectId(projectId);
  if (!UUID_RE.test(String(storedId)) || !isAllowedExtension(extension)) {
    throw new StorageError("Invalid storage key parts", {
      code: "INVALID_KEY",
      status: 400,
    });
  }
  return `projects/${projectId}/${storedId}.${extension}`;
}

// Validates that the key is a managed R2 object key (pending or verified).
export function assertManagedKey(key) {
  if (typeof key !== 'string' || !MANAGED_KEY_RE.test(key)) {
    throw new StorageError('Invalid object key', { code: 'INVALID_KEY', status: 400 });
  }
  return key;
}



function isNotFound(err) {
  return (
    err?.name === 'NotFound' ||
    err?.name === 'NoSuchKey' ||
    err?.$metadata?.httpStatusCode === 404
  );
}

function wrap(err, message) {
  if (err instanceof StorageError) return err;
  return new StorageError(message, { cause: err });
}

// RFC 6266 / 5987 Content-Disposition with an ASCII fallback.
export function buildContentDisposition(fileName, inline = false) {
  const clean = String(fileName || 'download').replace(/[\r\n"\\]/g, '_');
  const ascii = clean.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/* ------------------------------------------------------------------ */
/* Presigned URLs                                                      */
/* ------------------------------------------------------------------ */

export async function createUploadUrl({ key, contentType, size }) {
  assertManagedKey(key);
  const limits = getDocumentLimits();
  try {
    const params = { Bucket: getBucketName(), Key: key, ContentType: contentType };
    if (limits.signContentLength) params.ContentLength = size;
    const url = await getSignedUrl(getR2Client(), new PutObjectCommand(params), {
      expiresIn: limits.uploadUrlTtlSeconds,
    });
    return {
      url,
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      expiresInSeconds: limits.uploadUrlTtlSeconds,
    };
  } catch (err) {
    throw wrap(err, 'Failed to create upload URL');
  }
}

export async function createDownloadUrl({ key, fileName, contentType, inline = false }) {
  assertManagedKey(key);
  const limits = getDocumentLimits();
  try {
    const url = await getSignedUrl(
      getR2Client(),
      new GetObjectCommand({
        Bucket: getBucketName(),
        Key: key,
        ResponseContentDisposition: buildContentDisposition(fileName, inline),
        ...(contentType ? { ResponseContentType: contentType } : {}),
      }),
      { expiresIn: limits.downloadUrlTtlSeconds }
    );
    return { url, expiresInSeconds: limits.downloadUrlTtlSeconds };
  } catch (err) {
    throw wrap(err, 'Failed to create download URL');
  }
}

/* ------------------------------------------------------------------ */
/* Object operations                                                   */
/* ------------------------------------------------------------------ */

export async function headObject(key) {
  assertManagedKey(key);
  try {
    const res = await getR2Client().send(new HeadObjectCommand({ Bucket: getBucketName(), Key: key }));
    return { size: res.ContentLength, contentType: res.ContentType };
  } catch (err) {
    if (isNotFound(err)) return null;
    throw wrap(err, 'Failed to read object metadata');
  }
}

// Reads only the first `bytes` bytes (ranged GET).
export async function readObjectHead(key, bytes = 4096) {
  assertManagedKey(key);
  try {
    const res = await getR2Client().send(
      new GetObjectCommand({ Bucket: getBucketName(), Key: key, Range: `bytes=0-${bytes - 1}` })
    );
    return Buffer.from(await res.Body.transformToByteArray());
  } catch (err) {
    throw wrap(err, 'Failed to read object content');
  }
}

export async function copyObject(sourceKey, destKey) {
  assertManagedKey(sourceKey);
  assertManagedKey(destKey);
  try {
    const bucket = getBucketName();
    await getR2Client().send(
      new CopyObjectCommand({ Bucket: bucket, Key: destKey, CopySource: `${bucket}/${sourceKey}` })
    );
  } catch (err) {
    throw wrap(err, 'Failed to copy object');
  }
}

// Deleting a missing key succeeds (S3 semantics), so this is safe to retry.
export async function deleteObject(key) {
  assertManagedKey(key);
  try {
    await getR2Client().send(new DeleteObjectCommand({ Bucket: getBucketName(), Key: key }));
  } catch (err) {
    throw wrap(err, 'Failed to delete object');
  }
}

// Deletes every object (pending and verified) belonging to a project.
// Throws if any batch reports an error, so callers can abort the project delete.
export async function deleteProjectObjects(projectId) {
  assertProjectId(projectId);
  let deleted = 0;
  for (const prefix of [`projects/${projectId}/`, `pending/${projectId}/`]) {
    let token;
    do {
      try {
        const list = await getR2Client().send(
          new ListObjectsV2Command({
            Bucket: getBucketName(),
            Prefix: prefix,
            ContinuationToken: token,
            MaxKeys: 1000,
          }),
        );
        const objects = (list.Contents || []).map((o) => ({ Key: o.Key }));
        if (objects.length) {
          const res = await getR2Client().send(
            new DeleteObjectsCommand({ Bucket: getBucketName(), Delete: { Objects: objects, Quiet: true } })
          );
          if (res.Errors?.length) {
            throw new StorageError(`Failed to delete ${res.Errors.length} object(s)`, { code: 'DELETE_FAILED' });
          }
          deleted += objects.length;
        }
       if (list.IsTruncated && !list.NextContinuationToken) {
         throw new StorageError(
           "R2 pagination did not return a continuation token",
           { code: "DELETE_FAILED" },
         ); 
       }

       token = list.IsTruncated ? list.NextContinuationToken : undefined;
      } catch (err) {
        throw wrap(err, 'Failed to delete project files');
      }
    } while (token);
  }
  return deleted;
}

/* ------------------------------------------------------------------ */
/* Content verification                                                */
/* ------------------------------------------------------------------ */

const startsWith = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

const hasNul = (buf) => buf.includes(0);


export function matchesSignature(buf, kind) {
  switch (kind) {
    case 'pdf':
      return buf.subarray(0, 1024).includes('%PDF-');
    case 'png':
      return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpeg':
      return startsWith(buf, [0xff, 0xd8, 0xff]);
    case 'webp':
      return startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8);
    case 'zip':
      return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]);
    case 'ole2':
      return startsWith(buf, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    case 'dwg':
      return /^AC10\d\d/.test(buf.subarray(0, 6).toString('latin1'));
    case 'dxf': {
      if (buf.subarray(0, 18).toString('latin1') === 'AutoCAD Binary DXF') return true;
      return !hasNul(buf) && buf.toString('latin1').includes('SECTION');
    }
    case 'text':
      // Accept UTF-16 BOMs, otherwise require no NUL bytes.
      return startsWith(buf, [0xff, 0xfe]) || startsWith(buf, [0xfe, 0xff]) || !hasNul(buf);
    default:
      return false;
  }
}

// Malware scanning integration point.
export async function scanObject(key, headBytes) {
  return { clean: true, scanner: 'none' };
}


export async function verifyUploadedObject({ key, expectedSize, extension }) {
  if (!isAllowedExtension(extension)) {
    throw new StorageError("File type not allowed", {
      code: "INVALID_TYPE",
      status: 422,
    });
  }

  const rule = FILE_TYPES[extension];

  const head = await headObject(key);
  if (!head) throw new StorageError('Uploaded file was not found in storage', { code: 'NOT_FOUND', status: 404 });

  if (head.size !== expectedSize) {
    throw new StorageError('Uploaded file size does not match the expected size', { code: 'SIZE_MISMATCH', status: 422 });
  }
  if (head.size > getDocumentLimits().maxUploadBytes) {
    throw new StorageError('Uploaded file is too large', { code: 'TOO_LARGE', status: 413 });
  }

  const headBytes = await readObjectHead(key, 4096);
  if (!matchesSignature(headBytes, rule.signature)) {
    throw new StorageError(`File content does not look like a .${extension} file`, { code: 'SIGNATURE_MISMATCH', status: 422 });
  }

  await scanObject(key, headBytes);
  return { size: head.size, contentType: head.contentType };
}


export async function discardPending(key) {
  try {
    await deleteObject(key);
  } catch (err) {
    console.warn(`discardPending failed for ${key}: ${err.message}`);
  }
}
