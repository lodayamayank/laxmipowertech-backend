import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoSanitize from 'express-mongo-sanitize';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import userRoutes from './routes/user.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import authRoutes from './routes/auth.routes.js';
import projectRoutes from './routes/projects.routes.js'
import dotenv from 'dotenv';
import vendorRoutes from './routes/vendor.routes.js';
import branchRoutes from './routes/branch.routes.js';
import mapRoutes from './routes/map.routes.js';
import rolesRoutes from './routes/roles.routes.js';
import attendanceNotesRoutes from './routes/attendanceNotes.routes.js';
import leaveRoutes from './routes/leaves.routes.js';
import reimbursementRoutes from './routes/reimbursement.routes.js';
import salaryRoutes from './routes/salary.routes.js';
import salarySlipRoutes from './routes/salarySlip.js';
import indentRoutes from './routes/indent.routes.js';
import taskRoutes from './routes/task.routes.js';

// Material Management Routes
import materialCatalogRoutes from './routes/materialCatalog.routes.js';
import siteTransferRoutes from './routes/siteTransfer.routes.js';
import purchaseOrderRoutes from './routes/purchaseOrder.routes.js';
import upcomingDeliveryRoutes from './routes/upcomingDelivery.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Create upload directories if they don't exist
const uploadDirs = [
  path.join(__dirname, 'uploads'),
  path.join(__dirname, 'uploads/siteTransfers'),
  path.join(__dirname, 'uploads/purchaseOrders'),
  path.join(__dirname, 'uploads/indents'),
  path.join(__dirname, 'uploads/tasks'),
  path.join(__dirname, 'tmp_uploads')
];

uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
});

const app = express();

const PORT = process.env.PORT || 5000;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));
app.use(mongoSanitize());

// Logging middleware
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'https://laxmipowertech-frontend.onrender.com',
  'https://laxmipower-tech.vercel.app'
];

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, Postman, curl)
    if (!origin) {
      return callback(null, true);
    }
    
    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      console.warn(`⚠️  CORS blocked origin: ${origin}`);
      callback(new Error("Not allowed by CORS"));
    }
  },
  credentials: true,
}));

// app.options('*', cors()); // Preflight support


// app.use(cors({
//   origin: true,
//   credentials: true
// }));


// ✅ This line is critical for preflight (OPTIONS) support
app.options('*', cors()); // Handle preflight


// ✅ Important: Express middleware after CORS
// Increase payload limit for large project hierarchies
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('uploads'));

// Routes
app.use('/api/users', userRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/vendors', vendorRoutes);
app.use('/api/branches', branchRoutes);
app.use('/api/map', mapRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/attendanceNotes', attendanceNotesRoutes);
app.use('/api/leaves', leaveRoutes);
app.use('/api/reimbursements', reimbursementRoutes);
app.use('/api/salary', salaryRoutes);
app.use('/api/salary-slips', salarySlipRoutes);
app.use('/api/indents', indentRoutes);
app.use('/api/tasks', taskRoutes);

// Material Management Routes
app.use('/api/material/catalog', materialCatalogRoutes);
app.use('/api/material/site-transfers', siteTransferRoutes);
app.use('/api/material/purchase-orders', purchaseOrderRoutes);
app.use('/api/material/upcoming-deliveries', upcomingDeliveryRoutes);

// Debug logging for route registration
console.log('✅ Material routes mounted:');
console.log('   - /api/material/catalog');
console.log('   - /api/material/site-transfers');
console.log('   - /api/material/purchase-orders');
console.log('   - /api/material/upcoming-deliveries');
console.log('✅ Indent routes mounted at /api/indents');

// DB Connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.then(() => {
  console.log('✅ MongoDB connected successfully');
  
  // Start server only after DB connection
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀 Server is running on port ${PORT}`);
    console.log(`🌐 API: http://localhost:${PORT}/api`);
    console.log(`📡 CORS enabled for: ${allowedOrigins.join(', ')}\n`);
  });
})
.catch((err) => {
  console.error('❌ MongoDB connection error:', err);
  process.exit(1);
});
