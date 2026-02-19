import mongoose from 'mongoose';

const vendorSchema = new mongoose.Schema({
  companyName: String,
  contact: String,
  mobile: String,
  office: String,
  email: String,
  gst: String,
  address: String
}, { timestamps: true });

export default mongoose.model('Vendor', vendorSchema);
