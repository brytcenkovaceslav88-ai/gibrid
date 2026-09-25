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
  app.post("/mcp", authMiddleware, handle);
  app.get("/mcp", authMiddleware, handle);
  app.delete("/mcp", authMiddleware, handle);
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
