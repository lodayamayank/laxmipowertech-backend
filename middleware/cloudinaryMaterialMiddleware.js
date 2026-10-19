// Compatibility names retained for existing material routes; uploads now use disk.
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileUrl } from '../config/multer.js';

const MIME_BY_EXT = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdirSync('tmp-uploads', { recursive: true });
    cb(null, 'tmp-uploads');
  },
  filename: (_req, file, cb) => cb(null, `material-${Date.now()}-${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
});
// No file deletion, including when multer rejects a partially processed upload.
storage._removeFile = (_req, _file, cb) => cb(null);
export const upload = multer({ storage, limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const expected = MIME_BY_EXT[path.extname(file.originalname).toLowerCase()];
    if (expected && expected === file.mimetype) return cb(null, true);
    cb(new Error('Unsupported file type'));
  },
});
export const uploadToCloudinary = async (filePath, folder = 'material-transfer/indents') => {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(folder)) throw new Error('Invalid upload folder');
  const ext = path.extname(filePath).toLowerCase();
  if (!MIME_BY_EXT[ext]) throw new Error('Unsupported file type');
  const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const relPath = path.posix.join(folder, ...date.split('-'), `file_${Date.now()}-${crypto.randomBytes(8).toString('hex')}${ext}`);
  const destination = path.resolve('uploads', relPath);
  await fs.promises.mkdir(path.dirname(destination), { recursive: true });
  // Copy only: the source temp file and the stored file are both retained.
  await fs.promises.copyFile(filePath, destination, fs.constants.COPYFILE_EXCL);
  const stat = await fs.promises.stat(destination);
  const url = fileUrl({ path: destination });
  return { url, secure_url: url, publicId: relPath, public_id: relPath,
    originalName: path.basename(filePath), format: ext.slice(1), bytes: stat.size,
    resource_type: MIME_BY_EXT[ext].startsWith('image/') ? 'image' : 'raw' };
};
export const uploadMultipleToCloudinary = (files, folder) =>
  Promise.all(files.map(file => uploadToCloudinary(file.path, folder)));
// file deletion intentionally disabled
export const deleteFromCloudinary = async () => ({ result: 'skipped' });
export const deleteMultipleFromCloudinary = async () => ({ result: 'skipped' });
