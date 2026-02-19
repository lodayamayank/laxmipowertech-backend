import express from 'express';
import User from '../models/User.js';

const router = express.Router();

// Return enum roles from user schema
router.get('/', (req, res) => {
  const roles = User.schema.path('role').enumValues;
  res.json(roles); // e.g., ['staff', 'subcontractor', 'labour']
});

export default router;
