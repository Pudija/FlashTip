// src/index.ts - DODAJ webhook handler PRIJE app.listen
import express from 'express';
import dotenv from 'dotenv';
import { pool } from './db';
import { userRouter } from './routes/users';
import { bot } from './bot';  // IMPORTUJ bot

dotenv.config();
const app = express();
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ 
    status: 'OK', 
    message: 'FlashTip Betting Bot Backend 🚀',
    timestamp: new Date().toISOString()
  });
});

// Health check (imaš)
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ status: 'db_error' });
  }
});

// *** NOVI WEBHOOK ENDPOINT ZA TELEGRAM ***
app.post('/bot/:token', (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// User routes
app.use('/users', userRouter);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
