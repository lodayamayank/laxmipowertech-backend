import express from 'express';
import Vendor from '../models/Vendor.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

// GET all vendors
router.get('/', authMiddleware, async (req, res) => {
  try {
    const vendors = await Vendor.find().sort({ createdAt: -1 });
    res.json(vendors);
  } catch (err) {
    res.status(500).json({ message: 'Error fetching vendors' });
  }
});

// POST new vendor
router.post('/', authMiddleware, async (req, res) => {
  try {
    const vendor = new Vendor(req.body);
    await vendor.save();
    res.status(201).json(vendor);
  } catch (err) {
    res.status(400).json({ message: 'Error creating vendor' });
  }
});

// PUT update vendor
router.put('/:id', authMiddleware, async (req, res) => {
  try {
    const vendor = await Vendor.findByIdAndUpdate(req.params.id, req.body, { new: true });
    res.json(vendor);
  } catch (err) {
    res.status(400).json({ message: 'Error updating vendor' });
  }
});

// DELETE vendor
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    await Vendor.findByIdAndDelete(req.params.id);
    res.json({ message: 'Vendor deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Error deleting vendor' });
  }
});

export default router;
