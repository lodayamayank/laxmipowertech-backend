import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import userRoutes from './routes/user.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import authRoutes from './routes/auth.routes.js';
import projectRoutes from './routes/projects.routes.js';
import vendorRoutes from './routes/vendor.routes.js';
import branchRoutes from './routes/branch.routes.js';
import mapRoutes from './routes/map.routes.js';
import rolesRoutes from './routes/roles.routes.js';
import attendanceNotesRoutes from './routes/attendanceNotes.routes.js';
import leaveRoutes from './routes/leaves.routes.js';
import reimbursementRoutes from './routes/reimbursement.routes.js';
import salaryRoutes from './routes/salary.routes.js';
import salarySlipRoutes from './routes/salarySlip.js';
import holidayRoutes from './routes/holiday.routes.js';
import salaryPolicyRoutes from './routes/salaryPolicy.routes.js';
import payrollJobRoutes from './routes/payrollJob.routes.js';
import { startPayrollScheduler } from './jobs/payrollScheduler.js';
import indentRoutes from './routes/indent.routes.js';
import taskRoutes from './routes/task.routes.js';
import workOrderRoutes from './routes/workOrder.routes.js';
import materialCatalogRoutes from './routes/materialCatalog.routes.js';
import siteTransferRoutes from './routes/siteTransfer.routes.js';
import purchaseOrderRoutes from './routes/purchaseOrder.routes.js';
import upcomingDeliveryRoutes from './routes/upcomingDelivery.routes.js';
import reportsRoutes from './routes/reports.routes.js';
import labourRoutes from './routes/labour.routes.js';
import connectDB from './config/db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ quiet: true });

const uploadDirs = [
  path.join(__dirname, 'uploads'),
  path.join(__dirname, 'uploads/siteTransfers'),
  path.join(__dirname, 'uploads/purchaseOrders'),
  path.join(__dirname, 'uploads/indents'),
  path.join(__dirname, 'uploads/tasks'),
  path.join(__dirname, 'tmp_uploads'),
];

for (const dir of uploadDirs) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`Created directory: ${dir}`);
  }
}

// express-mongo-sanitize is incompatible with Express 5 (req.query is a read-only getter).
// Inline replacement: strips keys starting with '$' or containing '.' from body and params.
function sanitizeMongo(obj) {
  if (!obj || typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    if (key.startsWith('$') || key.includes('.')) {
      delete obj[key];
    } else if (typeof obj[key] === 'object') {
      sanitizeMongo(obj[key]);
    }
  }
}

const app = express();
const PORT = process.env.PORT || 5000;
const MONGO_URI = (process.env.MONGO_URI || '').trim();

if (!MONGO_URI) {
  console.error('Missing MONGO_URI. Set it in your environment or in a .env file in the project root.');
  process.exit(1);
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    crossOriginEmbedderPolicy: false,
  })
);
app.use((req, _res, next) => {
  sanitizeMongo(req.body);
  sanitizeMongo(req.params);
  next();
});

if (process.env.NODE_ENV !== 'production') {
  app.use(morgan('dev'));
}

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5173',
  'https://laxmipowertech-frontend.onrender.com',
  'https://laxmipower-tech.vercel.app',
];

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) {
        return callback(null, true);
      }

      if (allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      console.warn(`CORS blocked origin: ${origin}`);
      return callback(new Error('Not allowed by CORS'));
    },
    credentials: true,
  })
);

app.options(/.*/, cors());

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static('uploads'));

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
app.use('/api/holidays', holidayRoutes);
app.use('/api/salary-policy', salaryPolicyRoutes);
app.use('/api/payroll-jobs', payrollJobRoutes);
app.use('/api/indents', indentRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/work-orders', workOrderRoutes);
app.use('/api/material/catalog', materialCatalogRoutes);
app.use('/api/material/site-transfers', siteTransferRoutes);
app.use('/api/material/purchase-orders', purchaseOrderRoutes);
app.use('/api/material/upcoming-deliveries', upcomingDeliveryRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/labour', labourRoutes);

async function start() {
  try {
    await connectDB(MONGO_URI);
    startPayrollScheduler();

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Server is running on port ${PORT}`);
      console.log(`API: http://localhost:${PORT}/api`);
      console.log(`CORS enabled for: ${allowedOrigins.join(', ')}`);
    });
  } catch (error) {
    console.error('MongoDB connection error:', error);
    process.exit(1);
  }
}

start();
