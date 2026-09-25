// Правила слияния из index.html (тот же код исполняется в браузере).
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSite } from "./helpers.js";

const site = getSite();
const clone = (x) => JSON.parse(JSON.stringify(x));

function rows(...projects) {
  const arr = projects.map((p, i) => ({ num: String(i + 1), project: p, status: "Новая" }));
  site.ensureRowIds("projects-actiontasks", arr);
  return arr;
}

test("ID строк детерминированы: браузер и MCP получают одинаковые", () => {
  const a = rows("A", "B");
  const b = rows("A", "B");
  assert.deepEqual(a.map((r) => r._rid), b.map((r) => r._rid));
  assert.notEqual(a[0]._rid, a[1]._rid);
});

test("одинаковые строки получают разные ID", () => {
  const arr = [{ project: "X" }, { project: "X" }];
  site.ensureRowIds("k", arr);
  assert.notEqual(arr[0]._rid, arr[1]._rid);
});

test("колонки (есть id) не трогаются", () => {
  const cols = [{ id: "num", label: "№" }];
  assert.equal(site.ensureRowIds("projects-columns", cols), false);
  assert.equal(cols[0]._rid, undefined);
});

test("правки разных полей одной строки сохраняются обе", () => {
  const base = rows("A", "B");
  const local = clone(base); local[0].status = "В работе";
  const remote = clone(base); remote[0].comment = "от Коворка";
  const merged = site.merge3(base, local, remote);
  assert.equal(merged[0].status, "В работе");
  assert.equal(merged[0].comment, "от Коворка");
});

test("новые строки с обеих сторон не теряются", () => {
  const base = rows("A");
  const local = clone(base); local.push({ _rid: "n1", project: "Local new" });
  const remote = clone(base); remote.push({ _rid: "n2", project: "Remote new" });
  const merged = site.merge3(base, local, remote);
  assert.deepEqual(merged.map((r) => r.project), ["A", "Remote new", "Local new"]);
});

test("удаление строки одной стороной и правка другой строки другой стороной", () => {
  const base = rows("A", "B", "C");
  const local = clone(base).filter((r) => r.project !== "B");
  const remote = clone(base); remote[2].status = "Завершена";
  const merged = site.merge3(base, local, remote);
  assert.deepEqual(merged.map((r) => r.project), ["A", "C"]);
  assert.equal(merged[1].status, "Завершена");
});

test("конфликт в одном поле: побеждает сохраняющий (local)", () => {
  const base = rows("A");
  const local = clone(base); local[0].status = "ПМИ";
  const remote = clone(base); remote[0].status = "Завершена";
  assert.equal(site.merge3(base, local, remote)[0].status, "ПМИ");
});

test("задачи недели (массив с id) сливаются по id", () => {
  const base = rows("A");
  base[0].planning = { "2026-09-22": [{ id: "t1", title: "one", status: "not_started" }] };
  const local = clone(base);
  local[0].planning["2026-09-22"].push({ id: "t2", title: "local", status: "progress" });
  const remote = clone(base);
  remote[0].planning["2026-09-22"][0].status = "done";
  remote[0].planning["2026-09-23"] = [{ id: "t3", title: "remote", status: "not_started" }];
  const merged = site.merge3(base, local, remote);
  const day1 = merged[0].planning["2026-09-22"];
  assert.deepEqual(day1.map((t) => [t.id, t.status]), [["t1", "done"], ["t2", "progress"]]);
  assert.equal(merged[0].planning["2026-09-23"][0].id, "t3");
});

test("ответы опросника в разных полях сливаются", () => {
  const base = rows("A");
  const local = clone(base); local[0].questionnaire = { pak: { gigachat: { os: { answer: "RedOS 8" } } } };
  const remote = clone(base); remote[0].questionnaire = { pak: { gigachat: { gpu: { answer: "8xH200" } } } };
  const merged = site.merge3(base, local, remote);
  assert.equal(merged[0].questionnaire.pak.gigachat.os.answer, "RedOS 8");
  assert.equal(merged[0].questionnaire.pak.gigachat.gpu.answer, "8xH200");
});

test("перестановка строк локально сохраняет порядок, чужие новые строки вставляются рядом", () => {
  const base = rows("A", "B", "C");
  const local = [clone(base[2]), clone(base[0]), clone(base[1])];
  const remote = clone(base); remote.push({ _rid: "n9", project: "D" });
  const merged = site.merge3(base, local, remote);
  assert.deepEqual(merged.map((r) => r.project), ["C", "A", "B", "D"]);
});
