import express from 'express';
import authMiddleware from '../middleware/authMiddleware.js';
import { generateDraftSlips, reconcileOpenSlips } from '../jobs/payrollScheduler.js';

const router = express.Router();

// POST /api/payroll-jobs/generate — manually trigger draft slip generation
router.post('/generate', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { month, year } = req.body;
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year are required' });
    }

    // Run async — respond immediately so request doesn't time out on large orgs
    generateDraftSlips(parseInt(year), parseInt(month), `manual:${req.user.id}`);

    res.json({ message: `Payroll draft generation started for ${month}/${year}` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to trigger payroll generation', error: err.message });
  }
});

// POST /api/payroll-jobs/reconcile — manually trigger reconciliation
router.post('/reconcile', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { month, year } = req.body;
    if (!month || !year) {
      return res.status(400).json({ message: 'month and year are required' });
    }

    reconcileOpenSlips(parseInt(year), parseInt(month), `manual:${req.user.id}`);

    res.json({ message: `Reconciliation started for ${month}/${year}` });
  } catch (err) {
    res.status(500).json({ message: 'Failed to trigger reconciliation', error: err.message });
  }
});

export default router;
