import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true },
});

const flatSchema = new mongoose.Schema({
  name: { type: String, required: true },
  rooms: [roomSchema],
});

const floorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  flats: [flatSchema],
});

const wingSchema = new mongoose.Schema({
  name: { type: String, required: true },
  floors: [floorSchema],
});

const buildingSchema = new mongoose.Schema({
  name: { type: String, required: true },
  wings: [wingSchema],
});

const projectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  branches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }], // 🔗 link to branches
  buildings: [buildingSchema], // Hierarchical structure for task tracking
}, { timestamps: true });

export default mongoose.model('Project', projectSchema);
