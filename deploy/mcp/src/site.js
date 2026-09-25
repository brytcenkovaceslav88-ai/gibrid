import fs from "node:fs";
import vm from "node:vm";
import { config } from "./config.js";

const BEGIN = "// @pmo-shared-begin";
const END = "// @pmo-shared-end";

// Настройки вкладок — повторяют createController(...) в index.html.
const VIEW_DEFS = {
  projects: {
    prefix: "projects",
    title: "Текущие проекты",
    columnsDefault: "PROJECTS_COLUMNS_DEFAULT",
    titlesDefault: "PROJECTS_TITLES_DEFAULT",
    sectionKeys: ["oilgas", "actiontasks"],
    sectionDefaults: { oilgas: "PROJECTS_OILGAS_DEFAULT", actiontasks: "PROJECTS_ACTIONTASKS_DEFAULT" },
    excludeSections: ["hybrid", "pak"],
    excludeColumns: ["type", "testContract", "testDelivery", "purchaseContract", "crmLink", "jiraLink"],
    globalNumbering: true,
    hasPlanning: true
  },
  registry: {
    prefix: "registry",
    title: "Реестр миграций",
    columnsDefault: "REGISTRY_COLUMNS_DEFAULT",
    titlesDefault: "SECTION_TITLES_DEFAULT",
    sectionKeys: ["hybrid", "pak"],
    sectionDefaults: { hybrid: "HYBRID_DEFAULT", pak: "PAK_DEFAULT" },
    excludeSections: [],
    excludeColumns: [],
    globalNumbering: false,
    hasPlanning: false
  },
  requirements: {
    prefix: "requirements",
    title: "Требования",
    columnsDefault: "REQUIREMENTS_COLUMNS_DEFAULT",
    titlesDefault: "REQUIREMENTS_TITLES_DEFAULT",
    sectionKeys: ["items"],
    sectionDefaults: { items: "REQUIREMENTS_ITEMS_DEFAULT" },
    excludeSections: [],
    excludeColumns: [],
    globalNumbering: false,
    hasPlanning: false
  }
};

const EXPORTED_CONSTS = [
  "STAGES", "PRODUCTS", "COMPLIANCE_STAGES", "DECISIVE_OPTIONS", "REQ_SECTIONS",
  "PRIORITY_OPTIONS", "TB_RESPONSIBLE_OPTIONS", "RESPONSIBLE_LIST", "QUESTIONNAIRE_SPECS"
];

const hostClone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&laquo;/g, "«")
    .replace(/&raquo;/g, "»")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");
}

export function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<(script|style|svg)[\s\S]*?<\/\1>/gi, " ")
      .replace(/<img[^>]*>/gi, " ")
      .replace(/<\/(td|th)>/gi, " | ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|h[1-6]|li|tr|section|table|ul|ol)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "• ")
      .replace(/<[^>]+>/g, " ")
  )
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").replace(/\s*\|\s*$/, "").trim())
    .filter(Boolean)
    .join("\n");
}

function extractArchitecture(html) {
  const start = html.indexOf('id="view-architecture"');
  if (start < 0) return "";
  const end = html.indexOf('<section class="view"', start);
  const chunk = html.slice(html.lastIndexOf("<section", start), end < 0 ? undefined : end);
  return htmlToText(chunk.replace(/<div class="print-header">[\s\S]*?<\/div>/i, ""));
}

function buildSite(html) {
  const b = html.indexOf(BEGIN);
  const e = html.indexOf(END);
  if (b < 0 || e < 0 || e < b) {
    throw new Error("В index.html не найден блок @pmo-shared-begin/@pmo-shared-end");
  }
  const code = "function clone(x){ return JSON.parse(JSON.stringify(x)); }\n" + html.slice(b, e);
  const ctx = vm.createContext({});
  vm.runInContext(code, ctx, { timeout: 5000, filename: "index.html#pmo-shared" });

  const consts = {};
  for (const name of EXPORTED_CONSTS) consts[name] = hostClone(ctx[name]);

  const views = {};
  for (const [id, def] of Object.entries(VIEW_DEFS)) {
    const sectionDefaults = {};
    for (const [key, constName] of Object.entries(def.sectionDefaults)) {
      sectionDefaults[key] = hostClone(ctx[constName]) || [];
    }
    views[id] = {
      id,
      ...def,
      columnsDefault: hostClone(ctx[def.columnsDefault]) || [],
      titlesDefault: hostClone(ctx[def.titlesDefault]) || {},
      sectionDefaults
    };
  }

  return {
    consts,
    views,
    architecture: extractArchitecture(html),
    ensureRowIds: (key, value) => ctx.pmoEnsureRowIds(key, value),
    newRowId: () => ctx.pmoNewRowId(),
    merge3: (base, local, remote) => ctx.pmoMerge3(base, local, remote),
    stableStringify: (x) => ctx.pmoStableStringify(x)
  };
}

let cache = { mtimeMs: null, path: null, site: null };

// Перечитывает index.html, только если файл изменился (после деплоя).
export function getSite(path = config.indexHtmlPath) {
  const st = fs.statSync(path);
  if (cache.site && cache.path === path && cache.mtimeMs === st.mtimeMs) return cache.site;
  const site = buildSite(fs.readFileSync(path, "utf8"));
  cache = { mtimeMs: st.mtimeMs, path, site };
  return site;
}
