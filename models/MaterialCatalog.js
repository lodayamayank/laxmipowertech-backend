import mongoose from 'mongoose';

const materialCatalogSchema = new mongoose.Schema({
  sheetName: { type: String },
  rowIndex: { type: Number },
  srNo: { type: String },
  productCode: { type: String },
  category: { type: String },
  subCategory: { type: String },
  subCategory1: { type: String },
  photo: { type: String },
  raw: { type: mongoose.Schema.Types.Mixed }
}, { timestamps: true });

materialCatalogSchema.index({ category: 1 });
materialCatalogSchema.index({ productCode: 1 });
materialCatalogSchema.index({ createdAt: -1 });
materialCatalogSchema.index({ sheetName: 1 });

export default mongoose.model('MaterialCatalog', materialCatalogSchema);