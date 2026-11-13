(() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const isoDate = (date) => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  const defaultPeriod = (now = new Date()) => ({
    start: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 21)),
    end: isoDate(new Date(now.getFullYear(), now.getMonth(), 20))
  });
  const stripLocale = (path) => String(path || "").replace(/^\/[a-z]{2}(?:-[a-z0-9]{2,8})?(?=\/)/i, "");
  const isSupportedPage = (url) => {
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" && /(?:^|\.)(?:freepik|magnific)\.com$/i.test(parsed.hostname) &&
        /^\/(?:pikaso|app)\/projects(?:\/|$)/.test(stripLocale(parsed.pathname));
    } catch { return false; }
  };
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || "")) return false;
    const [y, m, d] = value.split("-").map(Number);
    return y >= 1000 && isoDate(new Date(y, m - 1, d)) === value;
  }
  function resolvePeriod(start, end, now = new Date()) {
    if (!validDate(start) || !validDate(end)) throw new Error("Укажите обе даты периода.");
    if (start > end) throw new Error("Дата начала должна быть не позже даты окончания.");
    const today = isoDate(now);
    if (start > today) throw new Error("Дата начала ещё не наступила.");
    return { start, end, effective_end: end > today ? today : end, period_in_progress: end > today };
  }

  function waitForVisible(doc = document) {
    if (!doc.hidden) return Promise.resolve();
    return new Promise((resolve) => {
      const onVisibility = () => {
        if (doc.hidden) return;
        doc.removeEventListener("visibilitychange", onVisibility);
        resolve();
      };
      doc.addEventListener("visibilitychange", onVisibility);
      onVisibility();
    });
  }
  function isPageActive() {
    if (document.hidden) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "MAGNIFIC_GET_TAB_ACTIVITY" }, (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          reject(new Error("Не удалось проверить активность вкладки. Перезагрузите расширение и страницу Magnific."));
        } else resolve(response.active === true);
      });
    });
  }
  function isUploadType(type) {
    return /^(?:(?:audio|image|video)\s+)?upload(?:\s|$)/i.test(String(type || "").replace(/[-_]+/g, " ").trim());
  }
  function getAssetKind(type) {
    const normalized = String(type || "").replace(/[-_]+/g, " ").trim().toLowerCase();
    if (isUploadType(normalized)) return "upload";
    if (/^(?:text to |image to |video to )/.test(normalized) || /^(?:retouch|enhance|world|upscale|video generator)$/.test(normalized)) return "generation";
    return "unknown";
  }

  async function waitFor(getValue, message, timeout = 15000) {
    let started = Date.now();
    while (Date.now() - started < timeout) {
      if (document.hidden) { await waitForVisible(); started = Date.now(); }
      const value = getValue();
      if (value) return value;
      await sleep(100);
    }
    throw new Error(message);
  }
  const byCy = (cy) => document.querySelector(`[data-cy="${cy}"]`);
  async function clickCy(cy) {
    const unavailable = cy.startsWith("calendar-day-")
      ? `В календаре Magnific недоступна дата ${cy.slice("calendar-day-".length)}. Обновите страницу или выберите другой диапазон.`
      : "Не удалось найти нужный элемент интерфейса Magnific. Обновите страницу и повторите.";
    const button = await waitFor(() => byCy(cy), unavailable);
    if (button.disabled || button.getAttribute("aria-disabled") === "true") {
      throw new Error("Сайт не позволяет выбрать эту дату. Выберите другой период.");
    }
    button.click();
    await sleep(150);
  }

  const HISTORY_URL = "https://www.magnific.com/app/projects/all-assets";
  async function ensureAllAssets() {
    if (stripLocale(location.pathname).replace(/\/$/, "") !== "/app/projects/all-assets") {
      await clickCy("v3-link-all-assets");
      await waitFor(() => stripLocale(location.pathname).replace(/\/$/, "").endsWith("/all-assets"), "Не удалось открыть общую историю. Откройте All assets по ссылке.");
    }
    await waitFor(() => byCy("projects-filter-button"), "Не найдены фильтры истории. Обновите страницу Magnific.");
  }
  function showWrongPage(message = "Откройте общую историю Magnific, затем нажмите иконку расширения ещё раз.") {
    document.getElementById("magnific-report-setup")?.remove();
    const host = document.createElement("div"); host.id = "magnific-report-setup";
    host.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0f172a66;";
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>:host{font:14px/1.5 system-ui;color:#0f172a;color-scheme:light}section{background:white;padding:24px;border-radius:16px;width:360px;max-width:calc(100vw - 64px)}h2{margin:0 0 12px;font-size:20px}a{display:inline-block;color:white;background:#165edb;border-radius:8px;padding:10px 16px;text-decoration:none}button{display:block;margin-top:16px;border:0;background:none;color:#475569;cursor:pointer}</style><section><h2>Откройте историю Magnific</h2><p id="message"></p><a href="${HISTORY_URL}" target="_blank" rel="noopener noreferrer">Открыть Magnific → All assets</a><button type="button">Закрыть</button></section>`;
    root.getElementById("message").textContent = message;
    root.querySelector("button").onclick = () => host.remove();
    document.body.appendChild(host);
  }
  async function applyPeriod(period) {
    if (!validDate(period.start) || !validDate(period.effective_end)) throw new Error("Для отчёта нужны точные даты начала и окончания.");
    await ensureAllAssets();
    const filters = byCy("projects-filter-button");
    if (filters.getAttribute("aria-expanded") !== "true") await clickCy("projects-filter-button");
    // Presets hide the individual boundaries. Open Custom before clearing them.
    const initialCustom = await waitFor(() => byCy("filter-date-range-custom"), "На сайте не найден выбор периода.");
    if (initialCustom.getAttribute("aria-pressed") !== "true") await clickCy("filter-date-range-custom");
    // Повторный клик по выбранному дню снимает выбор. Сначала очищаем старый диапазон.
    if (byCy("date-range-clear-start")) await clickCy("date-range-clear-start");
    if (byCy("date-range-clear-end")) await clickCy("date-range-clear-end");
    // Clearing the last boundary can reset Custom and replace its trigger/popover.
    if (byCy("projects-filter-button")?.getAttribute("aria-expanded") !== "true") await clickCy("projects-filter-button");
    const custom = await waitFor(() => byCy("filter-date-range-custom"), "На сайте не найден выбор периода.");
    if (custom.getAttribute("aria-pressed") !== "true") await clickCy("filter-date-range-custom");
    if (!byCy("date-range-selector-popover")) {
      await clickCy("date-range-selector-trigger");
    }
    await clickCy(`calendar-day-${period.start}`);
    // Один клик уже задаёт диапазон из одного дня.
    if (period.start !== period.effective_end) await clickCy(`calendar-day-${period.effective_end}`);
    await clickCy("date-range-apply-button");
    const confirmation = await waitFor(() => {
      const text = byCy("active-filter-chip-date-range")?.textContent || "";
      const dates = text.match(/\d{4}-\d{2}-\d{2}/g);
      if (dates) return dates[0] === period.start && dates[1] === period.effective_end ? "dates" : false;
      // Magnific can label an exact custom interval "Last 3 months". Re-open the
      // actual calendar below; the label alone never confirms a report interval.
      return text.trim() ? "calendar" : false;
    }, "Сайт не подтвердил выбранный период. Выгрузка отменена, чтобы в отчёт не попали лишние записи.");
    if (confirmation === "calendar") {
      await sleep(400);
      if (byCy("filter-date-range-custom")?.getAttribute("aria-pressed") !== "true") await clickCy("filter-date-range-custom");
      if (!byCy("date-range-selector-popover")) await clickCy("date-range-selector-trigger");
      await waitFor(() => {
        const selected = Array.from(document.querySelectorAll('[data-cy^="calendar-day-"]'))
          .filter((el) => el.classList?.contains("bg-surface-accent-0") || el.getAttribute("aria-selected") === "true")
          .map((el) => el.getAttribute("data-cy").slice("calendar-day-".length)).sort();
        const expected = [...new Set([period.start, period.effective_end])].sort();
        return selected.length === expected.length && selected.every((date, i) => date === expected[i]);
      }, "Календарь Magnific не подтвердил точные границы отчёта.");
      await clickCy("date-range-cancel-button");
    }
    if (byCy("projects-filter-button")?.getAttribute("aria-expanded") === "true") await clickCy("projects-filter-button");
    // Даём сайту заменить ленту после применения фильтра; дальнейшую загрузку ждёт парсер.
    await sleep(1500);
  }

  function chooseOptions(exportMode = "with_images") {
    return new Promise((resolve) => {
      document.getElementById("magnific-report-setup")?.remove();
      const host = document.createElement("div");
      host.id = "magnific-report-setup";
      host.style.cssText = "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:#0f172a66;";
      const root = host.attachShadow({ mode: "open" });
      root.innerHTML = `
        <style>
          :host{font:14px/1.5 system-ui,-apple-system,sans-serif;color:#0f172a;color-scheme:light}
          *{box-sizing:border-box} form{background:white;border-radius:18px;padding:24px;width:420px;max-width:calc(100vw - 32px);max-height:90vh;overflow:auto;box-shadow:0 20px 80px #0f172a40}
          h2{margin:0 0 6px;font-size:21px} p{margin:0 0 16px;color:#475569}
          .dates{display:flex;gap:12px} label{display:block;flex:1} input,select{font:inherit;margin-top:5px;width:100%;padding:9px;border:1px solid #cbd5e1;border-radius:8px;background:white;color:#0f172a}
          select{margin-bottom:12px} .presets{display:flex;gap:12px;margin:10px 0 18px}
          button{font:inherit;cursor:pointer;border:0;border-radius:8px;padding:9px 12px;background:#e2e8f0;color:#0f172a}
          .presets button{padding:0;background:none;color:#2563eb;font-size:12px;text-align:left}
          .note{font-size:12px;background:#f1f5f9;border-radius:8px;padding:10px;margin:0 0 14px;white-space:pre-line}
          #error{color:#b91c1c;font-size:13px;margin-bottom:10px} .actions{display:flex;justify-content:flex-end;gap:10px}
          button[type=submit]{background:#2563eb;color:white} #period-note{color:#92400e;font-size:12px;margin-bottom:12px}
        </style>
        <form aria-label="Выгрузка отчёта">
          <h2>Выгрузка отчёта</h2><p>Проверьте даты отчёта. Расширение применит этот интервал в общей истории Magnific.</p>

          <div class="dates"><label>С даты<input id="start" type="date" required></label><label>По дату включительно<input id="end" type="date" required></label></div>
          <div class="presets"><button type="button" id="default">Отчёт 21 → 20</button><button type="button" id="previous">Предыдущий отчёт</button></div>
          <div id="period-note" role="status"></div>
          <div id="diagnostic-note" class="note" hidden>В настройках включена диагностика: эта выгрузка будет только в JSON, без картинок. Обычный режим вернётся автоматически при следующем запуске.</div>
          <p>Отчёт с превью сохранится в «Загрузки» автоматически. Во время сбора истории оставьте вкладку активной.</p><p id="mode-note" style="font-size:12px"></p>
          <div id="filters" class="note"></div><div id="error" role="alert"></div>
          <div class="actions"><button type="button" id="cancel">Отмена</button><button type="submit">Выгрузить</button></div>
        </form>`;
      const start = root.getElementById("start");
      const end = root.getElementById("end");
      const mode = exportMode === "text_only" ? "text_only" : "with_images";
      root.getElementById("diagnostic-note").hidden = mode !== "text_only";
      const now = new Date();
      function setPeriod(reference) {
        const period = defaultPeriod(reference);
        start.value = period.start;
        end.value = period.end;
        updateNote();
      }
      function updateNote() {
        root.getElementById("period-note").textContent = end.value > isoDate(now)
          ? `Период ещё не завершён. Данные будут собраны по ${isoDate(now)} включительно.` : "";
        root.getElementById("mode-note").textContent = mode === "with_images"
          ? "При переключении на другую вкладку сбор приостановится и продолжится после возвращения." : "Диагностика: ссылки на превью останутся в JSON.";
      }
      setPeriod(now);
      const chips = Array.from(document.querySelectorAll('[data-cy^="active-filter-chip-"]'))
        .filter((el) => el.getAttribute("data-cy") !== "active-filter-chip-date-range")
        .map((el) => el.textContent.trim()).filter(Boolean);
      root.getElementById("filters").textContent = "Область: общая история All assets. Генерации и загруженные референсы. Другие фильтры сайта сохраняются." +
        (chips.length ? `\nАктивны: ${chips.join(", ")}.` : "");
      const finish = (value) => { host.remove(); resolve(value); };
      root.getElementById("cancel").onclick = () => finish(null);
      root.getElementById("default").onclick = () => setPeriod(now);
      root.getElementById("previous").onclick = () => setPeriod(new Date(now.getFullYear(), now.getMonth() - 1, 1));
      root.addEventListener("input", updateNote);
      root.querySelector("form").onsubmit = (event) => {
        event.preventDefault();
        try { finish({ period: resolvePeriod(start.value, end.value), exportMode: mode }); }
        catch (error) { root.getElementById("error").textContent = error.message; }
      };
      root.addEventListener("keydown", (event) => { if (event.key === "Escape") finish(null); });
      document.body.appendChild(host);
      start.focus();
    });
  }
  const api = { isoDate, defaultPeriod, stripLocale, isSupportedPage, resolvePeriod, applyPeriod, chooseOptions, ensureAllAssets, showWrongPage, HISTORY_URL, waitForVisible, isPageActive, isUploadType, getAssetKind };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.MagnificReport = api;
})();
