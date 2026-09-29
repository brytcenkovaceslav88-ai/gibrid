import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { config } from "./config.js";
import { authMiddleware } from "./auth.js";
import { getSite } from "./site.js";
import { ensureVersionColumn, normalizeRowIds, getPool } from "./store.js";
import { registerTools, SERVER_INSTRUCTIONS } from "./tools.js";

function log(entry) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
}

function buildMcpServer(caller) {
  const server = new McpServer(
    { name: "pmo-gigaenterprise", version: "1.0.0" },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerTools(server, (e) => log({ caller, ...e }));
  return server;
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "2mb" }));

  // Журнал обращений к /mcp: метод, код ответа, клиент. Ключ не пишется —
  // только его последние 4 символа (req.pmoCaller), если он верный.
  app.use("/mcp", (req, res, next) => {
    const started = Date.now();
    res.on("finish", () => log({
      status: "request",
      method: req.method,
      rpc: req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body.method : undefined,
      code: res.statusCode,
      ms: Date.now() - started,
      caller: req.pmoCaller || "-",
      auth: req.pmoAuthFail,
      ip: req.ip,
      ua: String(req.headers["user-agent"] || "").slice(0, 120)
    }));
    next();
  });

  app.get("/health", async (req, res) => {
    try {
      await getPool().query("SELECT 1");
      getSite();
      res.json({ status: "ok" });
    } catch (err) {
      res.status(503).json({ status: "error", message: String(err.message || err) });
    }
  });

  // Stateless: на каждый запрос — свой сервер и транспорт, без сессий, поэтому
  // любой запрос может обслужить любой экземпляр.
  const handle = async (req, res) => {
    // Часть клиентов шлёт «Accept: application/json» без text/event-stream —
    // SDK на такое отвечает 406. Ответ у нас всё равно JSON, так что
    // принимаем любой Accept.
    const accept = String(req.headers.accept || "");
    if (!accept.includes("application/json") || !accept.includes("text/event-stream")) {
      req.headers.accept = "application/json, text/event-stream";
    }
    const server = buildMcpServer(req.pmoCaller);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log({ caller: req.pmoCaller, status: "transport_error", error: String(err && err.stack || err) });
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Внутренняя ошибка сервера" }, id: null });
      }
    }
  };
  // Сервер без сессий: потока уведомлений (GET) и закрытия сессии (DELETE)
  // нет. По спецификации Streamable HTTP на это отвечают 405 — клиент
  // тогда просто работает через POST.
  const notAllowed = (req, res) => {
    res.set("Allow", "POST").status(405).json({
      jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: используйте POST" }, id: null
    });
  };
  app.post("/mcp", authMiddleware, handle);
  app.get("/mcp", notAllowed);
  app.delete("/mcp", notAllowed);
  return app;
}

async function main() {
  if (!config.apiKeys.length) {
    console.error("MCP_API_KEYS не задан — без ключа коннектор никого не пустит. Задайте ключ в .env.");
  }
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureVersionColumn();
      break;
    } catch (err) {
      if (attempt >= 30) throw err;
      log({ status: "db_not_ready", attempt, error: err.code || err.message });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  const site = getSite();
  const normalized = await normalizeRowIds(site.ensureRowIds);
  log({ status: "startup", normalized_keys: normalized });
  createApp().listen(config.port, () => log({ status: "listening", port: config.port }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("MCP server failed to start", err);
    process.exit(1);
  });
}
