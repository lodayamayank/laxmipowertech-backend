import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 5000;

// Allow all origins for testing
app.use(cors());

app.get('/api/test', (req, res) => {
  res.send('✅ Backend is reachable!');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Test server running on http://0.0.0.0:${PORT}`);
});
