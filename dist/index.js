"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
// src/index.ts - DODAJ webhook handler PRIJE app.listen
const express_1 = __importDefault(require("express"));
const dotenv_1 = __importDefault(require("dotenv"));
const db_1 = require("./db");
const users_1 = require("./routes/users");
const bot_1 = require("./bot"); // IMPORTUJ bot
dotenv_1.default.config();
const app = (0, express_1.default)();
app.use(express_1.default.json());
// Health check (imaš)
app.get('/health', async (_req, res) => {
    try {
        await db_1.pool.query('SELECT 1');
        res.json({ status: 'ok' });
    }
    catch (e) {
        res.status(500).json({ status: 'db_error' });
    }
});
// *** NOVI WEBHOOK ENDPOINT ZA TELEGRAM ***
app.post('/bot/:token', (req, res) => {
    bot_1.bot.processUpdate(req.body);
    res.sendStatus(200);
});
// User routes
app.use('/users', users_1.userRouter);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
//# sourceMappingURL=index.js.map