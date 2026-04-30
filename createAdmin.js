import bcrypt from 'bcryptjs';
import dotenv from 'dotenv';
import User from './models/User.js';
import connectDB from './config/db.js';

dotenv.config({ quiet: true });

const createAdmin = async () => {
  try {
    console.log('🔌 Connecting to MongoDB...');
    await connectDB(process.env.MONGO_URI);
    console.log('✅ MongoDB connected successfully\n');

    // Delete existing admin user first
    console.log('🗑️  Deleting any existing admin user...');
    const deleted = await User.deleteMany({ username: 'admin' });
    console.log(`✅ Deleted ${deleted.deletedCount} admin user(s)\n`);

    // Create fresh admin user
    console.log('👤 Creating new admin user...');
    
    // Hash password with bcrypt
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash('admin123', salt);
    console.log('🔐 Password hashed successfully');

    // Create admin with all required fields
    const admin = new User({
      name: 'Admin',
      username: 'admin',
      email: 'admin@laxmipowertech.com',
      password: hashedPassword,
      role: 'admin',
      jobTitle: 'System Administrator',
      mobileNumber: '9999999999',
      personalEmail: 'admin@laxmipowertech.com',
      maritalStatus: 'single',
    });

    await admin.save();
    console.log('✅ Admin user created successfully!\n');

    // Verify the user was created
    const verifyAdmin = await User.findOne({ username: 'admin' });
    console.log('📋 Verified Admin Details:');
    console.log('   Username:', verifyAdmin.username);
    console.log('   Name:', verifyAdmin.name);
    console.log('   Role:', verifyAdmin.role);
    console.log('   Email:', verifyAdmin.email);
    console.log('   ID:', verifyAdmin._id);
    console.log('\n✅ Admin user is ready to use!');
    console.log('\n📌 Login Credentials:');
    console.log('   Username: admin');
    console.log('   Password: admin123\n');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin:', error);
    process.exit(1);
  }
};

createAdmin();
