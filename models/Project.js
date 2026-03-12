import mongoose from 'mongoose';

const roomSchema = new mongoose.Schema({
  name: { type: String, required: true },
  type: { type: String }, // e.g., 'bedroom', 'bathroom', 'kitchen'
});

const flatSchema = new mongoose.Schema({
  name: { type: String, required: true },
  flatNumber: { type: String }, // e.g., 'A101', '101'
  flatType: { type: String }, // e.g., '1BHK', '2BHK', '3BHK'
  area: { type: Number }, // Square feet/meters
  rooms: [roomSchema],
});

const floorSchema = new mongoose.Schema({
  name: { type: String, required: true },
  floorNumber: { type: Number }, // -2, -1, 0, 1, 2, etc.
  isBasement: { type: Boolean, default: false },
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
  branches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
  buildings: [buildingSchema], // Backward compatible - existing structure
}, { timestamps: true });

export default mongoose.model('Project', projectSchema);
