import mongoose from 'mongoose';

const taskSchema = new mongoose.Schema({
  project: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true
  },
  branch: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Branch',
    required: false
  },
  building: {
    id: String,
    name: { type: String, required: true }
  },
  wing: {
    id: String,
    name: { type: String, required: true }
  },
  level3Activity: {
    id: String,
    name: { type: String } // New Level 3: Slab Conduiting, Box Fixing, Wiring, Switch Plate, Testing And Commissioning
  },
  floor: {
    id: String,
    name: { type: String, required: true }
  },
  flat: {
    id: String,
    name: { type: String, required: true }
  },
  room: {
    id: String,
    name: { type: String, required: true }
  },
  supervisor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  photoUrl: {
    type: String,
    required: true
  },
  photoPublicId: {
    type: String
  },
  notes: {
    type: String,
    default: ''
  },
  status: {
    type: String,
    enum: ['pending', 'in-progress', 'completed', 'verified', 'approved', 'rejected'],
    default: 'pending'
  }
}, { timestamps: true });

// Indexes for efficient querying and filtering
taskSchema.index({ project: 1, createdAt: -1 });
taskSchema.index({ supervisor: 1, createdAt: -1 });
taskSchema.index({ 'building.name': 1 });
taskSchema.index({ 'wing.name': 1 });
taskSchema.index({ 'floor.name': 1 });
taskSchema.index({ 'flat.name': 1 });
taskSchema.index({ 'room.name': 1 });

export default mongoose.model('Task', taskSchema);
