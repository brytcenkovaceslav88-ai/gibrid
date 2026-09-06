import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

// ---- Подключение к Postgres ----
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

const JWT_SECRET = process.env.BETTER_AUTH_SECRET;
const COOKIE_NAME = "pmo_session";

// ---- Схема БД ----
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      is_admin BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

function signToken(user) {
  return jwt.sign({ sub: user.id }, JWT_SECRET, { expiresIn: "30d" });
}

function setSessionCookie(req, res, token) {
  // req.secure учитывает X-Forwarded-Proto (см. app.set('trust proxy', 1) ниже),
  // поэтому cookie получает Secure только когда соединение реально по HTTPS —
  // иначе браузер молча отбрасывает такую cookie на обычном HTTP и вход
  // выглядит так, будто сессия не сохраняется.
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: req.secure,
    maxAge: 30 * 24 * 60 * 60 * 1000
  });
}

async function getUserFromReq(req) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  if (!token) return null;
  let payload;
  try {
    payload = jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
  const { rows } = await pool.query(
    "SELECT id, email, status, is_admin FROM users WHERE id = $1",
    [payload.sub]
  );
  return rows[0] || null;
}

async function requireActiveUser(req, res, next) {
  const user = await getUserFromReq(req);
  if (!user || user.status !== "active") return res.status(401).json({ error: "unauthorized" });
  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  const user = await getUserFromReq(req);
  if (!user || user.status !== "active" || !user.is_admin) {
    return res.status(403).json({ error: "forbidden" });
  }
  req.user = user;
  next();
}

function publicUser(u) {
  return { email: u.email, status: u.status, isAdmin: u.is_admin };
}

// ---- Express-приложение ----
const app = express();
app.set("trust proxy", 1); // чтобы req.secure учитывал X-Forwarded-Proto от nginx
app.use(cors({ origin: process.env.BETTER_AUTH_URL, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- Авторизация: регистрация ждёт подтверждения администратора ----
// Первый зарегистрированный пользователь автоматически становится
// администратором и активируется сразу (иначе некому было бы подтверждать
// остальных).
app.post("/api/auth/register", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password || String(password).length < 6) {
    return res.status(400).json({ error: "invalid_input" });
  }
  const normEmail = String(email).trim().toLowerCase();
  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [normEmail]);
  if (existing.rows.length) return res.status(409).json({ error: "email_taken" });

  const { rows: countRows } = await pool.query("SELECT count(*)::int AS c FROM users");
  const isFirstUser = countRows[0].c === 0;
  const passwordHash = await bcrypt.hash(password, 10);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, status, is_admin)
     VALUES ($1, $2, $3, $4) RETURNING id, email, status, is_admin`,
    [normEmail, passwordHash, isFirstUser ? "active" : "pending", isFirstUser]
  );
  const user = rows[0];
  if (isFirstUser) setSessionCookie(req, res, signToken(user));
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "invalid_input" });
  const normEmail = String(email).trim().toLowerCase();
  const { rows } = await pool.query(
    "SELECT id, email, password_hash, status, is_admin FROM users WHERE email = $1",
    [normEmail]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  if (user.status === "blocked") return res.status(403).json({ error: "blocked" });
  if (user.status === "pending") return res.status(403).json({ error: "pending" });
  setSessionCookie(req, res, signToken(user));
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/auth/me", async (req, res) => {
  const user = await getUserFromReq(req);
  res.json({ user: user ? publicUser(user) : null });
});

// ---- Администрирование пользователей ----
app.get("/api/admin/users", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "SELECT id, email, status, is_admin, created_at FROM users ORDER BY created_at ASC"
  );
  res.json({ users: rows });
});

app.post("/api/admin/users/:id/status", requireAdmin, async (req, res) => {
  const { status } = req.body || {};
  if (!["active", "pending", "blocked"].includes(status)) {
    return res.status(400).json({ error: "invalid_status" });
  }
  await pool.query("UPDATE users SET status = $1 WHERE id = $2", [status, req.params.id]);
  res.json({ ok: true });
});

app.post("/api/admin/users/:id/password", requireAdmin, async (req, res) => {
  const { password } = req.body || {};
  if (!password || String(password).length < 6) {
    return res.status(400).json({ error: "invalid_password" });
  }
  const passwordHash = await bcrypt.hash(password, 10);
  await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2", [passwordHash, req.params.id]);
  res.json({ ok: true });
});

app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) {
    return res.status(400).json({ error: "cannot_delete_self" });
  }
  await pool.query("DELETE FROM users WHERE id = $1", [targetId]);
  res.json({ ok: true });
});

// ---- Общее хранилище данных таблиц (реестры, проекты, требования и т.д.) ----
// Доступно только активным пользователям — гейт на фронтенде дублируется
// здесь, чтобы данные нельзя было прочитать/изменить в обход интерфейса.
app.get("/api/data/:key", requireActiveUser, async (req, res) => {
  const { rows } = await pool.query("SELECT value FROM kv_store WHERE key = $1", [req.params.key]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  res.json({ value: rows[0].value });
});

app.put("/api/data/:key", requireActiveUser, async (req, res) => {
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, "value")) {
    return res.status(400).json({ error: "missing_value" });
  }
  await pool.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [req.params.key, JSON.stringify(req.body.value)]
  );
  res.json({ ok: true });
});

app.delete("/api/data/:key", requireActiveUser, async (req, res) => {
  await pool.query("DELETE FROM kv_store WHERE key = $1", [req.params.key]);
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
ensureSchema()
  .then(() => app.listen(PORT, () => console.log(`Backend listening on :${PORT}`)))
  .catch((err) => {
    console.error("Failed to initialize database schema", err);
    process.exit(1);
  });
