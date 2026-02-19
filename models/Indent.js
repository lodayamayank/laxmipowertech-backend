import mongoose from "mongoose";

const IndentSchema = new mongoose.Schema(
  {
    indentId: { 
      type: String, 
      unique: true, 
      sparse: true,
      index: true 
    },
    imageUrl: { type: String },
    imagePublicId: { type: String },
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" },
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    items: [
      {
        name: { type: String, required: true },
        category: { type: String },
        subCategory: { type: String },
        subCategory1: { type: String },
        subCategory2: { type: String },
        quantity: { type: Number, required: true },
        unit: { type: String, default: "pcs" },
        remarks: { type: String },
        vendor: { type: mongoose.Schema.Types.ObjectId, ref: 'Vendor' }
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
