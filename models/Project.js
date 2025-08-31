import mongoose from 'mongoose';

const projectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  branches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }], // 🔗 link to branches
}, { timestamps: true });

export default mongoose.model('Project', projectSchema);
