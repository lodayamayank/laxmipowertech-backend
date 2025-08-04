import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  lat: Number,
  lng: Number,
  radius: Number,
}, { timestamps: true });

export default mongoose.model('Project', projectSchema);