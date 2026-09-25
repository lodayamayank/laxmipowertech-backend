import mongoose from 'mongoose';

const supervisorAttendanceCodeSchema = new mongoose.Schema(
  {
    supervisor: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    branch: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Branch',
      required: true,
    },
    date: {
      type: Date,
      required: true,
    },
    code: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

supervisorAttendanceCodeSchema.index(
  { supervisor: 1, branch: 1, date: 1 },
  { unique: true }
);

supervisorAttendanceCodeSchema.index(
  { branch: 1, date: 1, code: 1 },
  { unique: true }
);

export default mongoose.model(
  'SupervisorAttendanceCode',
  supervisorAttendanceCodeSchema
);
