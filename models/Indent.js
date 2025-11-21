import mongoose from "mongoose";

const IndentSchema = new mongoose.Schema(
  {
    indentId: { 
      type: String, 
      unique: true, 
      sparse: true, // Allows null values but enforces uniqueness when present
      index: true 
    },
    imageUrl: { type: String }, // Path to uploaded intent list image
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project" },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },

    items: [
      {
        name: { type: String },
        quantity: { type: Number },
        unit: { type: String, default: "pcs" },
        remarks: { type: String },
      },
    ],

    status: {
      type: String,
      enum: ["pending", "approved", "rejected", "delivered"],
      default: "pending",
    },
    adminRemarks: { type: String },
    approvedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

export default mongoose.model("Indent", IndentSchema);
