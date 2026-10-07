'use strict';
require('dotenv').config();

const express = require('express');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { OAuth2Client } = require('google-auth-library');

/* ------------------------------ config ------------------------------ */
const PROD = process.env.NODE_ENV === 'production';
const PORT = process.env.PORT || 3000;
const COOKIE = 'pabtme_session';
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_FAILS = 5; // wrong passwords before the account is locked
const BASE_LOCK_MIN = 15; // first lock = 15 min, doubles each time (max 24h)
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

let JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET.length < 32) {
  if (PROD) {
    console.error('JWT_SECRET must be set (32+ characters) in production.');
    process.exit(1);
  }
  JWT_SECRET = crypto.randomBytes(48).toString('hex');
  console.warn('[dev] Using a temporary JWT_SECRET. Sessions reset on restart.');
}

const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;

/* ------------------------------ database ------------------------------ */
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'pabtme.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT,
  google_id TEXT UNIQUE,
  username_set INTEGER NOT NULL DEFAULT 1,
  failed_attempts INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  lock_count INTEGER NOT NULL DEFAULT 0,
  token_version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chats (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  files TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_user ON chats(user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_msgs_chat ON messages(chat_id, id);
`);

/* ------------------------------ app ------------------------------ */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", 'https://accounts.google.com'],
        styleSrc: ["'self'", "'unsafe-inline'", 'https://accounts.google.com'],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://*.googleusercontent.com'],
        connectSrc: ["'self'", 'https://accounts.google.com'],
        frameSrc: ['https://accounts.google.com'],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: PROD ? [] : null
      }
    },
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
    hsts: PROD ? { maxAge: 31536000, includeSubDomains: true } : false
  })
);
app.use(cookieParser());
app.use(express.json({ limit: '50kb' }));

// CSRF defence: cookie is SameSite=Strict, and every write must carry this header.
app.use('/api', (req, res, next) => {
  if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) && req.get('X-Requested-With') !== 'pabtme') {
    return res.status(403).json({ error: 'Blocked request.' });
  }
  next();
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts from this network. Try again in a few minutes.' }
});
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => 'u' + (req.user ? req.user.id : req.ip),
  validate: { keyGeneratorIpFallback: false },
  message: { error: 'Slow down a little. Try again in a minute.' }
});

/* ------------------------------ helpers ------------------------------ */
const USERNAME_RE = /^[A-Za-z0-9_]{6,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12);

function passwordProblem(pw) {
  if (typeof pw !== 'string') return 'Password is required.';
  if (pw.length < 8) return 'Password must be at least 8 characters.';
  if (Buffer.byteLength(pw) > 72) return 'Password is too long (72 bytes max).';
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/\d/.test(pw))
    return 'Password needs an uppercase letter, a lowercase letter and a number.';
  return null;
}

function publicUser(u) {
  return { username: u.username, email: u.email, usernameSet: !!u.username_set };
}

function setSession(res, user) {
  const token = jwt.sign({ uid: user.id, tv: user.token_version }, JWT_SECRET, {
    algorithm: 'HS256',
    expiresIn: Math.floor(SESSION_MS / 1000)
  });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: PROD,
    sameSite: 'strict',
    maxAge: SESSION_MS,
    path: '/'
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Please sign in.' });
  try {
    const p = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.uid);
    if (!u || u.token_version !== p.tv) throw new Error('stale');
    req.user = u;
    next();
  } catch {
    res.clearCookie(COOKIE, { path: '/' });
    res.status(401).json({ error: 'Session expired. Please sign in again.' });
  }
}

function freeUsername(email) {
  let base = email.split('@')[0].replace(/[^A-Za-z0-9_]/g, '').slice(0, 14);
  if (base.length < 6) base = (base + 'user' + crypto.randomInt(1000, 9999)).slice(0, 14);
  let name = base;
  for (let i = 0; i < 20; i++) {
    if (!db.prepare('SELECT 1 FROM users WHERE username = ?').get(name)) return name;
    name = base.slice(0, 16) + crypto.randomInt(100, 999);
  }
  return 'user' + crypto.randomBytes(5).toString('hex');
}

/* ------------------------------ auth routes ------------------------------ */
app.get('/api/config', (req, res) => {
  res.json({ googleClientId: GOOGLE_CLIENT_ID || null });
});

app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const { username, email, password } = req.body || {};
    if (typeof username !== 'string' || !USERNAME_RE.test(username))
      return res.status(400).json({ error: 'Username must be 6-20 characters: letters, numbers or underscore.' });
    if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email))
      return res.status(400).json({ error: 'Enter a valid email address.' });
    const pwErr = passwordProblem(password);
    if (pwErr) return res.status(400).json({ error: pwErr });

    const taken = db.prepare('SELECT 1 FROM users WHERE username = ? OR email = ?').get(username, email);
    if (taken) return res.status(409).json({ error: 'That username or email is already in use.' });

    const hash = await bcrypt.hash(password, 12);
    const info = db
      .prepare('INSERT INTO users (username, email, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(username, email.toLowerCase(), hash, Date.now());
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    setSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('register', e.message);
    res.status(500).json({ error: 'Could not create the account.' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { identifier, password } = req.body || {};
    if (typeof identifier !== 'string' || typeof password !== 'string' || !identifier || !password || identifier.length > 254 || password.length > 200)
      return res.status(400).json({ error: 'Enter your username or email and your password.' });

    const id = identifier.trim();
    const user = db.prepare('SELECT * FROM users WHERE username = ? OR email = ?').get(id, id);
    const now = Date.now();

    if (!user) {
      await bcrypt.compare(password, DUMMY_HASH); // keep timing similar
      return res.status(401).json({ error: 'Wrong username/email or password.' });
    }

    // Locked accounts cannot sign in at all until the lock ends - even with the right password.
    if (user.locked_until > now) {
      const mins = Math.ceil((user.locked_until - now) / 60000);
      return res.status(429).json({
        error: `Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}.`
      });
    }

    const ok = user.password_hash ? await bcrypt.compare(password, user.password_hash) : (await bcrypt.compare(password, DUMMY_HASH), false);

    if (!ok) {
      const fails = user.failed_attempts + 1;
      if (fails >= MAX_FAILS) {
        const lockCount = user.lock_count + 1;
        const mins = Math.min(BASE_LOCK_MIN * 2 ** (lockCount - 1), 24 * 60);
        db.prepare('UPDATE users SET failed_attempts = 0, lock_count = ?, locked_until = ? WHERE id = ?').run(
          lockCount,
          now + mins * 60000,
          user.id
        );
        return res.status(429).json({ error: `Too many wrong passwords. This account is locked for ${mins} minutes.` });
      }
      db.prepare('UPDATE users SET failed_attempts = ? WHERE id = ?').run(fails, user.id);
      return res.status(401).json({ error: 'Wrong username/email or password.' });
    }

    db.prepare('UPDATE users SET failed_attempts = 0, lock_count = 0, locked_until = 0 WHERE id = ?').run(user.id);
    setSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('login', e.message);
    res.status(500).json({ error: 'Could not sign in.' });
  }
});

app.post('/api/auth/google', authLimiter, async (req, res) => {
  try {
    if (!googleClient) return res.status(501).json({ error: 'Google sign-in is not set up.' });
    const { credential } = req.body || {};
    if (typeof credential !== 'string' || credential.length > 4096) return res.status(400).json({ error: 'Bad request.' });

    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    const p = ticket.getPayload();
    if (!p || !p.email || !p.email_verified || !p.sub) return res.status(401).json({ error: 'Google account not verified.' });

    const email = p.email.toLowerCase();
    let user = db.prepare('SELECT * FROM users WHERE google_id = ?').get(p.sub);
    if (!user) {
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
      if (user) {
        db.prepare('UPDATE users SET google_id = ? WHERE id = ?').run(p.sub, user.id);
      } else {
        const info = db
          .prepare('INSERT INTO users (username, email, google_id, username_set, created_at) VALUES (?, ?, ?, 0, ?)')
          .run(freeUsername(email), email, p.sub, Date.now());
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      }
    }
    setSession(res, user);
    res.json({ user: publicUser(user) });
  } catch (e) {
    console.error('google', e.message);
    res.status(401).json({ error: 'Google sign-in failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie(COOKIE, { path: '/' });
  res.json({ ok: true });
});

app.post('/api/me/username', requireAuth, (req, res) => {
  const { username } = req.body || {};
  if (typeof username !== 'string' || !USERNAME_RE.test(username))
    return res.status(400).json({ error: 'Username must be 6-20 characters: letters, numbers or underscore.' });
  const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, req.user.id);
  if (taken) return res.status(409).json({ error: 'That username is already taken.' });
  db.prepare('UPDATE users SET username = ?, username_set = 1 WHERE id = ?').run(username, req.user.id);
  res.json({ user: publicUser(db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id)) });
});

/* ------------------------------ chats ------------------------------ */
app.get('/api/chats', requireAuth, (req, res) => {
  const chats = db
    .prepare('SELECT id, title, updated_at AS updatedAt FROM chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 100')
    .all(req.user.id);
  res.json({ chats });
});

app.get('/api/chats/:id', requireAuth, (req, res) => {
  const chat = db.prepare('SELECT id, title FROM chats WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!chat) return res.status(404).json({ error: 'Chat not found.' });
  const rows = db.prepare('SELECT role, content, files FROM messages WHERE chat_id = ? ORDER BY id').all(chat.id);
  res.json({ chat, messages: rows.map((m) => ({ role: m.role, content: m.content, files: JSON.parse(m.files) })) });
});

app.delete('/api/chats/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM chats WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

/* ------------------------------ AI chat ------------------------------ */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 5 } });

const TEXT_EXT = new Set([
  '.txt', '.md', '.csv', '.tsv', '.json', '.xml', '.yaml', '.yml', '.log', '.ini', '.toml', '.env',
  '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.c', '.h', '.cpp', '.cs', '.go', '.rs', '.php',
  '.rb', '.swift', '.kt', '.sql', '.sh', '.html', '.css', '.scss', '.vue', '.lua', '.dart', '.r'
]);

function sniffImage(b) {
  if (b.length > 12) {
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
    if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.toString('ascii', 0, 4) === 'GIF8') return 'image/gif';
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  }
  return null;
}

const SYSTEM_PROMPT = `You are PABTME.ai, the assistant of the PABTME.ai community (AI, coding, technology, creativity and digital projects). Slogan: Build. Create. Connect.
You are a friendly, capable general-purpose assistant: answer questions on any topic, write and debug code, explain things, brainstorm, translate, analyze files and photos, and help people build projects.
Be clear, direct and warm. Reply in the language the user writes in. Use Markdown, and put code in fenced code blocks with the language name. Be honest when you are unsure. You still decline requests that would seriously harm people.`;

app.post('/api/chat', requireAuth, chatLimiter, upload.array('files', 5), async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) return res.status(503).json({ error: 'The AI is not configured yet (missing API key).' });

    const text = String(req.body.message || '').trim().slice(0, 20000);
    const files = req.files || [];
    if (!text && !files.length) return res.status(400).json({ error: 'Write a message or attach a file.' });

    // Build content blocks for this turn.
    const blocks = [];
    const fileNames = [];
    for (const f of files) {
      const name = path.basename(f.originalname || 'file').slice(0, 120);
      const ext = path.extname(name).toLowerCase();
      const img = sniffImage(f.buffer);
      if (img) {
        if (f.size > 5 * 1024 * 1024) return res.status(400).json({ error: `${name}: images must be under 5 MB.` });
        blocks.push({ type: 'image', source: { type: 'base64', media_type: img, data: f.buffer.toString('base64') } });
      } else if (f.buffer.toString('ascii', 0, 5) === '%PDF-') {
        blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.buffer.toString('base64') } });
      } else if (TEXT_EXT.has(ext) && !f.buffer.includes(0)) {
        const body = f.buffer.toString('utf8').slice(0, 100000);
        blocks.push({ type: 'text', text: `File "${name}":\n\`\`\`\n${body}\n\`\`\`` });
      } else {
        return res.status(400).json({ error: `${name}: unsupported file type. Use images, PDF, or text/code files.` });
      }
      fileNames.push(name);
    }
    blocks.push({ type: 'text', text: text || 'Please look at the attached file(s) and tell me what is in them.' });

    // Chat + history.
    let chatId = typeof req.body.chatId === 'string' ? req.body.chatId : '';
    let chat = chatId ? db.prepare('SELECT * FROM chats WHERE id = ? AND user_id = ?').get(chatId, req.user.id) : null;
    if (chatId && !chat) return res.status(404).json({ error: 'Chat not found.' });
    const history = chat
      ? db.prepare('SELECT role, content FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 20').all(chat.id).reverse()
      : [];
    const messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: blocks }];

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4096, system: SYSTEM_PROMPT, messages }),
      signal: AbortSignal.timeout(120000)
    });
    if (!r.ok) {
      console.error('anthropic', r.status, (await r.text()).slice(0, 300));
      return res.status(502).json({ error: 'The AI is busy right now. Try again in a moment.' });
    }
    const data = await r.json();
    const reply = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim() || '...';

    const now = Date.now();
    if (!chat) {
      chatId = crypto.randomUUID();
      const title = (text || fileNames[0] || 'New chat').replace(/\s+/g, ' ').slice(0, 48);
      db.prepare('INSERT INTO chats (id, user_id, title, updated_at) VALUES (?, ?, ?, ?)').run(chatId, req.user.id, title, now);
      chat = { id: chatId, title };
    }
    const ins = db.prepare('INSERT INTO messages (chat_id, role, content, files, created_at) VALUES (?, ?, ?, ?, ?)');
    ins.run(chat.id, 'user', text || '(attachment)', JSON.stringify(fileNames), now);
    ins.run(chat.id, 'assistant', reply, '[]', now + 1);
    db.prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(now, chat.id);

    res.json({ chatId: chat.id, title: chat.title, reply });
  } catch (e) {
    console.error('chat', e.message);
    res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
});

/* ------------------------------ static + errors ------------------------------ */
app.use(express.static(path.join(__dirname, 'public'), { maxAge: PROD ? '1h' : 0 }));

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === 'LIMIT_FILE_SIZE' ? 'Each file must be under 10 MB.' : 'You can attach up to 5 files.';
    return res.status(400).json({ error: msg });
  }
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Bad request.' });
  console.error(err.message);
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, () => console.log(`PABTME.ai running on http://localhost:${PORT}`));
