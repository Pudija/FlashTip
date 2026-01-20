import { Router } from "express";
import { pool } from "../db";

export const userRouter = Router();

// helper za dohvat usera po telegram_id
userRouter.get("/by-telegram/:telegramId", async (req, res) => {
  const telegramId = BigInt(req.params.telegramId);

  try {
    const result = await pool.query(
      `SELECT id, telegram_id, username, role, status
       FROM betting_bot.users
       WHERE telegram_id = $1`,
      [telegramId.toString()]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// "registracija" usera – pozivat će je Telegram bot kad netko pošalje /start
userRouter.post("/register", async (req, res) => {
  const { telegramId, username } = req.body;

  if (!telegramId) {
    return res.status(400).json({ message: "telegramId is required" });
  }

  try {
    // provjeri postoji li
    const existing = await pool.query(
      `SELECT id, telegram_id, username, role, status
       FROM betting_bot.users
       WHERE telegram_id = $1`,
      [telegramId]
    );

    if (existing.rows.length > 0) {
      return res.json(existing.rows[0]);
    } else {
        console.log('error')
    }

    // kreiraj kao običnog usera, PENDING
    const insert = await pool.query(
      `INSERT INTO betting_bot.users (telegram_id, username, role, status)
       VALUES ($1, $2, 'USER', 'PENDING')
       RETURNING id, telegram_id, username, role, status`,
      [telegramId, username || null]
    );

    const user = insert.rows[0];

    // kreiraj wallet s 0 balansa
    await pool.query(
      `INSERT INTO betting_bot.wallets (user_id, balance, currency)
       VALUES ($1, 0, 'FAKE')`,
      [user.id]
    );

    res.status(201).json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ADMIN: lista pending usera
userRouter.get("/pending", async (_req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, telegram_id, username, role, status
       FROM betting_bot.users
       WHERE status = 'PENDING'
       ORDER BY created_at ASC`
    );
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ADMIN: approve user
userRouter.post("/:id/approve", async (req, res) => {
  const id = Number(req.params.id);

  try {
    const result = await pool.query(
      `UPDATE betting_bot.users
       SET status = 'APPROVED', updated_at = NOW()
       WHERE id = $1
       RETURNING id, telegram_id, username, role, status`,
      [id]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json(result.rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});
