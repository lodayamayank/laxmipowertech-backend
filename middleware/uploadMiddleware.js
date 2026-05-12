import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Create uploads folder if not exists
const uploadPath = 'uploads/';
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath);
}

// Multer 2 storage config — async return style
const storage = multer.diskStorage({
  destination: async (req, file) => 'uploads/',
  filename: async (req, file) => {
    const ext = path.extname(file.originalname);
    return `selfie-${Date.now()}${ext}`;
  },
});

// Accept only image files — Multer 2 async fileFilter
const fileFilter = async (req, file) => {
  if (file.mimetype.startsWith('image/')) return true;
  throw new Error('Only image files are allowed!');
};

const upload = multer({ storage, fileFilter });

export default upload;
