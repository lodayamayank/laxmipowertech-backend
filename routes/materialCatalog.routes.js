import express from 'express';
import MaterialCatalog from '../models/MaterialCatalog.js';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import XLSX from 'xlsx';
import { fileURLToPath } from 'url';

const router = express.Router();
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Multer storage for Excel
const upload = multer({
  dest: path.join(__dirname, '..', 'tmp_uploads'),
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel'
    ];
    if (allowedTypes.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only Excel files are allowed'));
  }
});

// Upload Excel + save to MongoDB (MATCHES DEMONSTRATED PROJECT)
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ message: 'No file uploaded' });

    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

    const targetPath = path.join(uploadsDir, `${Date.now()}-${file.originalname}`);
    fs.renameSync(file.path, targetPath);

    const workbook = XLSX.readFile(targetPath);
    const allRows = [];

    workbook.SheetNames.forEach(sheetName => {
      const ws = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_json(ws);
      rows.forEach(row => allRows.push({ ...row, sheetName }));
    });
    
    console.log('📊 Excel Upload - Sample row keys:', allRows.length > 0 ? Object.keys(allRows[0]) : 'No data');
    
    // Helper function to get value from multiple possible column names
    const getColumnValue = (row, possibleNames) => {
      for (const name of possibleNames) {
        const value = row[name];
        if (value !== undefined && value !== null && value !== '') {
          return String(value).trim();
        }
      }
      return '';
    };
    
    const catalogDocs = allRows.map((row, index) => {
      // Try multiple column name variations (handles lowercase, uppercase, spaces)
      const srNo = getColumnValue(row, ['SR NO.', 'SR NO', 'srno', 'sr no', 'Sr No', 'Sr no']);
      const productCode = getColumnValue(row, ['Product Code', 'product code', 'productcode', 'ProductCode']);
      const category = getColumnValue(row, ['Category', 'category', 'CATEGORY']);
      const subCategory = getColumnValue(row, ['Sub category', 'sub category', 'subcategory', 'SubCategory', 'Sub Category']);
      const subCategory1 = getColumnValue(row, ['Sub category 1', 'sub category 1', 'subcategory 1', 'SubCategory1', 'Sub Category 1', 'subcategory1']);
      
      // Log first row for debugging
      if (index === 0) {
        console.log('📊 First row mapping:');
        console.log('  srNo:', srNo);
        console.log('  category:', category);
        console.log('  subCategory:', subCategory);
        console.log('  subCategory1:', subCategory1);
      }
      
      return {
        sheetName: row.sheetName,
        rowIndex: srNo || index,
        srNo,
        productCode,
        category,
        subCategory,
        subCategory1,
        photo: '',
        raw: row
      };
    });

    await MaterialCatalog.insertMany(catalogDocs);
    console.log(`✅ Inserted ${catalogDocs.length} new material records`);

    res.status(200).json({ 
      message: 'Excel uploaded successfully', 
      count: catalogDocs.length,
      filename: path.basename(targetPath)
    });
  } catch (err) {
    console.error('Upload error:', err.message);
    res.status(500).json({ 
      success: false,
      message: 'Server error during file upload',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get all materials from catalog
router.get('/', async (req, res) => {
  try {
    const materials = await MaterialCatalog.find().sort({ createdAt: -1 });
    const flattened = materials.map(doc => ({
      sheetName: doc.sheetName,
      ...doc.raw
    }));
    res.status(200).json(flattened);
  } catch (err) {
    console.error('Get materials error:', err.message);
    res.status(500).json({ 
      success: false,
      message: 'Server error fetching materials',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get last uploaded Excel
router.get('/last', async (req, res) => {
  try {
    const uploadsDir = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadsDir)) return res.json({});

    const files = fs.readdirSync(uploadsDir)
      .filter(f => f.endsWith('.xlsx') || f.endsWith('.xls'))
      .sort((a, b) => fs.statSync(path.join(uploadsDir, b)).mtimeMs - fs.statSync(path.join(uploadsDir, a)).mtimeMs);

    if (!files.length) return res.json({});

    const latestFile = path.join(uploadsDir, files[0]);
    const workbook = XLSX.readFile(latestFile);
    const allSheets = {};
    workbook.SheetNames.forEach(sheetName => {
      const ws = workbook.Sheets[sheetName];
      allSheets[sheetName] = XLSX.utils.sheet_to_json(ws);
    });

    res.status(200).json(allSheets);
  } catch (err) {
    console.error('Get last Excel error:', err.message);
    res.status(500).json({ 
      success: false,
      message: 'Failed to fetch last Excel data',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

// Get all materials for dropdown/selection (MATCHES DEMONSTRATED PROJECT)
router.get('/materials', async (req, res) => {
  try {
    const materials = await MaterialCatalog.find().sort({ createdAt: -1 });

    // EXACT LOGIC FROM DEMONSTRATED PROJECT
    const result = materials.map(item => ({
      _id: item._id,
      category: item.category || item.raw["Category"] || "Unnamed Category",
      subCategory: item.subCategory || item.raw["Sub category"] || "—",
      subCategory1: item.subCategory1 || item.raw["Sub category 1"] || "—",
      photo: item.photo || "https://cdn-icons-png.flaticon.com/512/2910/2910768.png",
    }));

    console.log(`✅ Returning ${result.length} materials from /material/catalog/materials`);
    res.status(200).json(result);
  } catch (err) {
    console.error('Get materials error:', err.message);
    res.status(500).json({ 
      success: false,
      message: 'Server error fetching materials',
      error: process.env.NODE_ENV === 'development' ? err.message : undefined
    });
  }
});

export default router;