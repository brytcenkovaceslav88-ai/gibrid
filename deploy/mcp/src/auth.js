import crypto from "node:crypto";
import { config } from "./config.js";

function safeEqual(a, b) {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Заголовки, в которых разные клиенты передают ключ/токен.
const EXTRA_KEY_HEADERS = ["x-api-key", "api-key", "apikey", "x-auth-token", "x-access-token", "token", "access-token", "x-token"];
const QUERY_KEY_PARAMS = ["api_key", "apikey", "key", "token", "access_token"];

// Возвращает { key, source } с предъявленным ключом или null.
// Коворк в режиме «Токен доступа» может прислать «Authorization: Bearer …»,
// «Authorization: Token …» или просто «Authorization: …»; в режиме
// «Пользовательские заголовки» — заголовок с любым из имён выше.
export function extractKey(headers, query = {}) {
  for (const name of [...config.authHeaders, ...EXTRA_KEY_HEADERS]) {
    const v = headers[name];
    if (typeof v === "string" && v.trim()) return { key: stripScheme(v), source: name };
  }
  const auth = headers.authorization;
  if (typeof auth === "string" && auth.trim()) return { key: stripScheme(auth), source: "authorization" };
  for (const name of QUERY_KEY_PARAMS) {
    const v = query && query[name];
    if (typeof v === "string" && v.trim()) return { key: v.trim(), source: `query:${name}` };
  }
  return null;
}

function stripScheme(value) {
  const v = value.trim();
  const m = v.match(/^(?:Bearer|Token|Api-Key|ApiKey|Key)\s+(.+)$/i);
  return (m ? m[1] : v).trim();
}

// Для диагностики: имена заголовков, похожих на авторизационные (без значений).
export function authHeaderNames(headers) {
  return Object.keys(headers).filter((h) => /auth|key|token/i.test(h));
}

export function isValidKey(key) {
  return config.apiKeys.some((k) => safeEqual(k, key));
}

// Для логов: только последние 4 символа ключа.
export function maskKey(key) {
  return key ? `…${key.slice(-4)}` : "-";
}

export function authMiddleware(req, res, next) {
  const found = extractKey(req.headers, req.query);
  if (found && !isValidKey(found.key)) {
    // Ключ не совпал: пробуем остальные места, вдруг клиент прислал его в нескольких.
    const alt = [...config.authHeaders, ...EXTRA_KEY_HEADERS, "authorization"]
      .map((h) => req.headers[h]).filter((v) => typeof v === "string").map(stripScheme);
    const ok = alt.find((k) => isValidKey(k));
    if (ok) { req.pmoCaller = maskKey(ok); return next(); }
  }
  if (!found || !isValidKey(found.key)) {
    req.pmoAuthFail = {
      reason: found ? "wrong_key" : "no_key",
      source: found ? found.source : undefined,
      key_len: found ? found.key.length : undefined,
      auth_headers: authHeaderNames(req.headers)
    };
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
