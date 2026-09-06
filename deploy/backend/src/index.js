import "dotenv/config";
import express from "express";
import cors from "cors";
import pg from "pg";
import nodemailer from "nodemailer";
import { betterAuth } from "better-auth";
import { toNodeHandler } from "better-auth/node";

// ---- Почта (SMTP) для писем подтверждения и сброса пароля ----
const mailer = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 465),
  secure: true,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD }
});

async function sendMail(to, subject, html) {
  await mailer.sendMail({ from: process.env.SMTP_FROM, to, subject, html });
}

// ---- Подключение к Postgres ----
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

// ---- Better Auth ----
// ВАЖНО: перед первым запуском сверьте актуальную форму конфига с документацией
// https://www.better-auth.com/docs — библиотека активно развивается, названия
// колбэков/полей могли немного измениться с момента написания этого файла.
export const auth = betterAuth({
  database: pool,
  baseURL: process.env.BETTER_AUTH_URL,
  secret: process.env.BETTER_AUTH_SECRET,

  emailAndPassword: {
    enabled: true,
    requireEmailVerification: true,
    sendResetPassword: async ({ user, url }) => {
      await sendMail(
        user.email,
        "Сброс пароля — GigaCowork Enterprise",
        `<p>Здравствуйте!</p><p>Для сброса пароля перейдите по ссылке (действует 1 час):</p><p><a href="${url}">${url}</a></p>`
      );
    }
  },

  emailVerification: {
    sendVerificationEmail: async ({ user, url }) => {
      await sendMail(
        user.email,
        "Подтверждение почты — GigaCowork Enterprise",
        `<p>Здравствуйте!</p><p>Подтвердите почту, перейдя по ссылке (действует 24 часа):</p><p><a href="${url}">${url}</a></p>`
      );
    }
  }
});

// ---- Express-приложение ----
const app = express();
app.use(cors({ origin: process.env.BETTER_AUTH_URL, credentials: true }));

// Все auth-эндпоинты (регистрация/вход/подтверждение/сброс) обслуживает Better Auth
app.all("/api/auth/*", toNodeHandler(auth));

app.use(express.json({ limit: "5mb" }));

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- Общее хранилище данных таблиц (реестры, проекты, требования и т.д.) ----
// Ключ — тот же, что раньше использовался в localStorage браузера; значение —
// произвольный JSON. Общий для всех, кто открывает сайт, никакой привязки к
// пользователю (Better Auth пока используется отдельно, для входа).
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS kv_store (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

app.get("/api/data/:key", async (req, res) => {
  const { rows } = await pool.query("SELECT value FROM kv_store WHERE key = $1", [req.params.key]);
  if (!rows.length) return res.status(404).json({ error: "not_found" });
  res.json({ value: rows[0].value });
});

app.put("/api/data/:key", async (req, res) => {
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

app.delete("/api/data/:key", async (req, res) => {
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
