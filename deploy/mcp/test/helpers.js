// Тесты гоняются на отдельной базе: TEST_DATABASE_URL=postgres://… npm test
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || "postgres://pmo@127.0.0.1:55432/pmo";
process.env.INDEX_HTML_PATH = process.env.INDEX_HTML_PATH || path.resolve(here, "../../../index.html");
process.env.MCP_API_KEYS = "test-key-1111,second-key-2222";
process.env.AUTH_HEADERS = "x-api-key";

const { getPool, ensureVersionColumn, closePool } = await import("../src/store.js");
const { getSite } = await import("../src/site.js");
const { createApp } = await import("../src/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");

export { getPool, getSite, closePool };

export async function resetDb() {
  await ensureVersionColumn();
  await getPool().query("DELETE FROM kv_store");
}

export async function putKey(key, value, version = 1) {
  await getPool().query(
    "INSERT INTO kv_store (key, value, version) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = $2, version = $3",
    [key, JSON.stringify(value), version]
  );
}

export async function getKey(key) {
  const { rows } = await getPool().query("SELECT value, version FROM kv_store WHERE key = $1", [key]);
  return rows[0] ? { value: rows[0].value, version: Number(rows[0].version) } : null;
}

// Данные, похожие на боевые: строки без _rid (как до этой доработки),
// опросник ПАК у одного проекта, задачи в колонках недель.
export function legacyProjects(site, weekMonday) {
  const clone = (x) => JSON.parse(JSON.stringify(x));
  const oilgas = clone(site.views.projects.sectionDefaults.oilgas).slice(0, 3);
  const actions = clone(site.views.projects.sectionDefaults.actiontasks).slice(0, 5);
  for (const r of [...oilgas, ...actions]) for (const c of site.views.projects.excludeColumns) delete r[c];
  const ultramar = actions.find((r) => r.project.includes("Гранель")) || actions[2];
  ultramar.product = "ПАК";
  ultramar.status = "В работе";
  ultramar.questionnaire = {
    pak: {
      gigachat: {
        os: { answer: "SberLinux 8.10.15" },
        access: { answer: "RDP" },
        bmc_access: { answer: "bmc-admin/secret-bmc", comment: "через jump" },
        client_domain: { answer: "gigachat.client.ru" },
        gpu: { answer: "8xH200" }
      },
      integration: { smtp: { answer: "Нет" }, api: { answer: "Нет", comment: "Планируют Lite LLM" } }
    }
  };
  const tue = addDaysIso(weekMonday, 1);
  const wed = addDaysIso(weekMonday, 2);
  ultramar.planning = {
    [tue]: [{ id: "pt-a", title: "Установка ОС", description: "", server: "srv-gpu-01", status: "progress", timeUnit: "days", timeValue: "1" }],
    [wed]: [{ id: "pt-b", title: "Интеграция SMTP", description: "проверить почту", server: "", status: "not_started", timeUnit: "hours", timeValue: "4" }]
  };
  return { oilgas, actions, ultramarName: ultramar.project };
}

export function addDaysIso(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export async function startServer() {
  const app = createApp();
  const server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, close: () => new Promise((r) => server.close(r)) };
}

export async function connectClient(url, key = "test-key-1111") {
  const client = new Client({ name: "test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { "X-Api-Key": key } }
  });
  await client.connect(transport);
  return client;
}

export async function call(client, name, args = {}) {
  const res = await client.callTool({ name, arguments: args });
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) return { error: text };
  return JSON.parse(text);
}
