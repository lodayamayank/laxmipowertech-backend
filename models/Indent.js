import mongoose from "mongoose";

const IndentSchema = new mongoose.Schema(
  {
    project: { type: mongoose.Schema.Types.ObjectId, ref: "Project", required: true },
    branch: { type: mongoose.Schema.Types.ObjectId, ref: "Branch" }, // optional, if linked to branch
    requestedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },

    items: [
      {
        name: { type: String, required: true },
        quantity: { type: Number, required: true },
        unit: { type: String, default: "pcs" }, // kg, pcs, bags, etc.
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
