import { z } from "zod";
import { getSite } from "./site.js";
import { readPrefix, updatePrefix } from "./store.js";
import {
  UserError, buildView, snapshotView, writeBackView, allRows, resolveOne, rowToObject, normText,
  truncate, todayIso, parseDate, isoToDmy, addDays, weekdayIndex, isoWeekNumber, parseUserDate,
  resolveWeekStart, canonical, statusIsFinished, specKeyForProduct, SPEC_LABELS, questionnaireFields,
  questionnaireSummary, CONNECTION_FIELD_IDS, TASK_STATUSES, taskStatusKey, formatTask, allTasks,
  ensurePlanningWeek
} from "./model.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const WRITE_IDEMPOTENT = { ...WRITE, idempotentHint: true };

// ---------- Общие помощники ----------

async function loadView(viewId) {
  const site = getSite();
  const kv = await readPrefix(site.views[viewId].prefix);
  return { site, view: buildView(site, viewId, kv) };
}

async function changeView(viewId, fn) {
  const site = getSite();
  return updatePrefix(site.views[viewId].prefix, async (kv) => {
    const view = buildView(site, viewId, kv);
    const before = snapshotView(view);
    const result = await fn(site, view);
    writeBackView(view, before, kv);
    return result;
  });
}

function paginate(items, limit, offset) {
  const page = items.slice(offset, offset + limit);
  const out = { "всего": items.length, "показано": page.length };
  if (offset + limit < items.length) out["следующий_offset"] = offset + limit;
  return { out, page };
}

function contains(value, query) {
  return !query || normText(value).includes(normText(query));
}

function textOfRow(row) {
  return Object.entries(row)
    .filter(([k]) => k !== "_rid" && k !== "questionnaire" && k !== "planning")
    .map(([, v]) => (typeof v === "string" ? v : ""))
    .join(" ");
}

function questionnaireProgress(site, row) {
  const s = questionnaireSummary(site, row);
  return s ? s["заполнено"] : undefined;
}

function projectBrief(site, section, row) {
  const out = {
    id: row._rid,
    "№": row.num,
    "проект": row.project || "",
    "раздел": section.title,
    "продукт": row.product || "",
    "статус": row.status || "",
    "приоритет": row.priority || "",
    "РП": row.responsible || "",
    "ответственный_ТБ": row.tbResponsible || "",
    "срок": row.deadline || ""
  };
  if (row.comment) out["комментарий"] = truncate(row.comment, 200).text;
  const q = questionnaireProgress(site, row);
  if (q) out["опросник"] = q;
  for (const k of Object.keys(out)) if (out[k] === "") delete out[k];
  return out;
}

const limitSchema = z.number().int().min(1).max(50).optional().describe("Сколько записей вернуть (1–50, по умолчанию 20)");
const offsetSchema = z.number().int().min(0).optional().describe("Смещение для следующей страницы (значение «следующий_offset» из прошлого ответа)");
const projectRef = z.string().min(1).describe("Проект: название (можно часть), номер из колонки «№» или id");

// ---------- Поля проекта (создание/изменение) ----------

const projectFieldSchema = {
  status: z.string().optional().describe("Статус проекта. Обычно: «Не начата», «Планирование», «В работе», «ПМИ», «Завершена»"),
  priority: z.string().optional().describe("Приоритет: «Высокий», «Средний» или «Низкий»"),
  product: z.string().optional().describe("Продукт: «ПАК» или «Гибрид» (от него зависит опросник проекта)"),
  responsible: z.string().optional().describe("Ответственный РП (ФИО)"),
  tb_responsible: z.string().optional().describe("Ответственный от ТБ (ФИО)"),
  deadline: z.string().optional().describe("Срок: дата ГГГГ-ММ-ДД или ДД.ММ.ГГГГ, либо текст вроде «TBD» или «После ОС от ТБ»"),
  block: z.string().optional().describe("Блок"),
  team: z.string().optional().describe("Команда"),
  goals: z.string().optional().describe("Цели"),
  tasks: z.string().optional().describe("Задачи (текст колонки «Задачи»)"),
  contacts: z.string().optional().describe("Контакты"),
  nda: z.string().optional().describe("NDA"),
  comment: z.string().optional().describe("Комментарий"),
  confluence_link: z.string().optional().describe("Ссылка на Confluence")
};
const PROJECT_FIELD_COLUMNS = {
  status: "status", priority: "priority", product: "product", responsible: "responsible",
  tb_responsible: "tbResponsible", deadline: "deadline", block: "block", team: "team", goals: "goals",
  tasks: "tasks", contacts: "contacts", nda: "nda", comment: "comment", confluence_link: "confluenceLink"
};

function normalizeProjectFields(site, args) {
  const out = {};
  for (const [arg, col] of Object.entries(PROJECT_FIELD_COLUMNS)) {
    if (args[arg] === undefined) continue;
    let v = String(args[arg]).trim();
    if (arg === "status") {
      v = canonical(v, site.consts.STAGES.map((s) => s.key)) || v;
    } else if (arg === "priority" && v) {
      const c = canonical(v, site.consts.PRIORITY_OPTIONS);
      if (!c) throw new UserError(`Приоритет «${v}» не поддерживается. Допустимо: ${site.consts.PRIORITY_OPTIONS.join(", ")}.`);
      v = c;
    } else if (arg === "product" && v) {
      const c = canonical(v, ["ПАК", "Гибрид"]);
      if (!c) throw new UserError(`Продукт «${v}» не поддерживается. Допустимо: ПАК, Гибрид.`);
      v = c;
    } else if (arg === "deadline" && v) {
      const iso = parseDate(v);
      if (iso) v = isoToDmy(iso);
    } else if (arg === "responsible" && v) {
      v = canonical(v, site.consts.RESPONSIBLE_LIST.map((p) => p.name)) || v;
    } else if (arg === "tb_responsible" && v) {
      v = canonical(v, site.consts.TB_RESPONSIBLE_OPTIONS) || v;
    }
    out[col] = v;
  }
  return out;
}

// ---------- Регистрация ----------

export function registerTools(server, log) {
  function tool(name, config, handler) {
    server.registerTool(name, config, async (args) => {
      const started = Date.now();
      try {
        const result = await handler(args || {});
        log({ tool: name, status: "ok", duration_ms: Date.now() - started });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 1) }] };
      } catch (err) {
        const userError = err instanceof UserError;
        log({ tool: name, status: userError ? "user_error" : "error", duration_ms: Date.now() - started, error: userError ? err.message : String(err && err.stack || err) });
        return {
          isError: true,
          content: [{ type: "text", text: userError ? err.message : "Внутренняя ошибка коннектора PMO. Повторите запрос позже или сообщите администратору." }]
        };
      }
    });
  }

  // ======================= ЧТЕНИЕ =======================

  tool("get_overview", {
    title: "Обзор сайта PMO",
    description:
      "Покажи обзор PMO: какие вкладки и разделы есть, сколько проектов, сколько в работе и просрочено, " +
      "сколько задач на этой неделе, сколько требований. Используй для вопросов «что есть на сайте PMO», " +
      "«общая картина по проектам», «сводка по PMO».",
    inputSchema: {},
    annotations: READ
  }, async () => {
    const site = getSite();
    const today = todayIso();
    const [p, r, q] = await Promise.all(["projects", "registry", "requirements"].map((id) => loadView(id)));
    const rows = allRows(p.view);
    const active = rows.filter((x) => !statusIsFinished(x.row.status));
    const overdue = active.filter((x) => { const d = parseDate(x.row.deadline); return d && d < today; });
    const monday = resolveWeekStart("текущая");
    const weekTasks = allTasks(p.view).filter((t) => t.date >= monday && t.date <= addDays(monday, 6));
    const byStatus = {};
    for (const x of rows) { const s = x.row.status || "(не указан)"; byStatus[s] = (byStatus[s] || 0) + 1; }
    return {
      "сегодня": isoToDmy(today),
      "вкладки": [
        { "вкладка": "Текущие проекты", "разделы": p.view.sections.map((s) => ({ "раздел": s.title, "проектов": s.rows.length })) },
        { "вкладка": "Реестр миграций (скрыта в интерфейсе)", "разделы": r.view.sections.map((s) => ({ "раздел": s.title, "записей": s.rows.length })) },
        { "вкладка": "Требования", "требований": allRows(q.view).length },
        { "вкладка": "Архитектура", "описание": "текстовое описание архитектуры платформы (инструмент get_architecture)" }
      ],
      "проекты": {
        "всего": rows.length,
        "не_завершены": active.length,
        "просрочены": overdue.length,
        "по_статусам": byStatus
      },
      "задачи_на_текущей_неделе": {
        "неделя": `${isoToDmy(monday)}–${isoToDmy(addDays(monday, 4))}`,
        "всего": weekTasks.length,
        "в_работе": weekTasks.filter((t) => t.task.status === "progress").length,
        "закрыто": weekTasks.filter((t) => t.task.status === "done").length
      }
    };
  });

  tool("find_projects", {
    title: "Найти проекты",
    description:
      "Найди проекты во вкладке «Текущие проекты» с фильтрами по статусу, ответственному, продукту, приоритету, " +
      "сроку, разделу и тексту. Используй, когда спрашивают: «какие проекты в работе», «проекты Михлина», " +
      "«проекты ПАК», «что просрочено», «проекты со сроком в сентябре», «найди проект Ультрамар».",
    inputSchema: {
      query: z.string().optional().describe("Текст для поиска по любым полям проекта (название, комментарий, задачи…)"),
      status: z.string().optional().describe("Статус (частичное совпадение), например «В работе», «Новая», «Завершена»"),
      exclude_finished: z.boolean().optional().describe("true — скрыть завершённые проекты"),
      responsible: z.string().optional().describe("Ответственный РП (часть ФИО)"),
      tb_responsible: z.string().optional().describe("Ответственный от ТБ (часть ФИО)"),
      product: z.string().optional().describe("Продукт: ПАК или Гибрид"),
      priority: z.string().optional().describe("Приоритет: Высокий, Средний, Низкий"),
      section: z.string().optional().describe("Раздел вкладки, например «Нефтегаз» или «Активные задачи»"),
      deadline_from: z.string().optional().describe("Срок не раньше этой даты (ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)"),
      deadline_to: z.string().optional().describe("Срок не позже этой даты (ГГГГ-ММ-ДД или ДД.ММ.ГГГГ)"),
      overdue: z.boolean().optional().describe("true — только просроченные незавершённые проекты"),
      limit: limitSchema,
      offset: offsetSchema
    },
    annotations: READ
  }, async (a) => {
    const { site, view } = await loadView("projects");
    const from = a.deadline_from ? parseUserDate(a.deadline_from, "дату «с»") : null;
    const to = a.deadline_to ? parseUserDate(a.deadline_to, "дату «по»") : null;
    const today = todayIso();
    const items = allRows(view).filter(({ section, row }) => {
      if (a.query && !contains(textOfRow(row), a.query)) return false;
      if (a.status && !contains(row.status, a.status)) return false;
      if (a.exclude_finished && statusIsFinished(row.status)) return false;
      if (a.responsible && !contains(row.responsible, a.responsible)) return false;
      if (a.tb_responsible && !contains(row.tbResponsible, a.tb_responsible)) return false;
      if (a.product && normText(row.product) !== normText(a.product)) return false;
      if (a.priority && normText(row.priority) !== normText(a.priority)) return false;
      if (a.section && !contains(section.title, a.section)) return false;
      const d = parseDate(row.deadline);
      if ((from || to) && !d) return false;
      if (from && d < from) return false;
      if (to && d > to) return false;
      if (a.overdue && (!d || d >= today || statusIsFinished(row.status))) return false;
      return true;
    });
    const { out, page } = paginate(items, a.limit || 20, a.offset || 0);
    out["проекты"] = page.map(({ section, row }) => projectBrief(site, section, row));
    return out;
  });

  tool("get_project", {
    title: "Карточка проекта",
    description:
      "Покажи всё о проекте: все поля, ответы опросника и задачи по неделям. Используй, когда спрашивают: " +
      "«расскажи про проект …», «статус проекта …», «что по Гранели», «кто ответственный за …».",
    inputSchema: { project: projectRef },
    annotations: READ
  }, async (a) => {
    const { site, view } = await loadView("projects");
    const { section, row } = resolveOne(view, a.project, "project", "проект");
    const out = rowToObject(view, section, row);
    out["№"] = row.num;
    const q = questionnaireSummary(site, row);
    if (q) {
      out["опросник"] = {
        "опросник": q["опросник"],
        "заполнено": q["заполнено"],
        "не_заполнены_обязательные": q["не_заполнены_обязательные"],
        "ответы": q["вкладки"].flatMap((t) => t["разделы"].flatMap((s) => s["поля"]
          .filter((f) => f["ответ"] || f["комментарий"])
          .map((f) => ({ "вкладка": t["вкладка"], "поле": f["поле"], "ответ": f["ответ"], ...(f["комментарий"] ? { "комментарий": f["комментарий"] } : {}) }))))
      };
    } else {
      out["опросник"] = "Продукт не выбран (ПАК/Гибрид) — опросник недоступен.";
    }
    const tasks = Object.entries(row.planning || {})
      .flatMap(([date, list]) => (Array.isArray(list) ? list.map((t) => formatTask(t, date)) : []))
      .sort((x, y) => parseDate(x["дата"]).localeCompare(parseDate(y["дата"])));
    out["задачи_по_неделям"] = tasks;
    return out;
  });

  tool("get_questionnaire", {
    title: "Опросник проекта",
    description:
      "Покажи опросник проекта (ПАК или Гибрид) с ответами, комментариями, обязательными полями и вариантами ответов. " +
      "Используй, когда спрашивают: «что в опроснике …», «какая ОС / GPU / модель у …», «требования по интеграции у …» " +
      "(tab = «Интеграция»), «какие ответы не заполнены».",
    inputSchema: {
      project: projectRef,
      tab: z.string().optional().describe("Только одна вкладка опросника: «GigaChat» или «Интеграция»"),
      include_hints: z.boolean().optional().describe("true — добавить подсказки к полям")
    },
    annotations: READ
  }, async (a) => {
    const { site, view } = await loadView("projects");
    const { row } = resolveOne(view, a.project, "project", "проект");
    const q = questionnaireSummary(site, row, { includeHints: !!a.include_hints, tabFilter: a.tab });
    if (!q) throw new UserError(`У проекта «${row.project}» не выбран продукт (ПАК/Гибрид), поэтому опросника нет.`);
    return { "проект": row.project, id: row._rid, ...q };
  });

  tool("get_connection_details", {
    title: "Данные для подключения",
    description:
      "Выведи данные для подключения к серверам и контуру заказчика из опросников: способ доступа (SSH/VPN/RDP), " +
      "доступ в BMC, домен, сертификаты, учётка и репозитории Nexus, токен, ключ, доступ в интернет, ОС, GPU, " +
      "а также серверы из задач по неделям. Используй, когда просят: «данные для подключения к …», " +
      "«как зайти на сервер …», «список подключений по проектам», «доступы в контур заказчиков».",
    inputSchema: {
      project: z.string().optional().describe("Проект (название, номер или id). Не указан — по всем проектам с заполненными данными")
    },
    annotations: READ
  }, async (a) => {
    const { site, view } = await loadView("projects");
    const targets = a.project ? [resolveOne(view, a.project, "project", "проект")] : allRows(view);
    const result = [];
    for (const { section, row } of targets) {
      const specKey = specKeyForProduct(row.product);
      const data = {};
      if (specKey) {
        const answers = (row.questionnaire && row.questionnaire[specKey]) || {};
        for (const { tab, field } of questionnaireFields(site, specKey)) {
          if (!CONNECTION_FIELD_IDS.includes(field.id)) continue;
          const cell = (answers[tab.id] || {})[field.id] || {};
          const text = [cell.answer, cell.comment].filter(Boolean).join(" — ");
          if (text) data[field.label] = text;
        }
      }
      const servers = [];
      for (const [date, list] of Object.entries(row.planning || {})) {
        for (const t of Array.isArray(list) ? list : []) {
          if (t.server) servers.push({ "сервер": t.server, "задача": t.title || "", "дата": isoToDmy(date) });
        }
      }
      if (!a.project && !Object.keys(data).length && !servers.length) continue;
      const item = { "проект": row.project, id: row._rid, "раздел": section.title, "продукт": row.product || "не выбран" };
      item["данные_для_подключения"] = Object.keys(data).length ? data : (specKey ? "в опроснике не заполнены" : "продукт не выбран — опросника нет");
      if (servers.length) item["серверы_из_задач"] = servers;
      result.push(item);
    }
    return { "проектов": result.length, "проекты": result };
  });

  tool("find_questionnaire_gaps", {
    title: "Незаполненные опросники",
    description:
      "Покажи, что не заполнено в опросниках проектов: сколько полей заполнено и какие обязательные пустые. " +
      "Используй, когда спрашивают: «где не заполнены опросники», «чего не хватает в опроснике …», «готовность опросников».",
    inputSchema: {
      project: z.string().optional().describe("Проект (название, номер или id). Не указан — по всем проектам"),
      exclude_finished: z.boolean().optional().describe("true — пропустить завершённые проекты")
    },
    annotations: READ
  }, async (a) => {
    const { site, view } = await loadView("projects");
    const targets = a.project ? [resolveOne(view, a.project, "project", "проект")] : allRows(view);
    const out = [];
    for (const { row } of targets) {
      if (a.exclude_finished && statusIsFinished(row.status)) continue;
      const q = questionnaireSummary(site, row);
      if (!q) {
        out.push({ "проект": row.project, id: row._rid, "опросник": "продукт не выбран (ПАК/Гибрид)" });
        continue;
      }
      out.push({ "проект": row.project, id: row._rid, "опросник": q["опросник"], "заполнено": q["заполнено"], "не_заполнены_обязательные": q["не_заполнены_обязательные"] });
    }
    return { "проектов": out.length, "проекты": out };
  });

  tool("get_week_tasks", {
    title: "Задачи на неделю",
    description:
      "Покажи задачи из колонок недель по проектам со статусами («Не начат», «В работе», «Закрыто»), днями, серверами и трудозатратами. " +
      "Используй, когда спрашивают: «какой статус задач на этой неделе», «что в работе на неделе», " +
      "«задачи на следующую неделю», «что сделано по проекту … за неделю».",
    inputSchema: {
      week: z.string().optional().describe("Неделя: «текущая» (по умолчанию), «следующая», «прошлая» или любая дата этой недели"),
      project: z.string().optional().describe("Только по этому проекту (название, номер или id)"),
      status: z.string().optional().describe("Только задачи со статусом: «Не начат», «В работе» или «Закрыто»"),
      responsible: z.string().optional().describe("Только проекты этого ответственного РП (часть ФИО)")
    },
    annotations: READ
  }, async (a) => {
    const { view } = await loadView("projects");
    const monday = resolveWeekStart(a.week);
    const sunday = addDays(monday, 6);
    const statusKey = a.status ? taskStatusKey(a.status) : null;
    const only = a.project ? resolveOne(view, a.project, "project", "проект").row._rid : null;
    const groups = new Map();
    const totals = { "всего": 0 };
    for (const label of Object.values(TASK_STATUSES)) totals[label] = 0;
    for (const { row, date, task } of allTasks(view)) {
      if (date < monday || date > sunday) continue;
      if (only && row._rid !== only) continue;
      if (statusKey && task.status !== statusKey) continue;
      if (a.responsible && !contains(row.responsible, a.responsible)) continue;
      if (!groups.has(row._rid)) {
        groups.set(row._rid, { "проект": row.project, id: row._rid, "статус_проекта": row.status || "", "РП": row.responsible || "", "задачи": [] });
      }
      groups.get(row._rid)["задачи"].push(formatTask(task, date));
      totals["всего"]++;
      const label = TASK_STATUSES[task.status];
      if (label) totals[label]++;
    }
    const projects = [...groups.values()];
    for (const g of projects) g["задачи"].sort((x, y) => parseDate(x["дата"]).localeCompare(parseDate(y["дата"])));
    return {
      "неделя": `Неделя ${isoWeekNumber(monday)}: ${isoToDmy(monday)}–${isoToDmy(addDays(monday, 4))}`,
      "итого": totals,
      "проекты": projects,
      ...(projects.length ? {} : { "примечание": "На эту неделю задач нет." })
    };
  });

  tool("get_project_stats", {
    title: "Статистика по проектам",
    description:
      "Посчитай проекты с группировкой по статусу, ответственному, продукту, приоритету или разделу. " +
      "Используй для аналитики: «сколько проектов у каждого РП», «распределение по статусам», «сколько проектов ПАК и Гибрид».",
    inputSchema: {
      group_by: z.enum(["status", "responsible", "tb_responsible", "product", "priority", "section"]).describe(
        "Группировка: status — статус, responsible — РП, tb_responsible — ответственный от ТБ, product — продукт, priority — приоритет, section — раздел"),
      exclude_finished: z.boolean().optional().describe("true — не считать завершённые проекты")
    },
    annotations: READ
  }, async (a) => {
    const { view } = await loadView("projects");
    const field = { status: "status", responsible: "responsible", tb_responsible: "tbResponsible", product: "product", priority: "priority" }[a.group_by];
    const groups = {};
    let total = 0;
    for (const { section, row } of allRows(view)) {
      if (a.exclude_finished && statusIsFinished(row.status)) continue;
      const key = (a.group_by === "section" ? section.title : row[field]) || "(не указано)";
      if (!groups[key]) groups[key] = { "количество": 0, "проекты": [] };
      groups[key]["количество"]++;
      groups[key]["проекты"].push(row.project);
      total++;
    }
    const sorted = Object.fromEntries(Object.entries(groups).sort((x, y) => y[1]["количество"] - x[1]["количество"]));
    return { "всего": total, "группы": sorted };
  });

  tool("find_requirements", {
    title: "Найти требования",
    description:
      "Найди требования к GigaCowork во вкладке «Требования» с оценкой соответствия (1–4), признаком «Решающее» и комментарием. " +
      "Используй, когда спрашивают: «какие требования не поддерживаются», «решающие требования», «требования по защите информации», " +
      "«что с поддержкой MCP в требованиях».",
    inputSchema: {
      query: z.string().optional().describe("Текст для поиска по требованию, критерию и комментарию"),
      section: z.string().optional().describe("Раздел требований, например «Защита информации», «Модели ИИ — Аудио»"),
      compliance: z.string().optional().describe("Оценка соответствия: 1 — не поддерживается, 2 — требует доработки, 3 — частично, 4 — полностью"),
      decisive: z.string().optional().describe("«Решающее» или «Не решающее»"),
      limit: limitSchema,
      offset: offsetSchema
    },
    annotations: READ
  }, async (a) => {
    const { view } = await loadView("requirements");
    const items = allRows(view).filter(({ row }) => {
      if (a.query && !contains(`${row.requirement} ${row.criteria} ${row.comment}`, a.query)) return false;
      if (a.section && !contains(row.section, a.section)) return false;
      if (a.compliance && String(row.compliance).trim() !== String(a.compliance).trim().slice(0, 1)) return false;
      if (a.decisive && normText(row.decisive) !== normText(a.decisive)) return false;
      return true;
    });
    const { out, page } = paginate(items, a.limit || 20, a.offset || 0);
    out["требования"] = page.map(({ section, row }) => rowToObject(view, section, row, { maxText: 400 }));
    return out;
  });

  tool("find_migrations", {
    title: "Реестр миграций",
    description:
      "Найди записи во вкладке «Реестр миграций» (Гибрид и ПАК): даты продажи, начала и завершения, лицензия, сборка, " +
      "сценарии переноса, ответственный, статус и риски. Используй, когда спрашивают про миграции клиентов, " +
      "плановые даты миграции, риски и блокеры миграции.",
    inputSchema: {
      query: z.string().optional().describe("Текст для поиска (клиент, риски, лицензия…)"),
      product: z.string().optional().describe("Раздел: «Гибрид» или «ПАК»"),
      status: z.string().optional().describe("Статус миграции (частичное совпадение)"),
      responsible: z.string().optional().describe("Ответственный РП (часть ФИО)"),
      limit: limitSchema,
      offset: offsetSchema
    },
    annotations: READ
  }, async (a) => {
    const { view } = await loadView("registry");
    const items = allRows(view).filter(({ section, row }) => {
      if (a.query && !contains(textOfRow(row), a.query)) return false;
      if (a.product && normText(section.title) !== normText(a.product)) return false;
      if (a.status && !contains(row.status, a.status)) return false;
      if (a.responsible && !contains(row.responsible, a.responsible)) return false;
      return true;
    });
    const { out, page } = paginate(items, a.limit || 20, a.offset || 0);
    out["записи"] = page.map(({ section, row }) => rowToObject(view, section, row, { maxText: 400 }));
    return out;
  });

  tool("get_architecture", {
    title: "Архитектура платформы",
    description:
      "Покажи текст вкладки «Архитектура»: границы системы, контейнеры, зоны и порты, справочные таблицы. " +
      "Используй, когда спрашивают про архитектуру платформы, компоненты, порты, из чего состоит система.",
    inputSchema: {
      query: z.string().optional().describe("Показать только строки, где встречается этот текст")
    },
    annotations: READ
  }, async (a) => {
    const text = getSite().architecture;
    if (!a.query) {
      const t = truncate(text, 20000);
      return { "архитектура": t.text, ...(t.truncated ? { "обрезано": true } : {}) };
    }
    const lines = text.split("\n").filter((l) => contains(l, a.query));
    return { "найдено_строк": lines.length, "строки": lines.slice(0, 200) };
  });

  tool("search_site", {
    title: "Поиск по всему сайту PMO",
    description:
      "Ищи текст по всем вкладкам PMO сразу: проекты, опросники, задачи по неделям, реестр миграций, требования, архитектура. " +
      "Используй, когда неясно, где искать: «где упоминается …», «найди всё про …».",
    inputSchema: {
      query: z.string().min(2).describe("Что искать"),
      limit: limitSchema
    },
    annotations: READ
  }, async (a) => {
    const site = getSite();
    const limit = a.limit || 20;
    const q = normText(a.query);
    const hits = [];
    const snippet = (text) => {
      const s = String(text);
      const i = normText(s).indexOf(q);
      const from = Math.max(0, i - 60);
      return (from > 0 ? "…" : "") + s.slice(from, from + 200) + (s.length > from + 200 ? "…" : "");
    };
    const add = (hit) => { if (hits.length < 200) hits.push(hit); };

    const { view: projects } = await loadView("projects");
    for (const { section, row } of allRows(projects)) {
      for (const col of projects.columns) {
        const v = row[col.id];
        if (typeof v === "string" && normText(v).includes(q)) add({ "где": `Текущие проекты / ${section.title}`, "проект": row.project, id: row._rid, "поле": col.label, "фрагмент": snippet(v) });
      }
      const specKey = specKeyForProduct(row.product);
      if (specKey && row.questionnaire && row.questionnaire[specKey]) {
        const answers = row.questionnaire[specKey];
        for (const { tab, field } of questionnaireFields(site, specKey)) {
          const cell = (answers[tab.id] || {})[field.id] || {};
          const text = [cell.answer, cell.comment].filter(Boolean).join(" — ");
          if (text && normText(text).includes(q)) add({ "где": `Опросник ${SPEC_LABELS[specKey]}`, "проект": row.project, id: row._rid, "поле": `${tab.label} → ${field.label}`, "фрагмент": snippet(text) });
        }
      }
      for (const [date, list] of Object.entries(row.planning || {})) {
        for (const t of Array.isArray(list) ? list : []) {
          const text = [t.title, t.description, t.server].filter(Boolean).join(" — ");
          if (normText(text).includes(q)) add({ "где": "Задачи по неделям", "проект": row.project, "задача_id": t.id, "дата": isoToDmy(date), "фрагмент": snippet(text) });
        }
      }
    }
    for (const [viewId, label] of [["registry", "Реестр миграций"], ["requirements", "Требования"]]) {
      const { view } = await loadView(viewId);
      for (const { section, row } of allRows(view)) {
        for (const col of view.columns) {
          const v = row[col.id];
          if (typeof v === "string" && normText(v).includes(q)) add({ "где": `${label} / ${section.title}`, "запись": row.project || row.requirement, id: row._rid, "поле": col.label, "фрагмент": snippet(v) });
        }
      }
    }
    for (const line of site.architecture.split("\n")) {
      if (normText(line).includes(q)) add({ "где": "Архитектура", "фрагмент": snippet(line) });
    }
    return { "найдено": hits.length, "показано": Math.min(limit, hits.length), "результаты": hits.slice(0, limit) };
  });

  // ======================= ИЗМЕНЕНИЕ =======================

  tool("create_project", {
    title: "Создать проект",
    description:
      "Создай новый проект во вкладке «Текущие проекты». Используй, когда просят: «добавь проект …», «заведи новый проект для клиента …». " +
      "Проект появится у всех пользователей сайта. Удалить его через Коворк нельзя — только в интерфейсе сайта.",
    inputSchema: {
      project: z.string().min(1).describe("Название клиента / проекта"),
      section: z.string().optional().describe("Раздел, например «Активные задачи» (по умолчанию) или «Нефтегаз»"),
      ...projectFieldSchema
    },
    annotations: WRITE
  }, async (a) => changeView("projects", (site, view) => {
    const fields = normalizeProjectFields(site, a);
    let section = view.sections[view.sections.length - 1];
    if (a.section) {
      section = view.sections.find((s) => normText(s.title) === normText(a.section) || s.key === a.section);
      if (!section) throw new UserError(`Раздел «${a.section}» не найден. Есть: ${view.sections.map((s) => s.title).join(", ")}.`);
    }
    const dup = allRows(view).find((x) => normText(x.row.project) === normText(a.project));
    if (dup) throw new UserError(`Проект «${dup.row.project}» уже есть (№${dup.row.num}, id ${dup.row._rid}). Чтобы изменить его, используй update_project.`);
    const row = { _rid: site.newRowId() };
    for (const col of view.columns) row[col.id] = "";
    delete row.questionnaire;
    Object.assign(row, fields, { project: a.project.trim() });
    section.rows.push(row);
    return () => ({ "создан": projectBrief(site, section, row) });
  }).then((fn) => fn()));

  tool("update_project", {
    title: "Изменить проект",
    description:
      "Измени поля проекта: статус, приоритет, ответственных, срок, комментарий, цели, задачи, продукт и др. " +
      "Используй, когда просят: «поставь статус В работе у …», «перенеси срок …», «добавь комментарий к …», «назначь РП …». " +
      "Меняются только переданные поля.",
    inputSchema: {
      project: projectRef,
      comment_mode: z.enum(["replace", "append"]).optional().describe("Для comment: replace — заменить (по умолчанию), append — дописать новой строкой"),
      ...projectFieldSchema
    },
    annotations: WRITE_IDEMPOTENT
  }, async (a) => changeView("projects", (site, view) => {
    const { section, row } = resolveOne(view, a.project, "project", "проект");
    const fields = normalizeProjectFields(site, a);
    if (!Object.keys(fields).length) throw new UserError("Не указано ни одно поле для изменения.");
    if (fields.comment !== undefined && a.comment_mode === "append" && row.comment) {
      fields.comment = `${row.comment}\n${fields.comment}`;
    }
    const changes = {};
    for (const [col, v] of Object.entries(fields)) {
      if ((row[col] || "") !== v) changes[view.columns.find((c) => c.id === col)?.label || col] = { "было": row[col] || "", "стало": v };
      row[col] = v;
    }
    return () => ({ "проект": row.project, id: row._rid, "изменено": Object.keys(changes).length ? changes : "ничего не изменилось", "сейчас": projectBrief(site, section, row) });
  }).then((fn) => fn()));

  tool("set_questionnaire_answer", {
    title: "Заполнить поле опросника",
    description:
      "Запиши ответ и/или комментарий в поле опросника проекта (ПАК или Гибрид — по продукту проекта). " +
      "Используй, когда просят: «укажи в опроснике ОС SberLinux для …», «заполни доступ в контур …», «добавь комментарий к полю GPU».",
    inputSchema: {
      project: projectRef,
      field: z.string().min(1).describe("Поле: код из get_questionnaire (например «gigachat.os») или название поля («Операционная система»)"),
      answer: z.string().optional().describe("Ответ. Для полей со списком — один из вариантов поля"),
      comment: z.string().optional().describe("Комментарий к полю")
    },
    annotations: WRITE_IDEMPOTENT
  }, async (a) => changeView("projects", (site, view) => {
    if (a.answer === undefined && a.comment === undefined) throw new UserError("Укажите answer и/или comment.");
    const { row } = resolveOne(view, a.project, "project", "проект");
    const specKey = specKeyForProduct(row.product);
    if (!specKey) throw new UserError(`У проекта «${row.project}» не выбран продукт (ПАК/Гибрид). Сначала задайте его через update_project.`);
    const fields = questionnaireFields(site, specKey);
    const ref = normText(a.field);
    const match = fields.filter(({ tab, field }) =>
      normText(`${tab.id}.${field.id}`) === ref || normText(field.id) === ref || normText(field.label) === ref);
    if (!match.length) throw new UserError(`Поле «${a.field}» не найдено в опроснике ${SPEC_LABELS[specKey]}. Коды полей есть в get_questionnaire.`);
    if (match.length > 1) throw new UserError(`Поле «${a.field}» есть в нескольких вкладках: ${match.map((m) => `${m.tab.id}.${m.field.id}`).join(", ")}. Укажите код.`);
    const { tab, field } = match[0];
    const patch = {};
    if (a.answer !== undefined) {
      let answer = String(a.answer).trim();
      if (answer && Array.isArray(field.options)) {
        const c = canonical(answer, field.options);
        if (!c) throw new UserError(`Для поля «${field.label}» допустимы варианты: ${field.options.join("; ")}.`);
        answer = c;
      }
      patch.answer = answer;
    }
    if (a.comment !== undefined) patch.comment = String(a.comment);
    if (!row.questionnaire) row.questionnaire = {};
    if (!row.questionnaire[specKey]) row.questionnaire[specKey] = {};
    if (!row.questionnaire[specKey][tab.id]) row.questionnaire[specKey][tab.id] = {};
    const cell = row.questionnaire[specKey][tab.id][field.id] || {};
    const before = { ...cell };
    row.questionnaire[specKey][tab.id][field.id] = Object.assign(cell, patch);
    return () => ({ "проект": row.project, "опросник": SPEC_LABELS[specKey], "поле": `${tab.label} → ${field.label}`, "было": before, "стало": cell });
  }).then((fn) => fn()));

  tool("add_week_task", {
    title: "Добавить задачу на неделю",
    description:
      "Добавь задачу в колонку недели проекта на конкретный рабочий день (пн–пт). Используй, когда просят: " +
      "«добавь задачу на среду по …», «запланируй на завтра установку у …», «поставь задачу на неделю».",
    inputSchema: {
      project: projectRef,
      date: z.string().min(1).describe("День задачи: ГГГГ-ММ-ДД, ДД.ММ.ГГГГ, «сегодня» или «завтра» (только пн–пт)"),
      title: z.string().min(1).describe("Название задачи"),
      description: z.string().optional().describe("Описание"),
      server: z.string().optional().describe("Сервер, к которому относится задача"),
      status: z.string().optional().describe("Статус: «Не начат» (по умолчанию), «В работе» или «Закрыто»"),
      time_value: z.string().optional().describe("Трудозатраты, число"),
      time_unit: z.enum(["days", "hours"]).optional().describe("Единицы трудозатрат: days — дни (по умолчанию), hours — часы")
    },
    annotations: WRITE
  }, async (a) => changeView("projects", (site, view) => {
    const { row } = resolveOne(view, a.project, "project", "проект");
    const date = parseUserDate(a.date);
    if (weekdayIndex(date) > 4) throw new UserError(`${isoToDmy(date)} — выходной. В колонках недели только пн–пт, выберите рабочий день.`);
    const task = {
      id: "pt" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      title: a.title.trim(),
      description: a.description || "",
      server: a.server || "",
      status: a.status ? taskStatusKey(a.status) : "not_started",
      timeUnit: a.time_unit || "days",
      timeValue: a.time_value || ""
    };
    if (!row.planning) row.planning = {};
    if (!Array.isArray(row.planning[date])) row.planning[date] = [];
    row.planning[date].push(task);
    ensurePlanningWeek(view, date);
    return () => ({ "проект": row.project, "добавлена": formatTask(task, date) });
  }).then((fn) => fn()));

  tool("update_week_task", {
    title: "Изменить задачу недели",
    description:
      "Измени задачу из колонки недели: статус, название, описание, сервер, трудозатраты или перенеси на другой день. " +
      "Используй, когда просят: «закрой задачу …», «переведи задачу в работу», «перенеси задачу на пятницу». " +
      "id задачи есть в ответах get_week_tasks и get_project.",
    inputSchema: {
      task_id: z.string().min(1).describe("id задачи"),
      status: z.string().optional().describe("Статус: «Не начат», «В работе» или «Закрыто»"),
      title: z.string().optional().describe("Новое название"),
      description: z.string().optional().describe("Новое описание"),
      server: z.string().optional().describe("Сервер"),
      time_value: z.string().optional().describe("Трудозатраты, число"),
      time_unit: z.enum(["days", "hours"]).optional().describe("Единицы: days или hours"),
      new_date: z.string().optional().describe("Перенести на день: ГГГГ-ММ-ДД, ДД.ММ.ГГГГ, «сегодня», «завтра» (только пн–пт)")
    },
    annotations: WRITE_IDEMPOTENT
  }, async (a) => changeView("projects", (site, view) => {
    const found = allTasks(view).find((t) => t.task.id === a.task_id);
    if (!found) throw new UserError(`Задача с id «${a.task_id}» не найдена. Актуальные id — в get_week_tasks.`);
    const { row, task } = found;
    let date = found.date;
    if (a.status !== undefined) task.status = taskStatusKey(a.status);
    if (a.title !== undefined) task.title = a.title;
    if (a.description !== undefined) task.description = a.description;
    if (a.server !== undefined) task.server = a.server;
    if (a.time_value !== undefined) task.timeValue = a.time_value;
    if (a.time_unit !== undefined) task.timeUnit = a.time_unit;
    if (a.new_date !== undefined) {
      const target = parseUserDate(a.new_date);
      if (weekdayIndex(target) > 4) throw new UserError(`${isoToDmy(target)} — выходной. Выберите день пн–пт.`);
      if (target !== date) {
        row.planning[date] = row.planning[date].filter((t) => t.id !== task.id);
        if (!row.planning[date].length) delete row.planning[date];
        if (!Array.isArray(row.planning[target])) row.planning[target] = [];
        row.planning[target].push(task);
        ensurePlanningWeek(view, target);
        date = target;
      }
    }
    return () => ({ "проект": row.project, "задача": formatTask(task, date) });
  }).then((fn) => fn()));

  tool("update_requirement", {
    title: "Изменить требование",
    description:
      "Измени требование во вкладке «Требования»: оценку соответствия (1–4), признак «Решающее», комментарий. " +
      "Используй, когда просят: «поставь соответствие 4 требованию …», «обнови комментарий к требованию про MCP».",
    inputSchema: {
      requirement: z.string().min(1).describe("Требование: номер, id или часть текста требования"),
      compliance: z.enum(["1", "2", "3", "4"]).optional().describe("Соответствие: 1 — не поддерживается, 2 — требует доработки, 3 — частично, 4 — полностью"),
      decisive: z.enum(["Решающее", "Не решающее"]).optional().describe("Признак решающего требования"),
      comment: z.string().optional().describe("Комментарий GigaCowork")
    },
    annotations: WRITE_IDEMPOTENT
  }, async (a) => changeView("requirements", (site, view) => {
    const { section, row } = resolveOne(view, a.requirement, "requirement", "требование");
    const patch = {};
    if (a.compliance !== undefined) patch.compliance = a.compliance;
    if (a.decisive !== undefined) patch.decisive = a.decisive;
    if (a.comment !== undefined) patch.comment = a.comment;
    if (!Object.keys(patch).length) throw new UserError("Не указано ни одно поле для изменения.");
    Object.assign(row, patch);
    return () => ({ "требование": rowToObject(view, section, row, { maxText: 400 }) });
  }).then((fn) => fn()));

  tool("update_migration", {
    title: "Изменить запись реестра миграций",
    description:
      "Измени запись во вкладке «Реестр миграций»: статус, даты, лицензию, сборку, сценарии, ответственного, риски. " +
      "Используй, когда просят: «обнови дату миграции …», «поставь статус миграции …», «добавь риск по …».",
    inputSchema: {
      entry: z.string().min(1).describe("Клиент: название, номер или id записи"),
      product: z.string().optional().describe("Раздел «Гибрид» или «ПАК», если клиент есть в обоих"),
      status: z.string().optional().describe("Статус миграции: «Не начата», «Планирование», «В работе», «ПМИ», «Завершена»"),
      sale_date: z.string().optional().describe("Дата продажи"),
      start_date: z.string().optional().describe("Плановая дата начала"),
      end_date: z.string().optional().describe("Плановая дата завершения"),
      license: z.string().optional().describe("Состав лицензии"),
      build: z.string().optional().describe("Требуемая сборка"),
      scenarios: z.string().optional().describe("Сценарии переноса"),
      responsible: z.string().optional().describe("Ответственный РП"),
      risks: z.string().optional().describe("Риски / блокеры")
    },
    annotations: WRITE_IDEMPOTENT
  }, async (a) => changeView("registry", (site, view) => {
    const { section, row } = resolveOne(view, a.entry, "project", "клиент", a.product);
    const map = { status: "status", sale_date: "saleDate", start_date: "startDate", end_date: "endDate", license: "license", build: "build", scenarios: "scenarios", responsible: "responsible", risks: "risks" };
    let changed = 0;
    for (const [arg, col] of Object.entries(map)) {
      if (a[arg] === undefined) continue;
      let v = String(a[arg]).trim();
      if (col.endsWith("Date")) { const iso = parseDate(v); if (iso) v = isoToDmy(iso); }
      if (col === "status") v = canonical(v, site.consts.STAGES.map((s) => s.key)) || v;
      row[col] = v;
      changed++;
    }
    if (!changed) throw new UserError("Не указано ни одно поле для изменения.");
    return () => ({ "запись": rowToObject(view, section, row, { maxText: 400 }) });
  }).then((fn) => fn()));
}

export const SERVER_INSTRUCTIONS =
  "Коннектор к PMO-сайту pmo.gigaenterprise.ai: проекты внедрения GigaChat/GigaCowork (ПАК и Гибрид), " +
  "опросники с данными клиентов и доступами, задачи по неделям, реестр миграций, требования и архитектура. " +
  "Для вопросов «какие проекты в работе» — find_projects; «статус задач на неделю» — get_week_tasks; " +
  "«данные для подключения» — get_connection_details; «что в опроснике» — get_questionnaire; " +
  "если непонятно, где искать, — search_site. Изменения видны всем пользователям сайта сразу; удалять данные нельзя.";
