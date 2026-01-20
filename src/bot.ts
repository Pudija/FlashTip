import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import { pool } from "./db";

dotenv.config();


// Global state za admin navigaciju
let adminPendingUsersState: { messageId: number; chatId: number } | null = null;
let tipstersListState: {
  messageId: number;
  chatId: number;
  userId: number;
} | null = null;
let adminCreditsListState = { messageId: 0 as number, chatId: 0 as number }; // null initially
let adminTipsListState: { messageId: number; chatId: number } | null = null;

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN not set");
}

const ADMIN_ID = Number(process.env.ADMIN_TELEGRAM_ID);
if (!ADMIN_ID) {
  console.warn(
    "ADMIN_TELEGRAM_ID not set - admin commands will not work correctly",
  );
}

export const bot = new TelegramBot(token, { polling: false });


// Global state for admin input
let adminCreditInput: {
  userId: number;
  adminId: number;
  action: "ADD" | "REMOVE";
} | null = null;

// Helper: upsert user on /start
async function registerUser(telegramId: number, username?: string | null) {
  const existing = await pool.query(
    `SELECT id, telegram_id, username, role, status, requested_role
     FROM betting_bot.users
     WHERE telegram_id = $1`,
    [telegramId],
  );

  if (existing.rows.length > 0) {
    return existing.rows[0];
  }

  const insert = await pool.query(
    `INSERT INTO betting_bot.users (telegram_id, username, role, status, requested_role)
     VALUES ($1, $2, 'USER', 'PENDING', NULL)
     RETURNING id, telegram_id, username, role, status, requested_role`,
    [telegramId, username || null],
  );

  const user = insert.rows[0];

  await pool.query(
    `INSERT INTO betting_bot.wallets (user_id, balance, currency)
     VALUES ($1, 0, 'FAKE')`,
    [user.id],
  );

  return user;
}

bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const telegramId = msg.from?.id;

  const tgUsername = msg.from?.username ?? null;
  const firstName = msg.from?.first_name ?? "";
  const lastName = msg.from?.last_name ?? "";

  if (!telegramId) return;

  let username: string | null = tgUsername;
  if (!username) {
    const fullName = `${firstName} ${lastName}`.trim();
    username = fullName.length > 0 ? fullName : null;
  }

  const user = await registerUser(telegramId, username);

  // Ako user još nije izabrao role → ponudi izbor
  if (!user.requested_role) {
    await bot.sendMessage(
      chatId,
      "Welcome! Choose which *role* you want to sign up for:",
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              { text: "👥 USER", callback_data: "REQ_ROLE:USER" },
              { text: "🎯 TIPSTER", callback_data: "REQ_ROLE:TIPSTER" },
            ],
          ],
        },
      },
    );
    return;
  }

  // Ako je već izabrao requested_role, pokaži status
  let welcomeText = "";

  if (user.status === "PENDING") {
    welcomeText =
      `⏳ Your request is sent.\n` +
      `Requested role: *${user.requested_role}*\n\n` +
      `Waiting for admin approval.`;
  } else if (user.status === "APPROVED") {
    welcomeText =
      `✅ Welcome ${user.username ?? ""}! Your account has been approved.\n` +
      `Your role: *${user.role}*.\n`;
    if (user.role === "TIPSTER") {
      welcomeText += "🎯 **TIPSTER COMMANDS:**\n";
      welcomeText += '➕ • /newtip "BookingCode;odds;stake" - post tip\n';
      welcomeText += "➕ • /balance - check your balance\n\n";
    } else if (user.role === "USER") {
      welcomeText += "📋 **YOUR COMMANDS:**\n";
      welcomeText += "👥 • /tipsters - list of all tipsters\n";
      welcomeText += "➕ • /balance - check your balance\n";
      welcomeText += "📋 • /help - command list\n\n";
    }
  } else {
    welcomeText = `❌ Your account has been rejected. Contact admin if you think its a mistake.\n\n`;
  }

  if (telegramId === ADMIN_ID) {
    welcomeText += `
🔧 **ADMIN COMMANDS**:
👥 • /pending_users - list of pending users
📊 • /tips - open tips list
💰 • /credits - add credits to users
`;
  }

  await bot.sendMessage(chatId, welcomeText);
});

bot.onText(/balance/, async (msg) => {
  if (!msg.from) return;

  const chatId = msg.chat.id as number;
  const telegramId = msg.from.id;

  // Provjeri usera
  const userRes = await pool.query(
    `
    SELECT u.username, u.role, u.status, w.balance 
    FROM betting_bot.users u 
    LEFT JOIN betting_bot.wallets w ON w.user_id = u.id 
    WHERE u.telegram_id = $1
  `,
    [telegramId],
  );

  if (userRes.rows.length === 0) {
    return bot.sendMessage(
      chatId,
      "❌ You are not registered. Send /start first.",
    );
  }

  const user = userRes.rows[0];

  if (user?.status !== "APPROVED") {
    return bot.sendMessage(
      chatId,
      `⏳ Your account is **${user.status}**. Cannot check balance yet.`,
      { parse_mode: "Markdown" },
    );
  }

  const balanceRaw = user.balance;
  const balance =
    typeof balanceRaw === "number"
      ? balanceRaw
      : parseFloat(balanceRaw as string) || 0;
  const name = user.username ?? `ID ${telegramId}`;

  let message = `*${name}* (${user.role})\n\n💰 **Balance:** ${balance.toFixed(
    2,
  )}`;

  if (user.role === "USER") {
    message += "\n\n👥 *User tip:* Follow tipsters with /tipsters";
  }

  await bot.sendMessage(chatId, message, { parse_mode: "Markdown" });
});

// 🔥 USERS: /tipsters - list sa AUTOMATSKIM AZURIRANJEM
bot.onText(/\/tipsters/, async (msg) => {
  if (!msg.from) return;

  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  const userRes = await pool.query(
    `SELECT id, role, status FROM betting_bot.users WHERE telegram_id = $1`,
    [telegramId],
  );

  if (userRes.rows.length === 0) {
    return bot.sendMessage(chatId, "You're not registered. Send /start first.");
  }

  const user = userRes.rows[0];
  if (user.status !== "APPROVED" || user.role === "TIPSTER") {
    return bot.sendMessage(chatId, "You don't have access to this command.");
  }

  // 🔥 SPAJI state za ovog usera
  tipstersListState = { messageId: 0, chatId, userId: user.id };

  // Generiraj tipsters listu
  await renderTipstersList(chatId, user.id, 0); // message_id će se postaviti
});

// 🔥 HELPER: Renderira tipsters listu (subscribe/unsubscribe + auto-update)
async function renderTipstersList(
  chatId: number,
  userId: number,
  messageId?: number,
) {
  // Dohvati tipstere i subscripcije
  const allTipsters = await pool.query(
    `SELECT id, username
     FROM betting_bot.users
     WHERE role = 'TIPSTER' AND status = 'APPROVED'
     ORDER BY username NULLS LAST, created_at ASC
     LIMIT 20`,
  );

  const userSubscriptions = await pool.query(
    `SELECT ts.tipster_id
     FROM betting_bot.tipster_subscribers ts
     WHERE ts.user_id = $1`,
    [userId],
  );

  const subscribedTipsterIds = new Set(
    userSubscriptions.rows.map((row: any) => row.tipster_id),
  );

  const subscriptionCount = subscribedTipsterIds.size;
  const totalTipsters = allTipsters.rows.length;

  const keyboard: any[][] = [];

  for (const tipster of allTipsters.rows) {
    const username = tipster.username ?? `tipster${tipster.id}`;
    const isSubscribed = subscribedTipsterIds.has(tipster.id);

    const buttonText = isSubscribed ? `✅ ${username}` : `👤 ${username}`;

    const callbackData = isSubscribed
      ? `UNSUBSCRIBE:${tipster.id}`
      : `SUBSCRIBE:${tipster.id}`;

    keyboard.push([
      {
        text: buttonText,
        callback_data: callbackData,
      },
    ]);
  }

  const messageText =
    `🎯 **Active tipsters (${totalTipsters}):**\n\n` +
    `📊 **Your subscriptions: ${subscriptionCount}/${totalTipsters}**\n\n`;

  const message = await bot.sendMessage(chatId, messageText, {
    parse_mode: "Markdown",
    reply_markup: {
      inline_keyboard: keyboard,
    },
  });

  // 🔥 Update state sa novim message_id
  tipstersListState = {
    messageId: message.message_id!,
    chatId,
    userId,
  };
}

// 🔥 ADMIN: /pending_users - list with navigation state
bot.onText(/\/pending_users/, async (msg) => {
  if (msg.from?.id !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "You have no rights for this command.");
  }

  const chatId = msg.chat.id;

  const result = await pool.query(
    `SELECT id, username, telegram_id
     FROM betting_bot.users
     WHERE status = 'PENDING'
     ORDER BY created_at ASC
     LIMIT 20`,
  );

  if (result.rows.length === 0) {
    return bot.sendMessage(chatId, "No users waiting for approval.");
  }

  adminPendingUsersState = { messageId: 0, chatId };

  const keyboard: any[][] = [];
  for (const row of result.rows) {
    const displayName = row.username ?? `ID${row.telegram_id}`;
    keyboard.push([
      { text: displayName, callback_data: `PENDING_SHOW:${row.id}` },
    ]);
  }

  const message = await bot.sendMessage(
    chatId,
    `⏳ **Pending users (${result.rows.length}):**`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    },
  );

  adminPendingUsersState!.messageId = message.message_id!;
});

bot.onText(/pending_tips/, async (msg) => {
  if (msg.from?.id !== ADMIN_ID)
    return bot.sendMessage(msg.chat.id, "No rights.");
  const chatId = msg.chat.id as number;

  const tips = await pool.query(`
    SELECT t.id, t.booking_code, t.odds, u.username as tipster 
    FROM betting_bot.tips t 
    JOIN betting_bot.users u ON u.id = t.tipster_id 
    WHERE t.status = 'OPEN' 
    ORDER BY t.created_at DESC 
    LIMIT 20
  `);

  if (tips.rows.length === 0) return bot.sendMessage(chatId, "No open tips.");

  const keyboard: any[][] = [];
  for (const t of tips.rows) {
    keyboard.push([
      {
        text: `${t.booking_code} (${t.tipster})`,
        callback_data: `TIPSHOW:${t.id}`,
      },
    ]);
  }

  const message = await bot.sendMessage(
    chatId,
    `*OPEN TIPS* (${tips.rows.length})`,
    {
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    },
  );

  adminTipsListState = { messageId: message.message_id!, chatId };
});

bot.onText(/newtip (.+)/, async (msg, match) => {
  if (!msg.from) return;
  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  const userRes = await pool.query(
    "SELECT id, role, status FROM bettingbot.users WHERE telegramid = $1",
    [telegramId]
  );

  if (userRes.rows.length === 0) {
    return bot.sendMessage(chatId, "You are not registered in the system.");
  }

  const user = userRes.rows[0];
  if (user.status !== "APPROVED" || user.role !== "TIPSTER") {
    return bot.sendMessage(chatId, "You do not have permission to publish tips.");
  }

  const payload = match?.[1];
  if (!payload) {
    return bot.sendMessage(
      chatId,
      "Wrong format. Use: newtip BookingCode odds stake"
    );
  }

  const parts = payload.split(" ").map(p => p.trim()).filter(p => p.length > 0);
  if (parts.length !== 3) {
    return bot.sendMessage(
      chatId,
      "Wrong format. You need 3 fields: BookingCode odds stake"
    );
  }

  const [bookingCode, oddsStrRaw, stakeStrRaw] = parts;

  // Validacija: Booking code mora imati točno 7 znakova
  if (bookingCode?.length !== 7) {
    return bot.sendMessage(
      chatId,
      "❌ Booking code must have exactly 7 characters."
    );
  }

  // Validacija: Odds i stake moraju biti validni decimalni brojevi
  const oddsStr = oddsStrRaw?.replace(",", ".");
  const stakeStr = stakeStrRaw?.replace(",", ".");

  const odds = Number(oddsStr);
  const recommendedStake = Number(stakeStr);

  if (!Number.isFinite(odds) || !Number.isFinite(recommendedStake)) {
    return bot.sendMessage(
      chatId,
      "❌ Odds and stake must be valid numbers (decimals allowed, e.g. 2.10, 100.50)"
    );
  }

  if (odds <= 1 || recommendedStake <= 0) {
    return bot.sendMessage(
      chatId,
      "❌ Odds must be > 1 and stake must be > 0."
    );
  }

  // Provjera balansa
  const tipsterWallet = await pool.query(
    "SELECT balance FROM bettingbot.wallets WHERE userid = $1",
    [user.id]
  );

  if (
    !tipsterWallet.rows[0] ||
    Number(tipsterWallet.rows[0].balance) < recommendedStake * odds
  ) {
    return bot.sendMessage(
      chatId,
      "❌ You don't have enough balance to cover recommended stake."
    );
  }

  const insert = await pool.query(
    `INSERT INTO bettingbot.tips (tipsterid, bookingcode, odds, recommendedstake, status)
     VALUES ($1, $2, $3, $4, 'OPEN')
     RETURNING id`,
    [user.id, bookingCode, odds, recommendedStake]
  );

  const tipId = insert.rows[0].id;

  await bot.sendMessage(
    chatId,
    `✅ Tip ${tipId} created!\n📝 Booking: \`${bookingCode}\`\n🎯 Odds: ${odds}\n💰 Recommended stake: ${recommendedStake}`,
    { parse_mode: "Markdown" }
  );

  // Send to subscribers (WHO HAVE ENOUGH BALANCE) - 3-min timeout notification
  const subs = await pool.query(
    `SELECT u.id, u.telegramid, w.balance 
     FROM bettingbot.tipstersubscribers ts 
     JOIN bettingbot.users u ON u.id = ts.userid 
     JOIN bettingbot.wallets w ON w.userid = u.id 
     WHERE ts.tipsterid = $1 AND u.status = 'APPROVED' AND w.balance >= $2`,
    [user.id, recommendedStake]
  );

  const tipText = `🆕 *New tip ${tipId}*\n📝 Booking Code: \`${bookingCode}\`\n🎯 Odds: ${odds}\n💰 Recommendation: ${recommendedStake}\n⏰ Expires in 3 minutes!`;

  for (const row of subs.rows) {
    const subChatId = row.telegramid as number;
    // Send notification immediately (3-min logic handled by frontend or manual close)
    try {
      await bot.sendMessage(
        subChatId,
        tipText,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ I played the tip", callback_data: `CONFIRMBET:${tipId}:${recommendedStake}` },
                { text: "❌ I don't want to play", callback_data: `SKIPBET:${tipId}` }
              ]
            ]
          }
        }
      );
    } catch (e) {
      console.error("Failed to send tip notification", e);
    }
  }
});


// 🔥 KOMPLETAN POPRAVLJEN NUMERIC HANDLER (STAVI GA POSLIJE SVIH DRUGIH HANDLERA)
bot.onText(/^\d+$/, async (msg) => {
  const chatId = msg.chat.id as number;
  const adminId = msg.from?.id!;
  const inputAmount = Number(msg.text!);

  if (!adminCreditInput) return;

  if (adminId !== adminCreditInput.adminId) return;

  if (
    inputAmount <= 0 ||
    inputAmount > 999999 ||
    !Number.isInteger(inputAmount)
  ) {
    return bot.sendMessage(chatId, "Enter **positive integer** 1-999999!", {
      parse_mode: "Markdown",
    });
  }

  const targetUserId = adminCreditInput.userId;
  const amount = adminCreditInput.action === "ADD" ? inputAmount : -inputAmount;

  try {
    await pool.query("BEGIN");

    const walletRes = await pool.query(
      `
      UPDATE betting_bot.wallets SET balance = balance + $1 WHERE user_id = $2 RETURNING balance
    `,
      [amount, targetUserId],
    );

    if (walletRes.rowCount === 0) throw new Error("No wallet found");

    const newBalance = Number(walletRes.rows[0].balance);

    const transactionType =
      adminCreditInput.action === "ADD" ? "ADMINCREDIT" : "ADMINDEBIT";
    await pool.query(
      `
      INSERT INTO betting_bot.transactions (user_id, amount, type, reference, created_at) 
      VALUES ($1, $2, $3, 'admin', NOW())
    `,
      [targetUserId, amount, transactionType],
    );

    await pool.query("COMMIT");

    const userInfo = await pool.query(
      `SELECT username, telegram_id FROM betting_bot.users WHERE id = $1`,
      [targetUserId],
    );
    const userData = userInfo.rows[0];
    const name = userData.username ?? `ID ${userData.telegramid}`;
    const actionText = adminCreditInput.action === "ADD" ? "ADDED" : "REMOVED";

    await bot.sendMessage(
      chatId,
      `${inputAmount} credits ${actionText}! ${name}\n**New Balance:** ${newBalance.toFixed(
        2,
      )}`,
      { parse_mode: "Markdown" },
    );
    bot
      .sendMessage(
        userData.telegramid,
        `${inputAmount} credits ${actionText}! New balance: ${newBalance.toFixed(
          2,
        )}`,
        { parse_mode: "Markdown" },
      )
      .catch(() => {});

    if (adminCreditInput.action === "REMOVE" && newBalance < 0) {
      await bot.sendMessage(chatId, "⚠️ Balance went negative!");
    }
    // Vraća na pending users listu nakon unosa kredita
    if (adminPendingUsersState && adminPendingUsersState.chatId === chatId) {
      try {
        const result = await pool.query(
          `SELECT id, username, telegram_id FROM betting_bot.users WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 20`,
        );

        let keyboard: any[][] = [];
        for (const row of result.rows) {
          const displayName = row.username ?? `ID ${row.telegram_id}`;
          keyboard.push([
            { text: displayName, callback_data: `PENDINGSHOW:${row.id}` },
          ]);
        }

        const messageText = `Pending users (${result.rows.length})`;

        await bot.editMessageText(messageText, {
          chat_id: chatId,
          message_id: adminPendingUsersState.messageId!,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (e: any) {
        if (!e.message?.includes("message is not modified")) {
          console.error("Failed to refresh pending users list:", e);
        }
      }
    }

    // Auto back - bez edit ako je ista poruka
    if (adminCreditsListState && adminCreditsListState.chatId === chatId) {
      try {
        const { messageText, keyboard } = await renderCreditsList(chatId);
        await bot.editMessageText(messageText, {
          chat_id: chatId,
          message_id: adminCreditsListState.messageId,
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: keyboard },
        });
      } catch (e: any) {
        if (!e.message.includes("message is not modified")) console.error(e);
      }
    }

    if (adminCreditsListState && adminCreditsListState.chatId === chatId) {
      const { messageText, keyboard } = await renderCreditsList(chatId);
      await bot.sendMessage(chatId, messageText, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });
      console.log("Returned to credits list");
    }
  } catch (error: any) {
    await pool.query("ROLLBACK");
    await bot.sendMessage(chatId, `❌ Failed: ${error.message}`);
  } finally {
    adminCreditInput = null;
  }
});

// /help command
bot.onText(/\/help/, async (msg) => {
  if (!msg.from) return;

  const chatId = msg.chat.id;
  const telegramId = msg.from.id;

  const userRes = await pool.query(
    `SELECT id, role, status, username
       FROM betting_bot.users
       WHERE telegram_id = $1`,
    [telegramId],
  );

  if (userRes.rows.length === 0) {
    return bot.sendMessage(chatId, "You're not registered. Send /start.");
  }

  const user = userRes.rows[0];

  let helpText = `Your commands (${user.username ?? telegramId}):\n\n`;

  if (user.status === "PENDING") {
    helpText += "⏳ Waiting for admin approval.\n";
  } else if (user.status === "APPROVED") {
    if (user.role === "TIPSTER") {
      helpText += "🎯 **TIPSTER COMMANDS:**\n";
      helpText += "➕ • /newtip bookingCode;odds;stake - post tip\n";
      helpText += "➕ • /balance - check your balance\n\n";
    } else {
      helpText += "📋 **BASIC COMMANDS:**\n";
      helpText += "👥 • /tipsters - list of tipsters\n";
      helpText += "➕ • /balance - check your balance\n";
      helpText += "📋 • /help - command list\n\n";
    }
  } else {
    helpText += "❌ Account rejected. Contact admin.\n";
  }

  if (telegramId === ADMIN_ID) {
    helpText += "🔧 **ADMIN COMMANDS:**\n";
    helpText += "👥 • /pending_users - pending users list\n";
    helpText += "📊 • /pending_tips - open tips list\n";
    helpText += "💰 • /credits - add credits\n";
  }

  await bot.sendMessage(chatId, helpText);
});

bot.onText(/credits/, async (msg) => {
  if (msg.from?.id !== ADMIN_ID) {
    return bot.sendMessage(msg.chat.id, "No rights.");
  }
  const chatId = msg.chat.id as number;

  const usersRes = await pool.query(`
    SELECT id, username, telegram_id, role 
    FROM betting_bot.users 
    WHERE status = 'APPROVED' AND role = 'USER' 
    ORDER BY username NULLS LAST, created_at DESC 
    LIMIT 20
  `);

  const tipstersRes = await pool.query(`
    SELECT id, username, telegram_id, role 
    FROM betting_bot.users 
    WHERE status = 'APPROVED' AND role = 'TIPSTER' 
    ORDER BY username NULLS LAST, created_at DESC 
    LIMIT 20
  `);

  if (usersRes.rows.length === 0 && tipstersRes.rows.length === 0) {
    return bot.sendMessage(chatId, "No approved users or tipsters found.");
  }

  let messageText = "**Users** (" + usersRes.rows.length + ")\n";
  const keyboard: any[][] = [];

  for (const user of usersRes.rows) {
    const name = user.username ?? `ID ${user.id}`;
    keyboard.push([
      {
        text: `${name} (${user.role})`,
        callback_data: `CREDITSUSER:${user.id}`,
      },
    ]);
  }

  if (tipstersRes.rows.length > 0) {
    messageText += "\n**Tipsters** (" + tipstersRes.rows.length + ")\n";
    for (const tipster of tipstersRes.rows) {
      const name = tipster.username ?? `ID ${tipster.id}`;
      keyboard.push([
        {
          text: `${name} (${tipster.role})`,
          callback_data: `CREDITSUSER:${tipster.id}`,
        },
      ]);
    }
  }

  const message = await bot.sendMessage(chatId, messageText, {
    parse_mode: "Markdown",
    reply_markup: { inline_keyboard: keyboard },
  });
  adminCreditsListState = { messageId: message.message_id!, chatId };
});

// Helper function for rendering credits list (reusable)
async function renderCreditsList(chatId: number) {
  const usersRes = await pool.query(`
    SELECT id, username, telegram_id, role 
    FROM betting_bot.users 
    WHERE status = 'APPROVED' AND role = 'USER' 
    ORDER BY username NULLS LAST, created_at DESC 
    LIMIT 20
  `);

  const tipstersRes = await pool.query(`
    SELECT id, username, telegram_id, role 
    FROM betting_bot.users 
    WHERE status = 'APPROVED' AND role = 'TIPSTER' 
    ORDER BY username NULLS LAST, created_at DESC 
    LIMIT 20
  `);

  let messageText = "**Users** (" + usersRes.rows.length + ")";
  const keyboard: any[][] = [];

  for (const user of usersRes.rows) {
    const name = user.username ?? `ID ${user.id}`;
    keyboard.push([
      {
        text: `${name} (${user.role})`,
        callback_data: `CREDITSUSER:${user.id}`,
      },
    ]);
  }

  if (tipstersRes.rows.length > 0) {
    messageText += "\n**Tipsters** (" + tipstersRes.rows.length + ")\n\n";
    for (const tipster of tipstersRes.rows) {
      const name = tipster.username ?? `ID ${tipster.id}`;
      keyboard.push([
        {
          text: `${name} (${tipster.role})`,
          callback_data: `CREDITSUSER:${tipster.id}`,
        },
      ]);
    }
  }

  return { messageText, keyboard };
}

// 🔥 MAIN: callback_query handler
bot.on("callback_query", async (query) => {
  const data = query.data;
  const from = query.from;
  if (!data || !from) return;

  const chatId = query.message?.chat.id ?? from.id;
  // USER biranje željenog role-a na /start
  if (data.startsWith("REQ_ROLE:")) {
    const requestedRole = data.split(":")[1]; // USER ili TIPSTER

    if (requestedRole !== "USER" && requestedRole !== "TIPSTER") {
      return bot.answerCallbackQuery(query.id, {
        text: "Unknown role.",
        show_alert: true,
      });
    }

    // Updajtaj usera
    const res = await pool.query(
      `UPDATE betting_bot.users
       SET requested_role = $1, updated_at = NOW()
       WHERE telegram_id = $2
       RETURNING status`,
      [requestedRole, from.id],
    );

    if (res.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "User not found.",
        show_alert: true,
      });
    }

    const status = res.rows[0].status;

    // Editaj postojeću poruku s informacijom
    await bot.editMessageText(
      `✅ You signed up as *${requestedRole}*.\n\n` +
        (status === "APPROVED"
          ? "Your accoutn has already been approved."
          : "Admin will review your request and accept/reject your account."),
      {
        chat_id: chatId,
        message_id: query.message?.message_id,
        parse_mode: "Markdown",
      },
    );

    await bot.answerCallbackQuery(query.id, {
      text: `Requested role: ${requestedRole}`,
    });
    return;
  }
  // SUBSCRIBE TIPSTER// 🔥 SUBSCRIBE TIPSTER (ažurirana verzija sa auto-refresh)
  if (data.startsWith("SUBSCRIBE:")) {
    const tipsterId = Number(data.split(":")[1]);

    const userRes = await pool.query(
      `SELECT id FROM betting_bot.users WHERE telegram_id = $1 AND status = 'APPROVED' AND role != 'TIPSTER'`,
      [from.id],
    );

    if (userRes.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "You're not approved or you're a tipster.",
        show_alert: true,
      });
    }

    await pool.query(
      `INSERT INTO betting_bot.tipster_subscribers (tipster_id, user_id)
     VALUES ($1, $2) ON CONFLICT (tipster_id, user_id) DO NOTHING`,
      [tipsterId, userRes.rows[0].id],
    );

    const tipster = await pool.query(
      `SELECT username FROM betting_bot.users WHERE id = $1`,
      [tipsterId],
    );

    const username = tipster.rows[0]?.username ?? `tipster${tipsterId}`;

    await bot.answerCallbackQuery(query.id, {
      text: `✅ Subscribed to ${username}!`,
    });

    // 🔥 AUTO REFRESH LISTE nakon subscribe
    if (tipstersListState && tipstersListState.userId === userRes.rows[0].id) {
      await renderTipstersList(
        tipstersListState.chatId,
        tipstersListState.userId,
        tipstersListState.messageId,
      );
    }
    return;
  }

  // 🔥 UNSUBSCRIBE TIPSTER (ažurirana verzija sa auto-refresh)
  if (data.startsWith("UNSUBSCRIBE:")) {
    const tipsterId = Number(data.split(":")[1]);

    const userRes = await pool.query(
      `SELECT id FROM betting_bot.users WHERE telegram_id = $1 AND status = 'APPROVED' AND role != 'TIPSTER'`,
      [from.id],
    );

    if (userRes.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "You're not approved or you're a tipster.",
        show_alert: true,
      });
    }

    const deleteRes = await pool.query(
      `DELETE FROM betting_bot.tipster_subscribers 
     WHERE tipster_id = $1 AND user_id = $2`,
      [tipsterId, userRes.rows[0].id],
    );

    if (deleteRes.rowCount === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "You are not subscribed to this tipster.",
        show_alert: true,
      });
    }

    const tipster = await pool.query(
      `SELECT username FROM betting_bot.users WHERE id = $1`,
      [tipsterId],
    );

    const username = tipster.rows[0]?.username ?? `tipster${tipsterId}`;

    await bot.answerCallbackQuery(query.id, {
      text: `❌ Unsubscribed from ${username}!`,
    });

    // 🔥 AUTO REFRESH LISTE nakon unsubscribe
    if (tipstersListState && tipstersListState.userId === userRes.rows[0].id) {
      await renderTipstersList(
        tipstersListState.chatId,
        tipstersListState.userId,
        tipstersListState.messageId,
      );
    }
    return;
  }

  if (data.startsWith("PENDING_SHOW:")) {
    const userId = Number(data.split(":")[1]);

    if (from.id !== ADMIN_ID) return;

    const user = await pool.query(
      `SELECT id, username, telegram_id, created_at, requested_role
     FROM betting_bot.users 
     WHERE id = $1 AND status = 'PENDING'`,
      [userId],
    );

    if (user.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "User not found.",
        show_alert: true,
      });
    }

    const userData = user.rows[0];
    const displayName = userData.username ?? `ID${userData.telegram_id}`;

    await bot.editMessageText(
      `👤 **${displayName}**\n` +
        `🆔 ID: ${userData.id}\n` +
        `📱 TG ID: ${userData.telegram_id}\n` +
        `📅 Registered: ${new Date(userData.created_at).toLocaleString()}` +
        `🎯 Request role: *${userData.requested_role ?? "didnt choose"}*`,
      {
        chat_id: chatId!,
        message_id: query.message?.message_id!,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [
              {
                text: "👥 USER",
                callback_data: `SET_ROLE:${userData.id}:USER`,
              },
              {
                text: "🎯 TIPSTER",
                callback_data: `SET_ROLE:${userData.id}:TIPSTER`,
              },
            ],
            [{ text: "❌ REJECT", callback_data: `REJECT:${userData.id}` }],
            [{ text: "🔙 Back to list", callback_data: "PENDING_BACK" }],
          ],
        },
      },
    );

    await bot.answerCallbackQuery(query.id, { text: "User details" });
    return;
  }

  // APPROVE USER - choose role
  if (data.startsWith("APPROVE:")) {
    const userId = Number(data.split(":")[1]);

    if (from.id !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, {
        text: "No rights.",
        show_alert: true,
      });
    }

    const userCheck = await pool.query(
      `SELECT id, username, telegram_id, role, status FROM betting_bot.users WHERE id = $1`,
      [userId],
    );

    if (userCheck.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "User doesn't exist.",
        show_alert: true,
      });
    }

    const user = userCheck.rows[0];

    await bot.sendMessage(
      chatId,
      `✅ *Approval for ${
        user.username ?? user.telegram_id
      }*\n\nCurrent role: *${user.role}*\nTelegram ID: ${
        user.telegram_id
      }\n\nChoose **NEW role**:`,
      {
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "👥 USER", callback_data: `SET_ROLE:${userId}:USER` }],
            [
              {
                text: "🎯 TIPSTER",
                callback_data: `SET_ROLE:${userId}:TIPSTER`,
              },
            ],
            [{ text: "❌ Cancel", callback_data: `CANCEL_APPROVE:${userId}` }],
          ],
        },
      },
    );

    await bot.answerCallbackQuery(query.id, { text: "Choose role ➡️" });
    return;
  }

  // REJECT USER
  if (data.startsWith("REJECT:")) {
    const userId = Number(data.split(":")[1]);

    if (from.id !== ADMIN_ID) return;

    const result = await pool.query(
      `UPDATE betting_bot.users
       SET status = 'REJECTED', updated_at = NOW()
       WHERE id = $1 RETURNING id, username, telegram_id`,
      [userId],
    );

    if (result.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "User doesn't exist.",
        show_alert: true,
      });
    }

    const user = result.rows[0];

    await bot
      .sendMessage(
        user.telegram_id,
        "❌ Your account is rejected. Contact admin if you think it's a mistake.",
      )
      .catch(() => {});

    await bot.answerCallbackQuery(query.id, {
      text: `❌ ${user.username ?? user.telegram_id} rejected!`,
    });
    if (adminPendingUsersState && adminPendingUsersState.chatId === chatId) {
      try {
        const result = await pool.query(
          `SELECT id, username, telegram_id
         FROM betting_bot.users
         WHERE status = 'PENDING'
         ORDER BY created_at ASC
         LIMIT 20`,
        );

        if (result.rows.length > 0) {
          const keyboard: any[][] = [];
          for (const row of result.rows) {
            const displayName = row.username ?? `ID${row.telegram_id}`;
            keyboard.push([
              { text: displayName, callback_data: `PENDING_SHOW:${row.id}` },
            ]);
          }

          await bot.sendMessage(
            chatId,
            `⏳ **Pending users (${result.rows.length}):**`,
            {
              parse_mode: "Markdown",
              reply_markup: { inline_keyboard: keyboard },
            },
          );
          console.log("✅ AUTO LIST AFTER REJECT");
        }
      } catch (listError) {
        console.log("Failed auto-list after reject:", listError);
      }
    }
    // 🔥 🔥 KRAJ 🔥 🔥

    return;
  }

  // Show tip details (klik na booking code)
  if (data.startsWith("TIPSHOW")) {
    const tipId = Number(data.split(":")[1]);
    if (from.id !== ADMIN_ID) return;

    const tipRes = await pool.query(
      `
    SELECT t.id, t.booking_code, t.odds, t.recommended_stake, u.username as tipster 
    FROM betting_bot.tips t JOIN betting_bot.users u ON u.id = t.tipster_id 
    WHERE t.id = $1 AND t.status = 'OPEN'
  `,
      [tipId],
    );

    if (tipRes.rows.length === 0) {
      bot.answerCallbackQuery(query.id, {
        text: "Tip not found or already closed.",
        show_alert: true,
      });
    }

    const t = tipRes.rows[0];
    await bot.editMessageText(
      `*Tip ${t.id}*\n` +
        `Booking code: \`${t.booking_code}\`\n` +
        `Tipster: ${t.tipster}\n` +
        `Odds: ${t.odds}\n` +
        `Stake: ${t.recommended_stake}`,
      {
        chat_id: chatId!,
        message_id: query.message?.message_id!,
        parse_mode: "Markdown",
        reply_markup: {
          inline_keyboard: [
            [{ text: "✅ WIN", callback_data: `CLOSETIP:${t.id}:WIN` }],
            [{ text: "❌ LOSE", callback_data: `CLOSETIP:${t.id}:LOSE` }],
            [{ text: "← Back to list", callback_data: "TIPSBACK" }],
          ],
        },
      },
    );
    return bot.answerCallbackQuery(query.id, {
      text: "Tip details",
    });
  }

  // Back/Refresh list
  if (data === "TIPSBACK") {
    if (!adminTipsListState || from.id !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, {
        text: "Session expired.",
        show_alert: true,
      });
    }

    const tips = await pool.query(`
    SELECT t.id, t.booking_code, t.odds, u.username as tipster 
    FROM betting_bot.tips t 
    JOIN betting_bot.users u ON u.id = t.tipster_id 
    WHERE t.status = 'OPEN' 
    ORDER BY t.created_at DESC 
    LIMIT 20
  `);
    if (tips.rows.length === 0) {
      await bot.editMessageText("No open tips.", {
        chat_id: adminTipsListState.chatId,
        message_id: adminTipsListState.messageId,
        parse_mode: "Markdown",
      });
      return bot.answerCallbackQuery(query.id);
    }

    const keyboard: any[][] = [];
    for (const t of tips.rows) {
      keyboard.push([
        {
          text: `${t.booking_code} (${t.tipster})`,
          callback_data: `TIPSHOW:${t.id}`,
        },
      ]);
    }

    await bot.editMessageText(`*OPEN TIPS* (${tips.rows.length})`, {
      chat_id: adminTipsListState.chatId,
      message_id: adminTipsListState.messageId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    return bot.answerCallbackQuery(query.id, {
      text: "Back to list",
    });
  }

  if (data.startsWith("CLOSETIP")) {
    if (from.id !== ADMIN_ID) return;

    const parts = data.split(":");
    if (parts.length !== 3) {
      await bot.answerCallbackQuery(query.id!, {
        text: "Invalid data format!",
        show_alert: true,
      });
      return;
    }

    const tipId = Number(parts[1]);
    const result = parts[2]; // WIN ili LOSE

    if (isNaN(tipId) || tipId <= 0 || (result !== "WIN" && result !== "LOSE")) {
      await bot.answerCallbackQuery(query.id!, {
        text: "Invalid tip or result!",
        show_alert: true,
      });
      return;
    }
    await pool.query("BEGIN");
    try {
      // Dohvati tip + provjeri OPEN
      const tipRes = await pool.query(
        `
      SELECT tipster_id, odds FROM betting_bot.tips 
      WHERE id = $1 AND status = 'OPEN'
    `,
        [tipId],
      );
      if (tipRes.rows.length === 0) {
        await pool.query("ROLLBACK");
        return bot.answerCallbackQuery(query.id!, { text: "Tip not OPEN." });
      }
      const row = tipRes.rows[0];
      const tipsterid = row.tipster_id; // ✅ direktno
      const odds = row.odds;

      // Dohvati confirmed betove
      const userTips = await pool.query(
        `
      SELECT ut.user_id, ut.stake, u.telegram_id 
      FROM betting_bot.user_tips ut 
      JOIN betting_bot.users u ON u.id = ut.user_id 
      WHERE ut.tip_id = $1 AND ut.status = 'CONFIRMED'
    `,
        [tipId],
      );

      // ZATVORI TIP + result kolona!
      await pool.query(
        `
      UPDATE betting_bot.tips 
      SET status = 'CLOSED', result = $1 
      WHERE id = $2
    `,
        [result, tipId],
      );

      const CONSOLATION_FEE = 1.04;

      if (result === "WIN") {
        let totalTipsterPayout = 0;
        for (const ut of userTips.rows) {
          console.log(ut);
          const stake = Number(ut.stake);
          const payout = stake * Number(odds);
          totalTipsterPayout += payout;

          const userBalanceRes = await pool.query(
            `SELECT balance FROM betting_bot.wallets WHERE user_id = $1`,
            [ut.user_id],
          );

          await bot
            .sendMessage(
              ut.telegram_id,
              `🎉 **TIP #${tipId} WON** ✅\n` +
                `Stake: **${stake * odds}**\n` +
                `💰 **Your balance: ${userBalanceRes.rows[0]?.balance}**`,
              { parse_mode: "Markdown" },
            )
            .catch(() => {});
        }

        // TIPSTER dobiva sve
        console.log(
          `Users: ${userTips.rows.length}, Total payout: ${totalTipsterPayout}, tipster: ${tipsterid}`,
        );

        await pool.query(
          `
        UPDATE betting_bot.wallets SET balance = balance + $1 
        WHERE user_id = $2
      `,
          [totalTipsterPayout, tipsterid],
        );
        const tipsterBalanceRes = await pool.query(
          `SELECT balance, telegram_id FROM betting_bot.users u 
     JOIN betting_bot.wallets w ON w.user_id = u.id 
     WHERE u.id = $1`,
          [tipsterid],
        );
        const tipsterNewBalance = tipsterBalanceRes.rows[0]?.balance;
        const tipsterTelegramId = tipsterBalanceRes.rows[0]?.telegram_id;

        if (tipsterTelegramId) {
          await bot
            .sendMessage(
              tipsterTelegramId,
              `💰 **WIN BONUS!** 🎉\n` +
                `Tip #${tipId}: **+${totalTipsterPayout}**\n` +
                `(${userTips.rows.length} users)\n` +
                `💵 **New balance: ${tipsterNewBalance}**`,
              { parse_mode: "Markdown" },
            )
            .catch(() => {});
        }
      } else if (result === "LOSE") {
        for (const ut of userTips.rows) {
          const stake = Number(ut.stake);
          const userRefund = stake * odds * CONSOLATION_FEE;
          await pool.query(
            `
          UPDATE betting_bot.wallets SET balance = balance + $1 
          WHERE user_id = $2
        `,
            [userRefund, ut.user_id],
          );

          const userBalanceRes = await pool.query(
            `SELECT balance FROM betting_bot.wallets WHERE user_id = $1`,
            [ut.user_id],
          );

          await bot
            .sendMessage(
              ut.telegram_id,
              `😞 **TIP #${tipId} LOST**\n` +
                `Stake: **${stake * odds}**\n` +
                `Compensation: **+${userRefund}**\n` +
                `💰 **New balance: ${userBalanceRes.rows[0]?.balance}**`,
              { parse_mode: "Markdown" },
            )
            .catch(() => {});
        }
        const tipsterInfo = await pool.query(
          `SELECT telegram_id FROM betting_bot.users WHERE id = $1`,
          [tipsterid],
        );

        if (tipsterInfo.rows[0]?.telegram_id) {
          await bot
            .sendMessage(
              tipsterInfo.rows[0].telegram_id,
              `⚠️ **TIP #${tipId} LOST** (${userTips.rows.length} users)\n` +
                `💰 **Your balance: unchanged**`,
              { parse_mode: "Markdown" },
            )
            .catch(() => {});
        }
      }

      await pool.query(
        `
      UPDATE betting_bot.user_tips SET status = $1 WHERE tip_id = $2
    `,
        [result, tipId],
      );

      await pool.query("COMMIT");

      if (adminTipsListState && adminTipsListState.chatId === chatId) {
        try {
          const tips = await pool.query(`
      SELECT t.id, t.booking_code, t.odds, u.username as tipster 
      FROM betting_bot.tips t 
      JOIN betting_bot.users u ON u.id = t.tipster_id 
      WHERE t.status = 'OPEN' 
      ORDER BY t.created_at DESC LIMIT 20
    `);

          let keyboard: any[][] = [];
          for (const t of tips.rows) {
            keyboard.push([
              {
                text: `${t.booking_code} ${t.tipster}`,
                callback_data: `TIPSHOW:${t.id}`,
              },
            ]);
          }

          const messageText = `OPEN TIPS ${tips.rows.length}`;
          await bot.editMessageText(messageText, {
            chat_id: adminTipsListState.chatId,
            message_id: adminTipsListState.messageId!,
            parse_mode: "Markdown",
            reply_markup: { inline_keyboard: keyboard },
          });
        } catch (e: any) {
          if (!e.message?.includes("message is not modified"))
            console.error("Refresh failed", e);
        }
      }

      const betsCount = userTips.rows.length;
      bot.answerCallbackQuery(query.id!, {
        text: `Tip ${tipId} ${result} (${betsCount} bets)`,
      });
    } catch (e) {
      await pool.query("ROLLBACK");
      console.error("Close tip error:", e);
      bot.answerCallbackQuery(query.id!, { text: "Error!", show_alert: true });
    }
  }

  // SET ROLE + CREDITS INPUT (POPRAVLJENO)
  if (data.startsWith("SET_ROLE:")) {
    const parts = data.split(":");
    const userId = Number(parts[1]);
    const newRole = parts[2];

    if (from.id !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, {
        text: "No rights.",
        show_alert: true,
      });
    }

    // Update user role/status
    const result = await pool.query(
      `UPDATE betting_bot.users 
     SET status = 'APPROVED', role = $1, updated_at = NOW()
     WHERE id = $2 AND status = 'PENDING'
     RETURNING id, username, telegram_id, role`,
      [newRole, userId],
    );

    if (result.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "User not found or already approved.",
        show_alert: true,
      });
    }

    const updatedUser = result.rows[0];

    try {
      await bot.sendMessage(
        updatedUser.telegram_id,
        `🎉 *Your account is APPROVED!*\n\n` +
          `✅ Role: **${newRole}**\n` +
          `💰 Credits will be added soon...\n\n` +
          `Send /start or /help to see your commands.`,
        { parse_mode: "Markdown" },
      );
    } catch (e) {
      console.log("Failed to notify approved user:", e);
    }

    console.log(`CREDIT INPUT SET: user=${updatedUser.id}, admin=${from.id}`);
    adminCreditInput = {
      userId: updatedUser.id,
      adminId: from.id!,
      action: "ADD",
    };

    await bot.sendMessage(
      chatId,
      `✅ *${
        updatedUser.username ?? updatedUser.telegram_id
      }* → **${newRole}**\n\n` +
        `💰 **Enter credit amount:**\n` +
        `_Example: \`1000\` (just send the number)_`,
      {
        parse_mode: "Markdown",
      },
    );

    await bot.answerCallbackQuery(query.id, {
      text: `✅ ${newRole}! Send credits amount ➡️`,
    });
    return;
  }

  if (data.startsWith("CREDITSUSER:")) {
    const userId = Number(data.split(":")[1]);
    if (from.id !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, {
        text: "No rights.",
        show_alert: true,
      });
    }

    const userRes = await pool.query(
      `
    SELECT id, username, telegram_id, role 
    FROM betting_bot.users 
    WHERE id = $1 AND status = 'APPROVED'
  `,
      [userId],
    );

    if (userRes.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "User not found.",
        show_alert: true,
      });
    }

    const user = userRes.rows[0];
    const name = user.username ?? `ID ${user.id}`;

    await bot.editMessageText(`*${name}* (${user.role})\n\nChoose action:`, {
      chat_id: chatId!,
      message_id: query.message?.message_id!,
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [{ text: "➕ Add Credits", callback_data: `CREDITSADD:${userId}` }],
          [
            {
              text: "➖ Remove Credits",
              callback_data: `CREDITSREMOVE:${userId}`,
            },
          ],
          [{ text: "🔙 Back to List", callback_data: "CREDITSBACK" }],
        ],
      },
    });
    await bot.answerCallbackQuery(query.id, { text: `Selected ${name}` });
    return;
  }

  // CREDITSADD/REMOVE callbacks
  if (data.startsWith("CREDITSADD:")) {
    const userId = Number(data.split(":")[1]);
    const userRes = await pool.query(
      `SELECT username, telegram_id FROM betting_bot.users WHERE id = $1`,
      [userId],
    );
    if (userRes.rows.length === 0)
      return bot.answerCallbackQuery(query.id, {
        text: "User not found.",
        show_alert: true,
      });

    const user = userRes.rows[0];
    const name = user.username ?? `ID ${user.telegramid}`;

    adminCreditInput = { userId, adminId: from.id!, action: "ADD" };
    await bot.editMessageText(
      `*${name}*\nEnter amount to **ADD** (e.g. 1000):`,
      {
        chat_id: chatId!,
        message_id: query.message?.message_id!,
        parse_mode: "Markdown",
      },
    );
    return bot.answerCallbackQuery(query.id, { text: "Enter amount to ADD." });
  }

  if (data.startsWith("CREDITSREMOVE:")) {
    const userId = Number(data.split(":")[1]);
    const userRes = await pool.query(
      `SELECT username, telegram_id FROM betting_bot.users WHERE id = $1`,
      [userId],
    );
    if (userRes.rows.length === 0)
      return bot.answerCallbackQuery(query.id, {
        text: "User not found.",
        show_alert: true,
      });

    const user = userRes.rows[0];
    const name = user.username ?? `ID ${user.telegramid}`;

    adminCreditInput = { userId, adminId: from.id!, action: "REMOVE" };
    await bot.editMessageText(
      `*${name}*\nEnter amount to **REMOVE** (e.g. 500):`,
      {
        chat_id: chatId!,
        message_id: query.message?.message_id!,
        parse_mode: "Markdown",
      },
    );
    return bot.answerCallbackQuery(query.id, {
      text: "Enter amount to REMOVE.",
    });
  }
  if (data === "CREDITSBACK") {
    if (!adminCreditsListState || from.id !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, {
        text: "Session expired.",
        show_alert: true,
      });
    }
    const { messageText, keyboard } = await renderCreditsList(
      adminCreditsListState.chatId,
    );
    await bot.editMessageText(messageText, {
      chat_id: adminCreditsListState.chatId,
      message_id: adminCreditsListState.messageId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });
    await bot.answerCallbackQuery(query.id, { text: "Back to list." });
    return;
  }

  // 🔥 ADMIN: /pending_users - list with navigation state
  bot.onText(/\/pending_users/, async (msg) => {
    if (msg.from?.id !== ADMIN_ID) {
      return bot.sendMessage(
        msg.chat.id,
        "You have no rights for this command.",
      );
    }

    const chatId = msg.chat.id;

    const result = await pool.query(
      `SELECT id, username, telegram_id
     FROM betting_bot.users
     WHERE status = 'PENDING'
     ORDER BY created_at ASC
     LIMIT 20`,
    );

    if (result.rows.length === 0) {
      return bot.sendMessage(chatId, "No users waiting for approval.");
    }

    adminPendingUsersState = { messageId: 0, chatId };

    const keyboard: any[][] = [];
    for (const row of result.rows) {
      const displayName = row.username ?? `ID${row.telegram_id}`;
      keyboard.push([
        { text: displayName, callback_data: `PENDING_SHOW:${row.id}` },
      ]);
    }

    const message = await bot.sendMessage(
      chatId,
      `⏳ **Pending users (${result.rows.length}):**`,
      {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      },
    );

    adminPendingUsersState!.messageId = message.message_id!;
  });

  // CONFIRM_BET - user confirms they played
  if (data.startsWith("CONFIRM_BET:")) {
    const parts = data.split(":");
    const tipId = Number(parts[1]);
    const stake = Number(parts[2]);

    // Get user and check balance
    const userRes = await pool.query(
      `SELECT u.id, w.balance 
       FROM betting_bot.users u 
       JOIN betting_bot.wallets w ON w.user_id = u.id 
       WHERE u.telegram_id = $1 AND u.status = 'APPROVED'`,
      [from.id],
    );

    const existingBet = await pool.query(
      `SELECT id FROM betting_bot.user_tips WHERE user_id = $1 AND tip_id = $2 AND status = 'CONFIRMED'`,
      [userRes.rows[0].id, tipId],
    );
    if (existingBet.rows.length > 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "You have already played this tip!",
        show_alert: true,
      });
    }

    if (userRes.rows.length === 0 || Number(userRes.rows[0].balance) < stake) {
      return bot.answerCallbackQuery(query.id, {
        text: "Not enough balance!",
        show_alert: true,
      });
    }

    // Get tip and check tipster balance
    const tipRes = await pool.query(
      `SELECT tipster_id, odds, status, recommended_stake 
       FROM betting_bot.tips 
       WHERE id = $1 AND status = 'OPEN'`,
      [tipId],
    );

    if (tipRes.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, {
        text: "Tip is no longer available!",
        show_alert: true,
      });
    }

    const tip = tipRes.rows[0];
    const tipsterId = tip.tipster_id;
    const odds = Number(tip.odds);

    // Check tipster balance for payout (stake * odds)
    const tipsterWallet = await pool.query(
      `SELECT balance FROM betting_bot.wallets WHERE user_id = $1`,
      [tipsterId],
    );

    if (tipsterWallet.rows[0]?.balance < stake * odds) {
      return bot.answerCallbackQuery(query.id, {
        text: "Tipster doesn't have enough balance!",
        show_alert: true,
      });
    }

    await pool.query("BEGIN");
    try {
      const userId = userRes.rows[0].id;

      // User pays stake upfront
      await pool.query(
        `UPDATE betting_bot.wallets SET balance = balance - $1 WHERE user_id = $2`,
        [stake * odds, userId],
      );

      // Tipster pays stake upfront (will get back on WIN)
      await pool.query(
        `UPDATE betting_bot.wallets SET balance = balance - $1 WHERE user_id = $2`,
        [stake * odds, tipsterId],
      );

      // Record confirmed bet
      await pool.query(
        `INSERT INTO betting_bot.user_tips (user_id, tip_id, stake, status, potential_win)
         VALUES ($1, $2, $3, 'CONFIRMED', $4)`,
        [userId, tipId, stake, stake * odds],
      );

      await pool.query("COMMIT");

      await bot.answerCallbackQuery(query.id, {
        text: `✅ Bet ${stake} recorded!`,
      });

      await bot.sendMessage(
        chatId,
        `✅ Tip #${tipId} played with stake ${stake}.\nBalance updated!`,
      );
      await bot.sendMessage(
        chatId,
        `Tip ${tipId} - PLAYED! (you can't play again)`,
        {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Skip (already played)",
                  callback_data: `SKIPBET${tipId}`,
                },
              ],
            ],
          },
        },
      );
    } catch (e) {
      await pool.query("ROLLBACK");
      console.error(e);
      await bot.answerCallbackQuery(query.id, {
        text: "Error processing bet!",
        show_alert: true,
      });
    }
    return;
  }

  // SKIP_BET
  if (data.startsWith("SKIP_BET:")) {
    await bot.answerCallbackQuery(query.id, { text: "OK, skipped." });
    return;
  }

  if (data === "PENDING_BACK") {
    if (!adminPendingUsersState || from.id !== ADMIN_ID) {
      return bot.answerCallbackQuery(query.id, { text: "Session expired." });
    }

    const result = await pool.query(
      `SELECT id, username, telegram_id
     FROM betting_bot.users
     WHERE status = 'PENDING'
     ORDER BY created_at ASC
     LIMIT 20`,
    );

    if (result.rows.length === 0) {
      return bot.answerCallbackQuery(query.id, { text: "No pending users." });
    }

    const keyboard: any[][] = [];
    for (const row of result.rows) {
      const displayName = row.username ?? `ID${row.telegram_id}`;
      keyboard.push([
        { text: displayName, callback_data: `PENDING_SHOW:${row.id}` },
      ]);
    }

    await bot.editMessageText(`⏳ **Pending users (${result.rows.length}):**`, {
      chat_id: adminPendingUsersState.chatId,
      message_id: adminPendingUsersState.messageId,
      parse_mode: "Markdown",
      reply_markup: { inline_keyboard: keyboard },
    });

    await bot.answerCallbackQuery(query.id, { text: "🔙 Back to list" });
    return;
  }
  console.log(`Unhandled callback: ${data}`);
});

// Error handling
bot.on("polling_error", (error) => {
  console.error("Polling error:", error);
});

console.log("Betting bot started!");
