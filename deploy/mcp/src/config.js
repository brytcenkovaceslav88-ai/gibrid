function list(value) {
  return String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  port: Number(process.env.PORT || 8000),
  databaseUrl: process.env.DATABASE_URL,
  // Файл сайта: из него MCP берёт справочники, данные по умолчанию, текст
  // вкладки «Архитектура» и общие правила ID строк/слияния (блок @pmo-shared).
  indexHtmlPath: process.env.INDEX_HTML_PATH || "/app/site/index.html",
  // Ключи доступа (через запятую). Коворк присылает ключ в заголовке из
  // AUTH_HEADERS («Пользовательские заголовки») или как Bearer-токен
  // («Токен доступа»).
  apiKeys: list(process.env.MCP_API_KEYS),
  authHeaders: list(process.env.AUTH_HEADERS || "x-api-key").map((h) => h.toLowerCase()),
  timeZone: process.env.TZ_NAME || "Europe/Moscow",
  logLevel: process.env.LOG_LEVEL || "info"
};
