const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const Report = require("../report.js");

test("отчёт 21–20: январь, високосный февраль и конец месяца", () => {
  for (const [now, expected] of [
    [new Date(2026, 0, 31), { start: "2025-12-21", end: "2026-01-20" }],
    [new Date(2024, 2, 31), { start: "2024-02-21", end: "2024-03-20" }],
    [new Date(2026, 10, 13), { start: "2026-10-21", end: "2026-11-20" }]
  ]) assert.deepEqual(Report.defaultPeriod(now), expected);
});

test("даты считаются по местному календарю, без сдвига через UTC", () => {
  assert.equal(Report.isoDate(new Date(2026, 0, 1, 0, 1)), "2026-01-01");
  assert.equal(Report.isoDate(new Date(2026, 11, 31, 23, 59)), "2026-12-31");
});

test("валидирует границы и явно отмечает незавершённый период", () => {
  const now = new Date(2026, 10, 13);
  assert.deepEqual(Report.resolvePeriod("2026-10-21", "2026-11-20", now), {
    start: "2026-10-21", end: "2026-11-20", effective_end: "2026-11-13", period_in_progress: true
  });
  assert.equal(Report.resolvePeriod("2026-11-13", "2026-11-13", now).period_in_progress, false);
  for (const [start, end] of [["", "2026-11-20"], ["2026-02-30", "2026-03-20"], ["2026-03-21", "2026-03-20"], ["2026-11-14", "2026-11-20"]]) {
    assert.throws(() => Report.resolvePeriod(start, end, now));
  }
});

test("поддерживает локализованные Freepik/Magnific и сохраняет /app", () => {
  for (const url of [
    "https://www.freepik.com/ru/pikaso/projects/history?foo=1",
    "https://freepik.com/pikaso/projects/history",
    "https://www.magnific.com/pt-br/app/projects/all-assets",
    "https://www.magnific.com/ru/app/projects/work",
    "https://magnific.com/app/projects/abcdef12",
    "https://www.magnific.com/es/app/projects/all-assets"
  ]) assert.equal(Report.isSupportedPage(url), true, url);
  for (const url of ["https://evilfreepik.com/app/projects/work", "https://freepik.com.evil.test/app/projects/work", "http://freepik.com/pikaso/projects/history", "https://magnific.com/app/ai-image-generator", "invalid"]) {
    assert.equal(Report.isSupportedPage(url), false, url);
  }
  assert.equal(Report.stripLocale("/app/projects/work"), "/app/projects/work");
});

function siteFixture({ confirm = true, disabled = false, work = true, existingRange = false, customSelected = false, canonicalLabel = false, projectPath = "" } = {}) {
  const elements = new Map();
  const clicks = [];
  const location = { pathname: projectPath || (work ? "/ru/app/projects/work" : "/app/projects/all-assets") };
  let selectedStart = "";
  let selectedEnd = "";
  const add = (cy, action = () => {}, attrs = {}) => {
    const el = { textContent: "", getAttribute: (name) => attrs[name], click() { clicks.push(cy); action(); } };
    elements.set(cy, el);
    return el;
  };
  const filterAttrs = { "aria-expanded": "false" };
  add("projects-filter-button", () => { filterAttrs["aria-expanded"] = filterAttrs["aria-expanded"] === "true" ? "false" : "true"; }, filterAttrs);
  add("v3-link-all-assets", () => { location.pathname = "/ru/app/projects/all-assets"; });
  const presetAttrs = { "aria-pressed": "false" };
  add("filter-date-range-lastMonth", () => { presetAttrs["aria-pressed"] = "true"; add("active-filter-chip-date-range").textContent = "В прошлом месяце"; }, presetAttrs).textContent = "В прошлом месяце";
  const customAttrs = { "aria-pressed": String(customSelected) };
  add("filter-date-range-custom", () => { customAttrs["aria-pressed"] = "true"; }, customAttrs);
  add("date-range-selector-trigger", () => {
    if (customAttrs["aria-pressed"] !== "true") throw new Error("Select Custom after clearing dates");
    add("date-range-selector-popover");
  }, { "aria-expanded": "false" });
  if (existingRange) {
    selectedStart = "2026-10-21";
    selectedEnd = "2026-11-13";
    add("date-range-clear-start", () => { selectedStart = ""; elements.delete("date-range-clear-start"); if(!selectedEnd) customAttrs["aria-pressed"] = "false"; });
    add("date-range-clear-end", () => { selectedEnd = ""; elements.delete("date-range-clear-end"); customAttrs["aria-pressed"] = "false"; });
  }
  add("calendar-day-2026-10-21", () => {
    if (selectedStart === "2026-10-21") { selectedStart = ""; selectedEnd = ""; }
    else { selectedStart = "2026-10-21"; selectedEnd = "2026-10-21"; }
  }, { "aria-disabled": String(disabled) });
  add("calendar-day-2026-11-13", () => { selectedEnd = "2026-11-13"; });
  add("date-range-apply-button", () => {
    if (confirm) add("active-filter-chip-date-range").textContent = canonicalLabel ? "Last 3 months" : `${selectedStart} – ${selectedEnd}`;
    elements.delete("date-range-selector-popover");
  });
  add("date-range-cancel-button", () => { elements.delete("date-range-selector-popover"); });
  let clock = 0;
  const context = { location, document: { querySelector(selector) { const key=selector.match(/data-cy="([^"]+)"/)[1]; if(["date-range-clear-start","date-range-clear-end","date-range-selector-trigger"].includes(key)&&customAttrs["aria-pressed"]!=="true")return null; return elements.get(key); },
    querySelectorAll() { return [...elements.entries()].filter(([key])=>key.startsWith("calendar-day-")).map(([key,el])=>({...el,getAttribute: name => name==="data-cy"?key:null,classList:{contains:()=>[selectedStart,selectedEnd].includes(key.slice("calendar-day-".length))}})); } },
    setTimeout(fn) { fn(); }, Date: class extends Date { static now() { clock += 1000; return clock; } } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../report.js"), "utf8"), context);
  return { api: context.MagnificReport, clicks };
}

test("применяет даты штатным календарём и переходит с обзора на All assets", async () => {
  const site = siteFixture();
  await site.api.applyPeriod({ start: "2026-10-21", effective_end: "2026-11-13" });
  assert.deepEqual(site.clicks, ["v3-link-all-assets", "projects-filter-button", "filter-date-range-custom", "date-range-selector-trigger", "calendar-day-2026-10-21", "calendar-day-2026-11-13", "date-range-apply-button", "projects-filter-button"]);
});

test("не продолжает экспорт без подтверждённого диапазона или при недоступной дате", async () => {
  await assert.rejects(siteFixture({ confirm: false }).api.applyPeriod({ start: "2026-10-21", effective_end: "2026-11-13" }), /не подтвердил/);
  await assert.rejects(siteFixture({ disabled: true }).api.applyPeriod({ start: "2026-10-21", effective_end: "2026-11-13" }), /не позволяет/);
});
test("отсутствующая дата объясняется без внутренних имён элементов",async()=>{
 await assert.rejects(siteFixture().api.applyPeriod({start:"2026-08-13",effective_end:"2026-11-13"}),error=>error.message.includes('недоступна дата 2026-08-13')&&!error.message.includes('calendar-day-'));
});

test("один день выбирается одним кликом, старый диапазон сначала очищается", async () => {
  const site = siteFixture({ existingRange: true, work: false });
  await site.api.applyPeriod({ start: "2026-10-21", effective_end: "2026-10-21" });
  assert.equal(site.clicks.filter((cy) => cy === "calendar-day-2026-10-21").length, 1);
  assert.ok(site.clicks.indexOf("date-range-clear-start") < site.clicks.indexOf("calendar-day-2026-10-21"));
  assert.ok(site.clicks.indexOf("date-range-clear-end") < site.clicks.indexOf("calendar-day-2026-10-21"));
});

test("фоновое сохранение сохраняет период и признак неполной выгрузки", () => {
  const event = { addListener() {} };
  const context = { chrome: {
    runtime: { onInstalled: event, onStartup: event, onMessage: event },
    contextMenus: { onClicked: event }, action: { onClicked: event }, downloads: { onChanged: event },
    storage: { local: { get(keys, callback) { callback({}); } } }
  } };
  vm.runInNewContext(fs.readFileSync(require.resolve("../background.js"), "utf8"), context);
  const period = Report.resolvePeriod("2026-10-21", "2026-11-20", new Date(2026, 10, 13));
  const record = context.normalizeExportRecord({ report_period: period, export_status: "stopped" }, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(record.report_period)), { preset: "", label: "", site_label: "", ...period });
  assert.equal(context.normalizeExportMode(undefined), "with_images");
  assert.equal(record.export_status, "stopped");
});

test("фоновый обработчик сохраняет родную группу, параметры и тип аудио", () => {
  const event={addListener(){}};
  const context={chrome:{runtime:{onInstalled:event,onStartup:event,onMessage:event},action:{onClicked:event},downloads:{onChanged:event},storage:{local:{get(keys,callback){callback({});}}}}};
  vm.runInNewContext(fs.readFileSync(require.resolve("../background.js"),"utf8"),context);
  const row=context.normalizeExportRecord({feed_group_index:0,exporter_version:"2.0",parameters:[{kind:"resolution",value:"1.5K"}],images:[{id:"audio",type:"audio upload",asset_kind:"upload",media_type:"audio"}]},0);
  assert.equal(row.feed_group_index,0);assert.equal(row.exporter_version,"2.0");
  assert.equal(row.parameters[0].value,"1.5K");assert.equal(row.images[0].media_type,"audio");assert.equal(row.images[0].asset_kind,"upload");
});

test("из конкретного локализованного проекта переходит в общую историю", async () => {
  const site = siteFixture({ projectPath: "/es/app/projects/project-123" });
  await site.api.ensureAllAssets();
  assert.deepEqual(site.clicks, ["v3-link-all-assets"]);
});

test("относительный период не подменяет точные даты отчёта", async () => {
  await assert.rejects(siteFixture().api.applyPeriod({ preset: "last3Months" }), /точные даты/);
  assert.deepEqual(Report.defaultPeriod(new Date(2026, 10, 20)), Report.defaultPeriod(new Date(2026, 10, 25)));
});

test("после очистки выбранного Custom включает его заново и открывает новый календарь", async () => {
  const site=siteFixture({existingRange:true,customSelected:true,work:false});
  await site.api.applyPeriod({start:"2026-10-21",effective_end:"2026-11-13"});
  assert.ok(site.clicks.lastIndexOf("filter-date-range-custom") > site.clicks.indexOf("date-range-clear-end"));
  assert.ok(site.clicks.indexOf("date-range-selector-trigger") > site.clicks.lastIndexOf("filter-date-range-custom"));
});

test("при относительном периоде сначала открывает сохранённые границы, затем очищает обе", async () => {
  const site=siteFixture({existingRange:true,customSelected:false,work:false});
  await site.api.applyPeriod({start:"2026-10-21",effective_end:"2026-11-13"});
  assert.ok(site.clicks.indexOf("filter-date-range-custom")<site.clicks.indexOf("date-range-clear-start"));
  assert.ok(site.clicks.includes("date-range-clear-end"));
  assert.equal(site.clicks.filter(c=>c==="filter-date-range-custom").length,2);
});

test("относительная подпись подтверждается повторным чтением точных границ календаря", async () => {
  const site=siteFixture({canonicalLabel:true,work:false});
  await site.api.applyPeriod({start:"2026-10-21",effective_end:"2026-11-13"});
  assert.equal(site.clicks.filter(c=>c==="date-range-selector-trigger").length,2);
  assert.ok(site.clicks.includes("date-range-cancel-button"));
});

test("референсы помечаются отдельно, неизвестные типы не выдаются за генерации", () => {
  for (const type of ["upload", "upload-reference", "UPLOAD_REFERENCE", "upload reference"]) assert.equal(Report.getAssetKind(type), "upload");
  for (const type of ["text-to-image", "image-to-video", "retouch", "enhance", "world"]) assert.equal(Report.getAssetKind(type), "generation");
  assert.equal(Report.getAssetKind(""), "unknown");
  assert.equal(Report.getAssetKind("unrecognized-tool"), "unknown");
});

test("пауза ждёт возвращения вкладки и не снимается событием скрытой страницы", async () => {
  let handler; let removed = false; let resumed = false;
  const doc = { hidden: true, addEventListener(event, fn) { assert.equal(event, "visibilitychange"); handler = fn; }, removeEventListener(event, fn) { assert.equal(fn, handler); removed = true; } };
  const waiting = Report.waitForVisible(doc).then(() => { resumed = true; });
  await Promise.resolve(); assert.equal(resumed, false);
  handler(); await Promise.resolve(); assert.equal(resumed, false);
  doc.hidden = false; handler(); await waiting;
  assert.equal(resumed, true); assert.equal(removed, true);
});
