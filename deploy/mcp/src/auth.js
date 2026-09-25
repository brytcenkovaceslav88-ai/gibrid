import crypto from "node:crypto";
import { config } from "./config.js";

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Возвращает { key, source } с предъявленным ключом или null.
export function extractKey(headers) {
  for (const name of config.authHeaders) {
    const v = headers[name];
    if (typeof v === "string" && v.trim()) return { key: v.trim(), source: name };
  }
  const auth = headers.authorization;
  if (typeof auth === "string") {
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim()) return { key: m[1].trim(), source: "authorization" };
  }
  return null;
}

export function isValidKey(key) {
  return config.apiKeys.some((k) => safeEqual(k, key));
}

// Для логов: только последние 4 символа ключа.
export function maskKey(key) {
  return key ? `…${key.slice(-4)}` : "-";
}

export function authMiddleware(req, res, next) {
  const found = extractKey(req.headers);
  if (!found || !isValidKey(found.key)) {
    return res.status(401).json({
      error: "unauthorized",
      message: found
        ? "Неверный ключ доступа к коннектору PMO. Проверьте ключ в настройках коннектора Коворка."
        : "Не передан ключ доступа к коннектору PMO (заголовок X-Api-Key)."
    });
  }
  req.pmoCaller = maskKey(found.key);
  next();
}
