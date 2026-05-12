import multer from 'multer';
import path from 'path';
import { fileURLToPath } from 'url';

// Setup __dirname in ES Modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const storage = multer.diskStorage({
  destination: async (req, file) => 'uploads/',
  filename: async (req, file) => {
    const ext = path.extname(file.originalname);
    return Date.now() + '-' + Math.round(Math.random() * 1e9) + ext;
  },
});

const upload = multer({ storage });

export default upload;
