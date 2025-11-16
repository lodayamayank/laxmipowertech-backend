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
  path.join(__dirname, 'tmp_uploads')
];

uploadDirs.forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`✅ Created directory: ${dir}`);
  }
});

const app = express();

const PORT = process.env.PORT || 5001;

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" },
  crossOriginEmbedderPolicy: false
}));
app.use(mongoSanitize()); // Prevent MongoDB injection

// Logging middleware
if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

// CORS Configuration
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'https://laxmipowertech-frontend.onrender.com'
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
app.use(express.json());
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

// Material Management Routes
app.use('/api/material/catalog', materialCatalogRoutes);
app.use('/api/material/site-transfers', siteTransferRoutes);
app.use('/api/material/purchase-orders', purchaseOrderRoutes);
app.use('/api/material/upcoming-deliveries', upcomingDeliveryRoutes);

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
