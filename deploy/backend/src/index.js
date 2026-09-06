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

app.use(express.json());

// Пример защищённого эндпоинта — дальше сюда переносятся данные таблиц
app.get("/api/health", (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Backend listening on :${PORT}`));
