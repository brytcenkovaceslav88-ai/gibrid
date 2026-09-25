import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  getSite, resetDb, putKey, getKey, legacyProjects, startServer, connectClient, call, closePool, addDaysIso
} from "./helpers.js";
import { normalizeRowIds } from "../src/store.js";
import { mondayOf, todayIso } from "../src/model.js";

let srv, client, projectName;
const site = getSite();
const monday = mondayOf(todayIso());

before(async () => {
  await resetDb();
  const { oilgas, actions, ultramarName } = legacyProjects(site, monday);
  projectName = ultramarName;
  await putKey("projects-oilgas", oilgas, 3);
  await putKey("projects-actiontasks", actions, 7);
  await putKey("theme-preference", "light", 1);
  // Как при старте сервера: старые строки получают детерминированные _rid.
  await normalizeRowIds(site.ensureRowIds);
  srv = await startServer();
  client = await connectClient(srv.url);
});

after(async () => {
  await client?.close();
  await srv?.close();
  await closePool();
});

test("без ключа и с неверным ключом — 401", async () => {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  let res = await fetch(`${srv.url}/mcp`, { method: "POST", headers, body });
  assert.equal(res.status, 401);
  res = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { ...headers, "X-Api-Key": "wrong" }, body });
  assert.equal(res.status, 401);
  res = await fetch(`${srv.url}/mcp`, { method: "POST", headers: { ...headers, Authorization: "Bearer second-key-2222" }, body });
  assert.equal(res.status, 200);
});

test("health", async () => {
  const res = await fetch(`${srv.url}/health`);
  assert.equal(res.status, 200);
});

test("tools/list: все инструменты с русскими описаниями и аннотациями, удаления нет", async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [
    "add_week_task", "create_project", "find_migrations", "find_projects", "find_questionnaire_gaps",
    "find_requirements", "get_architecture", "get_connection_details", "get_overview", "get_project",
    "get_project_stats", "get_questionnaire", "get_week_tasks", "search_site", "set_questionnaire_answer",
    "update_migration", "update_project", "update_requirement", "update_week_task"
  ]);
  for (const t of tools) {
    assert.match(t.description, /[а-я]/i, t.name);
    assert.equal(typeof t.annotations.readOnlyHint, "boolean", t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
  }
  assert.ok(!names.some((n) => n.startsWith("delete")));
});

test("get_overview", async () => {
  const r = await call(client, "get_overview");
  assert.equal(r["проекты"]["всего"], 8);
  assert.equal(r["задачи_на_текущей_неделе"]["всего"], 2);
});

test("find_projects: статус «в работе» и фильтр по продукту", async () => {
  const r = await call(client, "find_projects", { status: "в работе" });
  assert.equal(r["всего"], 1);
  assert.equal(r["проекты"][0]["проект"], projectName);
  assert.match(r["проекты"][0]["опросник"], /^7\/\d+$/);
  const pak = await call(client, "find_projects", { product: "пак" });
  assert.equal(pak["всего"], 2); // Гранель и НИИгазэкономика
});

test("find_projects: пагинация", async () => {
  const r = await call(client, "find_projects", { limit: 3 });
  assert.equal(r["показано"], 3);
  assert.equal(r["следующий_offset"], 3);
  const r2 = await call(client, "find_projects", { limit: 3, offset: 6 });
  assert.equal(r2["показано"], 2);
});

test("get_project: поля, опросник, задачи", async () => {
  const r = await call(client, "get_project", { project: "гранель" });
  assert.equal(r["Клиент / проект"], projectName);
  assert.equal(r["опросник"]["опросник"], "ПАК");
  assert.equal(r["задачи_по_неделям"].length, 2);
});

test("неоднозначное название — понятная ошибка", async () => {
  const r = await call(client, "get_project", { project: "ООО" });
  assert.match(r.error, /несколько/);
});

test("get_questionnaire: вкладка «Интеграция»", async () => {
  const r = await call(client, "get_questionnaire", { project: projectName, tab: "Интеграция" });
  assert.equal(r["вкладки"].length, 1);
  const fields = r["вкладки"][0]["разделы"][0]["поля"];
  const api = fields.find((f) => f["код"] === "integration.api");
  assert.equal(api["комментарий"], "Планируют Lite LLM");
});

test("get_connection_details: доступы из опросника и серверы из задач", async () => {
  const r = await call(client, "get_connection_details", {});
  assert.equal(r["проектов"], 1);
  const p = r["проекты"][0];
  assert.equal(p["данные_для_подключения"]["Доступ в контур заказчика"], "RDP");
  assert.equal(p["данные_для_подключения"]["Доступ в BMC"], "bmc-admin/secret-bmc — через jump");
  assert.equal(p["серверы_из_задач"][0]["сервер"], "srv-gpu-01");
});

test("find_questionnaire_gaps", async () => {
  const r = await call(client, "find_questionnaire_gaps", { project: projectName });
  assert.ok(r["проекты"][0]["не_заполнены_обязательные"].length > 0);
});

test("get_week_tasks: текущая неделя и фильтр статуса", async () => {
  const r = await call(client, "get_week_tasks", {});
  assert.equal(r["итого"]["всего"], 2);
  assert.equal(r["итого"]["В работе"], 1);
  const inWork = await call(client, "get_week_tasks", { status: "в работе" });
  assert.equal(inWork["итого"]["всего"], 1);
  const next = await call(client, "get_week_tasks", { week: "следующая" });
  assert.equal(next["итого"]["всего"], 0);
});

test("get_project_stats", async () => {
  const r = await call(client, "get_project_stats", { group_by: "product" });
  assert.equal(r["группы"]["ПАК"]["количество"], 2);
});

test("find_requirements / find_migrations / get_architecture / search_site", async () => {
  const req = await call(client, "find_requirements", { query: "MCP" });
  assert.ok(req["всего"] >= 1);
  const mig = await call(client, "find_migrations", { product: "ПАК", limit: 50 });
  assert.equal(mig["всего"], site.views.registry.sectionDefaults.pak.length);
  const arch = await call(client, "get_architecture", { query: "Keycloak" });
  assert.ok(arch["найдено_строк"] >= 1);
  const s = await call(client, "search_site", { query: "srv-gpu-01" });
  assert.equal(s["результаты"][0]["где"], "Задачи по неделям");
});

test("update_project меняет поля и повышает версию ключа (сайт увидит конфликт)", async () => {
  const before = await getKey("projects-actiontasks");
  const r = await call(client, "update_project", { project: projectName, status: "ПМИ", deadline: "2026-10-15", comment: "Из Коворка", comment_mode: "append" });
  assert.equal(r["сейчас"]["статус"], "ПМИ");
  assert.equal(r["сейчас"]["срок"], "15.10.2026");
  const after = await getKey("projects-actiontasks");
  assert.equal(after.version, before.version + 1);
  const row = after.value.find((x) => x.project === projectName);
  assert.equal(row.status, "ПМИ");
  assert.ok(row._rid);
});

test("update_project: неверный приоритет — ошибка без изменений", async () => {
  const before = await getKey("projects-actiontasks");
  const r = await call(client, "update_project", { project: projectName, priority: "Супер" });
  assert.match(r.error, /Приоритет/);
  assert.equal((await getKey("projects-actiontasks")).version, before.version);
});

test("create_project: в «Активные задачи», с новым номером и id", async () => {
  const r = await call(client, "create_project", { project: "ООО Тест Коворк", product: "Гибрид", priority: "высокий" });
  assert.equal(r["создан"]["№"], "9");
  assert.equal(r["создан"]["приоритет"], "Высокий");
  const dup = await call(client, "create_project", { project: "ООО Тест Коворк" });
  assert.match(dup.error, /уже есть/);
});

test("set_questionnaire_answer: проверка вариантов и запись", async () => {
  const bad = await call(client, "set_questionnaire_answer", { project: projectName, field: "gigachat.os", answer: "Windows" });
  assert.match(bad.error, /допустимы варианты/);
  const ok = await call(client, "set_questionnaire_answer", { project: projectName, field: "Доступ в контур заказчика", answer: "ssh+vpn", comment: "через OpenVPN" });
  assert.equal(ok["стало"].answer, "SSH+VPN");
  const q = await call(client, "get_connection_details", { project: projectName });
  assert.equal(q["проекты"][0]["данные_для_подключения"]["Доступ в контур заказчика"], "SSH+VPN — через OpenVPN");
});

test("add_week_task / update_week_task, неделя появляется в колонках", async () => {
  const nextMonday = addDaysIso(monday, 14);
  const r = await call(client, "add_week_task", { project: projectName, date: nextMonday, title: "Настройка SMTP", server: "mail-01", status: "в работе" });
  assert.equal(r["добавлена"]["статус"], "В работе");
  const weeks = (await getKey("projects-planningweeks")).value.map((w) => w.start);
  assert.ok(weeks.includes(nextMonday));
  assert.ok(weeks.includes(addDaysIso(monday, 7)), "промежуточная неделя тоже добавлена");
  const weekend = await call(client, "add_week_task", { project: projectName, date: addDaysIso(monday, 5), title: "x" });
  assert.match(weekend.error, /выходной/);
  const id = r["добавлена"].id;
  const upd = await call(client, "update_week_task", { task_id: id, status: "Закрыто", new_date: addDaysIso(nextMonday, 1) });
  assert.equal(upd["задача"]["статус"], "Закрыто");
  assert.equal(upd["задача"]["день"], "вт");
});

test("update_requirement и update_migration создают ключи со значениями по умолчанию", async () => {
  const req = await call(client, "update_requirement", { requirement: "Поддержка MCP", compliance: "3", comment: "Проверено" });
  assert.equal(req["требование"]["Соответствие"], "3");
  const items = (await getKey("requirements-items")).value;
  assert.equal(items.length, site.views.requirements.sectionDefaults.items.length);
  const mig = await call(client, "update_migration", { entry: "Ультрамар", product: "ПАК", status: "в работе", end_date: "2026-11-30" });
  assert.equal(mig["запись"]["Статус миграции"], "В работе");
  assert.equal(mig["запись"]["Плановая дата завершения"], "30.11.2026");
});

test("параллельные записи MCP не теряют правки друг друга", async () => {
  const titles = Array.from({ length: 8 }, (_, i) => `Параллельная ${i}`);
  await Promise.all(titles.map((t) => call(client, "add_week_task", { project: projectName, date: addDaysIso(monday, 3), title: t })));
  const w = await call(client, "get_week_tasks", { project: projectName });
  const names = w["проекты"][0]["задачи"].map((t) => t["название"]);
  for (const t of titles) assert.ok(names.includes(t), t);
});
