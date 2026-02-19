import mongoose from 'mongoose';

const branchSchema = new mongoose.Schema({
  name: { type: String, required: true },
  lat: { type: Number, required: true },
  lng: { type: Number, required: true },
  radius: { type: Number, default: 100 },address: { type: String },
}, { timestamps: true },);

export default mongoose.model('Branch', branchSchema);