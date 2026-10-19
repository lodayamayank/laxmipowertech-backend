import fs from 'fs';
import multer from 'multer';
import path from 'path';
import crypto from 'node:crypto';

const uploadsRoot = path.resolve('uploads');

export const uploadTo = (category) => {
  if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(category)) {
    throw new Error('Invalid upload category');
  }
  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => {
      try {
        const date = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        const destination = path.join(uploadsRoot, category, ...date.split('-'));
        fs.mkdirSync(destination, { recursive: true });
        cb(null, destination);
      } catch (error) { cb(error); }
    },
    filename: (req, file, cb) => {
      const userId = String(req.user?.id || req.user?._id || 'file').replace(/[^a-zA-Z0-9_-]/g, '') || 'file';
      cb(null, `${userId}_${Date.now()}-${crypto.randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`);
    },
  });
  // Multer calls this on errors too; final/partial files must always be retained.
  storage._removeFile = (_req, _file, cb) => cb(null);
  return multer({ storage, limits: { fileSize: 10 * 1024 * 1024 } });
};

export const fileUrl = (file) => {
  const relative = path.relative(uploadsRoot, path.resolve(file.path));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('File is outside uploads');
  }
  const base = (process.env.PUBLIC_BASE_URL || process.env.BACKEND_URL || process.env.BASE_URL ||
    `http://localhost:${process.env.PORT || 5002}`).trim().replace(/\/+$/, '');
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.search || url.hash) {
    throw new Error('PUBLIC_BASE_URL must be an HTTP(S) server URL');
  }
  return `${base}/uploads/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
};

const upload = uploadTo('attendance-selfies');
export default upload;
