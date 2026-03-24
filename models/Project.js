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
  variation: { type: String, default: 'Standard' }, // e.g., 'Standard', 'Premium', 'Deluxe'
  bedroomCount: { type: Number, default: 2 }, // Number of bedrooms
  bathroomCount: { type: Number, default: 2 }, // Number of bathrooms
  hasLivingRoom: { type: Boolean, default: true },
  hasKitchen: { type: Boolean, default: true },
  hasBalcony: { type: Boolean, default: true },
  rooms: [roomSchema],
  overrideTasks: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Task' }], // Flat-level task overrides
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

const staircaseSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g., 'Staircase 1', 'Staircase 2'
  type: { type: String }, // e.g., 'Main Staircase', 'Service Staircase'
});

const podiumSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g., 'P1', 'P2', 'P3'
  description: { type: String }, // Optional description
});

const commonAreaSchema = new mongoose.Schema({
  name: { type: String, required: true }, // e.g., 'CA1', 'CA2', 'CA3'
  description: { type: String }, // e.g., 'Gym', 'Pool', 'Clubhouse'
});

const buildingSchema = new mongoose.Schema({
  name: { type: String, required: true },
  staircases: [staircaseSchema], // Array of staircases in this building
  podiums: [podiumSchema], // Array of podiums in this building
  commonAreas: [commonAreaSchema], // Array of common areas in this building
  wings: [wingSchema],
});

const projectSchema = new mongoose.Schema({
  name: { type: String, required: true },
  address: String,
  branches: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Branch' }],
  buildings: [buildingSchema], // Backward compatible - existing structure
}, { timestamps: true });

export default mongoose.model('Project', projectSchema);
