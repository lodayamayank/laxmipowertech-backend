import express from 'express';
import HolidayCalendar from '../models/HolidayCalendar.js';
import authMiddleware from '../middleware/authMiddleware.js';

const router = express.Router();

async function getSystemHolidaysForYear(year) {
  try {
    const { default: Holidays } = await import('date-holidays');
    const hd = new Holidays('IN');
    return hd.getHolidays(year)
      .filter(h => h.type === 'public')
      .map(h => {
        // date-holidays returns "YYYY-MM-DD HH:MM:SS" local-time strings.
        // Parsing with new Date() on an IST server shifts every date back by
        // 5h30m (e.g. Jan 26 00:00 IST → Jan 25 18:30 UTC). Force UTC midnight.
        const [y, mo, d] = h.date.split(' ')[0].split('-').map(Number);
        return { date: new Date(Date.UTC(y, mo - 1, d)), name: h.name };
      });
  } catch (e) {
    return [];
  }
}

// GET /api/holidays?year=YYYY
// Syncs system holidays into DB on first access, then returns all (active + inactive)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const startOfYear = new Date(Date.UTC(year, 0, 1));
    const endOfYear = new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999));

    // Sync system holidays into DB (upsert — never overwrite isActive flag)
    const systemHolidays = await getSystemHolidaysForYear(year);
    if (systemHolidays.length > 0) {
      const ops = systemHolidays.map(h => ({
        updateOne: {
          filter: { date: h.date },
          update: { $setOnInsert: { date: h.date, name: h.name, source: 'system', isActive: true } },
          upsert: true,
        },
      }));
      await HolidayCalendar.bulkWrite(ops);
    }

    // Return ALL holidays for the year (active + inactive) so admin has full view
    const holidays = await HolidayCalendar.find({
      date: { $gte: startOfYear, $lte: endOfYear },
    }).sort({ date: 1 }).lean();

    res.json(holidays);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch holidays', error: err.message });
  }
});

// POST /api/holidays — add manual holiday (admin only)
router.post('/', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const { date, name } = req.body;
    if (!date || !name) {
      return res.status(400).json({ message: 'date and name are required' });
    }

    const holiday = await HolidayCalendar.create({
      date: new Date(date),
      name,
      source: 'manual',
      isActive: true,
    });
    res.status(201).json(holiday);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ message: 'A holiday already exists for this date' });
    }
    res.status(500).json({ message: 'Failed to create holiday', error: err.message });
  }
});

// DELETE /api/holidays/:id — soft-deactivate any holiday (admin only)
router.delete('/:id', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const holiday = await HolidayCalendar.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: false } },
      { new: true }
    );

    if (!holiday) {
      return res.status(404).json({ message: 'Holiday not found' });
    }

    res.json({ message: 'Holiday deactivated — it will no longer affect salary calculations', holiday });
  } catch (err) {
    res.status(500).json({ message: 'Failed to deactivate holiday', error: err.message });
  }
});

// PATCH /api/holidays/:id/restore — re-activate a deactivated holiday (admin only)
router.patch('/:id/restore', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ message: 'Access denied. Admins only.' });
    }

    const holiday = await HolidayCalendar.findByIdAndUpdate(
      req.params.id,
      { $set: { isActive: true } },
      { new: true }
    );

    if (!holiday) {
      return res.status(404).json({ message: 'Holiday not found' });
    }

    res.json({ message: 'Holiday restored', holiday });
  } catch (err) {
    res.status(500).json({ message: 'Failed to restore holiday', error: err.message });
  }
});

export default router;
