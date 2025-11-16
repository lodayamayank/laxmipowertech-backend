// map.routes.js
import express from 'express';
import axios from 'axios';

const router = express.Router(); // ✅ define router!

// Proxy for location search
router.get('/search', async (req, res) => {
  const { q } = req.query;

  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/search', {
      params: { q, format: 'json' },
      headers: { 'User-Agent': 'LaxmiPowertech-App/1.0 (mayank@example.com)' },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Search Proxy Error:', error.message);
    res.status(500).json({ message: 'Nominatim search failed' });
  }
});

// Proxy for reverse geocoding
router.get('/reverse', async (req, res) => {
  const { lat, lon } = req.query;

  try {
    const response = await axios.get('https://nominatim.openstreetmap.org/reverse', {
      params: { lat, lon, format: 'json' },
      headers: { 'User-Agent': 'LaxmiPowertech-App/1.0 (mayank@example.com)' },
    });
    res.json(response.data);
  } catch (error) {
    console.error('Reverse Proxy Error:', error.message);
    res.status(500).json({ message: 'Nominatim reverse failed' });
  }
});

export default router;
