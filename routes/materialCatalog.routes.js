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

// Upload Excel + save to MongoDB
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
    
    const catalogDocs = allRows.map(row => ({
      sheetName: row.sheetName,
      rowIndex: row['SR NO.'] || 0,
      srNo: row['SR NO.'] || '',
      productCode: row['Product Code'] || '',
      category: row['Category'] || '',
      subCategory: row['Sub category'] || '',
      subCategory1: row['Sub category 1'] || '',
      photo: '',
      raw: row
    }));

    await MaterialCatalog.insertMany(catalogDocs);

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
    
    // Format data to match demonstrated project - return with properly named fields
    // IMPORTANT: Check for non-empty strings, not just truthy values
    const result = materials.map(item => {
      const category = (item.category && item.category.trim()) || (item.raw && item.raw["Category"]) || "";
      const subCategory = (item.subCategory && item.subCategory.trim()) || (item.raw && item.raw["Sub category"]) || "";
      const subCategory1 = (item.subCategory1 && item.subCategory1.trim()) || (item.raw && item.raw["Sub category 1"]) || "";
      
      // Debug log for first item to verify transformation
      if (materials.indexOf(item) === 0) {
        console.log('📊 Sample material transformation:');
        console.log('  DB category:', JSON.stringify(item.category));
        console.log('  Raw category:', item.raw ? JSON.stringify(item.raw["Category"]) : 'N/A');
        console.log('  Final category:', JSON.stringify(category));
        console.log('  DB subCategory:', JSON.stringify(item.subCategory));
        console.log('  Raw subCategory:', item.raw ? JSON.stringify(item.raw["Sub category"]) : 'N/A');
        console.log('  Final subCategory:', JSON.stringify(subCategory));
      }
      
      return {
        _id: item._id,
        sheetName: item.sheetName,
        category,
        subCategory,
        subCategory1,
        srNo: (item.srNo && item.srNo.trim()) || (item.raw && item.raw["SR NO."]) || "",
        productCode: (item.productCode && item.productCode.trim()) || (item.raw && item.raw["Product Code"]) || "",
        photo: item.photo || "",
        raw: item.raw // Keep raw data for reference
      };
    });
    
    console.log(`✅ Returning ${result.length} materials from /material/catalog`);
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

// Get all materials for dropdown/selection
router.get('/materials', async (req, res) => {
  try {
    const materials = await MaterialCatalog.find().sort({ createdAt: -1 });

    // IMPORTANT: Check for non-empty strings, not just truthy values
    const result = materials.map(item => {
      const category = (item.category && item.category.trim()) || (item.raw && item.raw["Category"]) || "Unnamed Category";
      const subCategory = (item.subCategory && item.subCategory.trim()) || (item.raw && item.raw["Sub category"]) || "—";
      const subCategory1 = (item.subCategory1 && item.subCategory1.trim()) || (item.raw && item.raw["Sub category 1"]) || "—";
      
      return {
        _id: item._id,
        category,
        subCategory,
        subCategory1,
        photo: item.photo || "https://cdn-icons-png.flaticon.com/512/2910/2910768.png",
      };
    });

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