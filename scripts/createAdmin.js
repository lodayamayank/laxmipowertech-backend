import mongoose from 'mongoose';
import dotenv from 'dotenv';
import bcrypt from 'bcryptjs';
import User from '../models/User.js';

dotenv.config();

const createAdminUser = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log('✅ Connected to MongoDB');

    //const hashedPassword = await bcrypt.hash('admin123', 10);

    const user = new User({
      name: 'Admin User',
      username: 'admin',
      password: 'admin123',
      role: 'admin',
    });

    await user.save();
    console.log('✅ Admin user created:', user.username);
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin user:', error.message);
    process.exit(1);
  }
};

createAdminUser();
