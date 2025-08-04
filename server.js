import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import userRoutes from './routes/user.routes.js';
import attendanceRoutes from './routes/attendance.routes.js';
import authRoutes from './routes/auth.routes.js';
import projectRoutes from './routes/projects.routes.js'
import dotenv from 'dotenv';
import vendorRoutes from './routes/vendor.routes.js';
import branchRoutes from './routes/branch.routes.js';
import mapRoutes from './routes/map.routes.js';
import rolesRoutes from './routes/roles.routes.js';
dotenv.config();
const app = express();

const PORT = process.env.PORT || 5000;

const allowedOrigins = [
   'http://localhost:5173',
  'http://192.168.29.92:5173'
];

app.use(cors({
  origin: true,
  credentials: true
}));


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
// DB Connection
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

// Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Server is running on port ${PORT}`);
});
