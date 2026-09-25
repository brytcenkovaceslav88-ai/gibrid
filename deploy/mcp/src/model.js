import { config } from "./config.js";

export class UserError extends Error {}

export const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

// ---------- Вкладки: то же состояние, что строит loadController на сайте ----------

function sectionRows(site, def, key, kv) {
  const storageKey = `${def.prefix}-${key}`;
  let rows;
  if (kv.has(storageKey)) {
    rows = clone(kv.get(storageKey));
    if (!Array.isArray(rows)) rows = [];
    site.ensureRowIds(storageKey, rows);
    for (const r of rows) for (const c of def.excludeColumns) delete r[c];
  } else {
    rows = clone(def.sectionDefaults[key] || []);
    for (const r of rows) for (const c of def.excludeColumns) delete r[c];
    site.ensureRowIds(storageKey, rows);
  }
  return rows;
}

export function buildView(site, viewId, kv) {
  const def = site.views[viewId];
  const k = (s) => `${def.prefix}-${s}`;
  const deletedColumns = kv.get(k("deletedcolumns")) || [];
  const deletedSections = kv.get(k("deletedsections")) || [];

  let columns;
  if (kv.has(k("columns"))) {
    columns = clone(kv.get(k("columns")));
    const ids = new Set(columns.map((c) => c.id));
    for (const d of def.columnsDefault) {
      if (!ids.has(d.id) && !deletedColumns.includes(d.id)) columns.push(clone(d));
    }
  } else {
    columns = clone(def.columnsDefault);
  }
  columns = columns.filter((c) => !def.excludeColumns.includes(c.id));

  const titles = { ...def.titlesDefault, ...(kv.get(k("titles")) || {}) };
  let sectionKeys;
  if (kv.has(k("sectionkeys"))) {
    sectionKeys = [...kv.get(k("sectionkeys"))];
    for (const d of def.sectionKeys) {
      if (!sectionKeys.includes(d) && !deletedSections.includes(d)) sectionKeys.push(d);
    }
  } else {
    sectionKeys = [...def.sectionKeys];
  }
  sectionKeys = sectionKeys.filter((s) => !def.excludeSections.includes(s));

  const sections = sectionKeys.map((key) => ({
    key,
    storageKey: k(key),
    title: titles[key] || "Новый раздел",
    rows: sectionRows(site, def, key, kv)
  }));
  const view = {
    id: viewId,
    def,
    columns,
    sections,
    // Нет сохранённых недель — как defaultPlanningWeeks() на сайте: текущая.
    planningWeeks: def.hasPlanning
      ? clone(kv.get(k("planningweeks"))) || [{ start: mondayOf(todayIso()), collapsed: false, colorIdx: -1 }]
      : []
  };
  renumberView(view);
  return view;
}

export function renumberView(view) {
  if (!view.def.globalNumbering || !view.columns.some((c) => c.id === "num")) return;
  let n = 1;
  for (const s of view.sections) for (const r of s.rows) r.num = String(n++);
}

// Записывает изменённые разделы/недели обратно в kv (для updatePrefix).
export function writeBackView(view, before, kv) {
  renumberView(view);
  for (const s of view.sections) {
    const json = JSON.stringify(s.rows);
    if (before.sections[s.key] !== json) kv.set(s.storageKey, s.rows);
  }
  if (view.def.hasPlanning && JSON.stringify(view.planningWeeks) !== before.planningWeeks) {
    kv.set(`${view.def.prefix}-planningweeks`, view.planningWeeks);
  }
}

export function snapshotView(view) {
  const sections = {};
  for (const s of view.sections) sections[s.key] = JSON.stringify(s.rows);
  return { sections, planningWeeks: JSON.stringify(view.planningWeeks) };
}

// ---------- Поиск строк ----------

export function normText(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/ё/g, "е")
    .replace(/[«»"'“”„`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export function allRows(view) {
  return view.sections.flatMap((section) => section.rows.map((row) => ({ section, row })));
}

export function findRows(view, ref, nameField) {
  const all = allRows(view);
  const raw = String(ref ?? "").trim();
  if (!raw) return [];
  const byId = all.filter((x) => x.row._rid === raw);
  if (byId.length) return byId;
  const num = raw.replace(/^№\s*/, "");
  if (/^\d+$/.test(num)) {
    const byNum = all.filter((x) => String(x.row.num) === num);
    if (byNum.length) return byNum;
  }
  const n = normText(raw);
  const exact = all.filter((x) => normText(x.row[nameField]) === n);
  if (exact.length) return exact;
  return all.filter((x) => normText(x.row[nameField]).includes(n));
}

export function resolveOne(view, ref, nameField, what, sectionFilter) {
  let matches = findRows(view, ref, nameField);
  if (sectionFilter) {
    const f = normText(sectionFilter);
    const filtered = matches.filter((x) => normText(x.section.title) === f || x.section.key === sectionFilter);
    if (filtered.length) matches = filtered;
  }
  if (!matches.length) {
    throw new UserError(`Не найден ${what} «${ref}». Проверьте название, номер или id (их можно найти через поиск).`);
  }
  if (matches.length > 1) {
    const list = matches
      .slice(0, 10)
      .map((x) => `№${x.row.num} «${x.row[nameField]}» (${x.section.title}, id ${x.row._rid})`)
      .join("; ");
    throw new UserError(`Под «${ref}» подходит несколько записей: ${list}. Уточните номер или id.`);
  }
  return matches[0];
}

// ---------- Представление строк ----------

export function truncate(text, max) {
  const s = String(text ?? "");
  return s.length > max ? { text: s.slice(0, max) + "…", truncated: true } : { text: s, truncated: false };
}

export function rowToObject(view, section, row, { maxText = 0, skip = [] } = {}) {
  const out = { id: row._rid, "раздел": section.title };
  let truncated = false;
  for (const col of view.columns) {
    if (col.id === "questionnaire" || skip.includes(col.id)) continue;
    let val = row[col.id];
    if (val === undefined || val === null || val === "") continue;
    if (typeof val !== "string") val = typeof val === "object" ? JSON.stringify(val) : String(val);
    if (maxText && val.length > maxText) {
      const t = truncate(val, maxText);
      val = t.text;
      truncated = true;
    }
    out[col.label] = val;
  }
  if (truncated) out["обрезано"] = true;
  return out;
}

// ---------- Даты ----------

export function todayIso() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.timeZone }).format(new Date());
}

export function parseDate(value) {
  const s = String(value ?? "").trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return isValidYmd(+m[1], +m[2], +m[3]) ? `${m[1]}-${m[2]}-${m[3]}` : null;
  m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (m) {
    const d = m[1].padStart(2, "0"), mo = m[2].padStart(2, "0");
    return isValidYmd(+m[3], +mo, +d) ? `${m[3]}-${mo}-${d}` : null;
  }
  return null;
}

function isValidYmd(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isoToDmy(iso) {
  const [y, m, d] = iso.split("-");
  return `${d}.${m}.${y}`;
}

export function addDays(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return dt.toISOString().slice(0, 10);
}

// 0 = понедельник … 6 = воскресенье
export function weekdayIndex(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
}

export function mondayOf(iso) {
  return addDays(iso, -weekdayIndex(iso));
}

export function isoWeekNumber(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dayNum = dt.getUTCDay() || 7;
  dt.setUTCDate(dt.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(dt.getUTCFullYear(), 0, 1));
  return Math.ceil(((dt - yearStart) / 86400000 + 1) / 7);
}

export const WEEKDAYS_RU = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];

// Дата из запроса пользователя: ISO, ДД.ММ.ГГГГ или «сегодня/завтра/вчера».
export function parseUserDate(value, what = "дата") {
  const s = normText(value);
  if (s === "сегодня" || s === "today") return todayIso();
  if (s === "завтра" || s === "tomorrow") return addDays(todayIso(), 1);
  if (s === "вчера" || s === "yesterday") return addDays(todayIso(), -1);
  const iso = parseDate(value);
  if (!iso) throw new UserError(`Не удалось разобрать ${what} «${value}». Используйте формат ГГГГ-ММ-ДД или ДД.ММ.ГГГГ.`);
  return iso;
}

// Неделя из запроса: любая дата недели или «текущая/следующая/прошлая».
export function resolveWeekStart(value) {
  const s = normText(value || "текущая");
  const today = mondayOf(todayIso());
  if (["текущая", "эта", "эта неделя", "текущая неделя", "current", "this"].includes(s)) return today;
  if (["следующая", "следующая неделя", "next"].includes(s)) return addDays(today, 7);
  if (["прошлая", "предыдущая", "прошлая неделя", "previous", "last"].includes(s)) return addDays(today, -7);
  return mondayOf(parseUserDate(value, "неделю"));
}

// ---------- Справочники и сопоставление значений ----------

export function canonical(value, options) {
  const n = normText(value);
  return options.find((o) => normText(o) === n);
}

export function statusIsFinished(status) {
  return ["завершена", "закрыта", "закрыто", "отменена"].includes(normText(status));
}

// ---------- Опросники ----------

export function specKeyForProduct(product) {
  const s = normText(product);
  if (s === "пак") return "pak";
  if (s === "гибрид") return "hybrid";
  return null;
}

export const SPEC_LABELS = { pak: "ПАК", hybrid: "Гибрид" };

export function questionnaireFields(site, specKey) {
  const spec = site.consts.QUESTIONNAIRE_SPECS[specKey];
  const out = [];
  for (const tab of spec.tabs) {
    for (const sec of tab.sections) {
      for (const f of sec.fields) out.push({ tab, section: sec, field: f });
    }
  }
  return out;
}

export function questionnaireSummary(site, row, { includeHints = false, tabFilter } = {}) {
  const specKey = specKeyForProduct(row.product);
  if (!specKey) return null;
  const spec = site.consts.QUESTIONNAIRE_SPECS[specKey];
  const data = (row.questionnaire && row.questionnaire[specKey]) || {};
  let filled = 0, total = 0;
  const missingRequired = [];
  const tabs = [];
  for (const tab of spec.tabs) {
    const tabData = data[tab.id] || {};
    const sections = [];
    for (const sec of tab.sections) {
      const fields = [];
      for (const f of sec.fields) {
        total++;
        const cell = tabData[f.id] || {};
        if (cell.answer) filled++;
        else if (f.required) missingRequired.push(`${tab.label} → ${f.label}`);
        const item = { "поле": f.label, "код": `${tab.id}.${f.id}`, "ответ": cell.answer || "" };
        if (cell.comment) item["комментарий"] = cell.comment;
        if (f.required) item["обязательное"] = true;
        if (Array.isArray(f.options)) item["варианты"] = f.options;
        if (includeHints && f.hint) item["подсказка"] = f.hint;
        fields.push(item);
      }
      sections.push({ "раздел": sec.title, "поля": fields });
    }
    const tabOut = { "вкладка": tab.label, "код": tab.id, "разделы": sections };
    if (tab.agentTable) {
      const agents = (tabData.__agents || [])
        .filter((r) => Array.isArray(r) && r.some((v) => String(v ?? "").trim()))
        .map((r) => Object.fromEntries(tab.agentTable.columns.map((c, i) => [c, r[i] ?? ""])));
      tabOut[tab.agentTable.title.toLowerCase()] = agents;
    }
    if (!tabFilter || normText(tab.label) === normText(tabFilter) || tab.id === tabFilter) tabs.push(tabOut);
  }
  return {
    "опросник": SPEC_LABELS[specKey],
    "заполнено": `${filled}/${total}`,
    "не_заполнены_обязательные": missingRequired,
    "вкладки": tabs
  };
}

// Поля опросника, относящиеся к доступу/подключению к серверам заказчика.
export const CONNECTION_FIELD_IDS = [
  "access", "bmc_access", "client_domain", "client_certs", "nexus_account", "nexus_repos",
  "rp_token", "hybrid_key", "internet_access", "os", "virtualization", "deployment", "gpu"
];

// ---------- Задачи по неделям ----------

export const TASK_STATUSES = { not_started: "Не начат", progress: "В работе", done: "Закрыто" };

export function taskStatusKey(value) {
  const n = normText(value);
  for (const [key, label] of Object.entries(TASK_STATUSES)) {
    if (n === key || n === normText(label)) return key;
  }
  const aliases = { "не начата": "not_started", "новая": "not_started", "в процессе": "progress", "выполнено": "done", "выполнена": "done", "готово": "done", "закрыта": "done", "сделано": "done" };
  if (aliases[n]) return aliases[n];
  throw new UserError(`Неизвестный статус задачи «${value}». Допустимо: «Не начат», «В работе», «Закрыто».`);
}

export function formatTask(task, dateIso) {
  const out = {
    id: task.id,
    "дата": isoToDmy(dateIso),
    "день": WEEKDAYS_RU[weekdayIndex(dateIso)],
    "название": task.title || "(без названия)",
    "статус": TASK_STATUSES[task.status] || task.status || ""
  };
  if (task.description) out["описание"] = task.description;
  if (task.server) out["сервер"] = task.server;
  if (task.timeValue) out["трудозатраты"] = `${task.timeValue} ${task.timeUnit === "hours" ? "ч" : "дн."}`;
  return out;
}

export function allTasks(view) {
  const out = [];
  for (const { section, row } of allRows(view)) {
    const planning = row.planning || {};
    for (const [date, tasks] of Object.entries(planning)) {
      if (!Array.isArray(tasks)) continue;
      for (const task of tasks) out.push({ section, row, date, task });
    }
  }
  return out;
}

// Колонки недель на сайте идут подряд (пн–пт). Чтобы задача на новую дату
// была видна, добавляем недостающие недели так же, как кнопка «+ неделя».
export function ensurePlanningWeek(view, dateIso) {
  const weeks = view.planningWeeks;
  const monday = mondayOf(dateIso);
  if (weeks.some((w) => w.start === monday)) return;
  const palette = 8;
  const push = (start) => {
    const used = weeks.filter((w) => w.colorIdx >= 0).length;
    weeks.push({ start, collapsed: false, colorIdx: used % palette });
  };
  if (!weeks.length) {
    push(monday);
    return;
  }
  weeks.sort((a, b) => a.start.localeCompare(b.start));
  const first = weeks[0].start;
  if (monday < first) {
    const added = [];
    for (let s = monday; s < first; s = addDays(s, 7)) added.push({ start: s, collapsed: false, colorIdx: -1 });
    weeks.unshift(...added);
    return;
  }
  for (let s = addDays(weeks[weeks.length - 1].start, 7); s <= monday; s = addDays(s, 7)) push(s);
}
