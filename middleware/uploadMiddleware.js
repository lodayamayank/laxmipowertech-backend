import multer from 'multer';
import path from 'path';
import fs from 'fs';

// Create uploads folder if not exists
const uploadPath = 'uploads/';
if (!fs.existsSync(uploadPath)) {
  fs.mkdirSync(uploadPath);
}

// Multer storage config
const storage = multer.diskStorage({
  destination(req, file, cb) {
    cb(null, 'uploads/');
  },
  filename(req, file, cb) {
    const ext = path.extname(file.originalname);
    cb(null, `selfie-${Date.now()}${ext}`);
  },
});

// Accept only image files
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith('image/')) cb(null, true);
  else cb(new Error('Only image files are allowed!'), false);
};

const upload = multer({ storage, fileFilter });

export default upload;
