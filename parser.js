(() => {
  // 0) Глобальный гард — не запускать повторно, пока не закончили
  if (window.__magnificExporterRunning) {
    alert("Экспортёр истории уже запущен. Дождитесь завершения или нажмите Stop.");
    return;
  }
  window.__magnificExporterRunning = true;

  // 1) Проверка страницы
  function isSupportedProjectsPath(pathname) {
    return /^\/(?:pikaso\/projects|app\/projects)(?:\/|$)/.test(pathname || "");
  }

  function isSupportedProjectsHost(hostname) {
    return /(?:^|\.)magnific\.com$/i.test(hostname || "");
  }

  const ok = isSupportedProjectsHost(location.hostname) && isSupportedProjectsPath(location.pathname);

  if (!ok) {
    console.warn("Magnific exporter: wrong page:", location.href);
    alert(
      "Откройте страницу проектов Magnific:\n" +
        "https://www.magnific.com/app/projects/work\n" +
        "или конкретный проект вида https://www.magnific.com/app/projects/<project-id>."
    );
    window.__magnificExporterRunning = false;
    return;
  }

  // 2) Утилиты
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").trim().toLowerCase();
  const uniq = (arr) => Array.from(new Set(arr));
  const runtimeOptions =
    window.__magnificExporterOptions && typeof window.__magnificExporterOptions === "object"
      ? window.__magnificExporterOptions
      : {};
  delete window.__magnificExporterOptions;
  const exportMode = runtimeOptions.exportMode === "text_only" ? "text_only" : "with_images";
  const SETTINGS = {
    // Сколько циклов подряд без новых промптов считать концом ленты.
    // Увеличьте, если страница долго подгружает элементы.
    endCheckCycles: 60,
    // Лимит итераций (страховка от вечного цикла).
    maxIters: 8000,
    // Пауза между итерациями (мс).
    stepDelayMs: 700,
    // Дополнительная пауза после скролла, чтобы виртуальный список успел дорендерить пару header/grid.
    postScrollSettleMs: 220,
    // Режим экспорта: with_images | text_only
    exportMode,
    // Экспортировать превью-изображения рядом с JSON.
    exportPreviewImages: exportMode !== "text_only",
    // Сколько раз пробовать достать full prompt через кнопку Copy.
    copyPromptMaxAttempts: 4,
    // Дополнительная пауза после нажатия Load more.
    loadMoreSettleMs: 1000
  };

  // UI прогресса
  function createOverlay() {
    const existing = document.getElementById("magnific-exporter-overlay");
    if (existing) existing.remove();

    const style = document.createElement("style");
    style.id = "magnific-exporter-style";
    style.textContent = `
      #magnific-exporter-overlay {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 280px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        color: #0f172a;
      }
      #magnific-exporter-card {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.15);
        padding: 12px 12px 10px;
      }
      #magnific-exporter-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
        margin-bottom: 6px;
      }
      #magnific-exporter-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid #cbd5f5;
        border-top-color: #2563eb;
        border-radius: 999px;
        animation: magnific-spin 1s linear infinite;
      }
      #magnific-exporter-body {
        font-size: 12px;
        line-height: 1.4;
        color: #334155;
        margin-bottom: 10px;
      }
      #magnific-exporter-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      #magnific-exporter-stop {
        background: #ef4444;
        color: #ffffff;
        border: none;
        padding: 6px 10px;
        border-radius: 8px;
        font-size: 12px;
        cursor: pointer;
      }
      #magnific-exporter-stop:disabled {
        opacity: 0.6;
        cursor: default;
      }
      #magnific-exporter-note {
        font-size: 11px;
        color: #64748b;
        margin-top: 6px;
      }
      @keyframes magnific-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    const modeLabel = SETTINGS.exportPreviewImages ? "с картинками" : "только текст";
    overlay.id = "magnific-exporter-overlay";
    overlay.innerHTML = `
      <div id="magnific-exporter-card">
        <div id="magnific-exporter-title">
          <div id="magnific-exporter-spinner"></div>
          <div>Magnific exporter</div>
        </div>
        <div id="magnific-exporter-body">Инициализация…</div>
        <div id="magnific-exporter-actions">
          <button id="magnific-exporter-stop">Stop</button>
        </div>
        <div id="magnific-exporter-note">Режим: ${modeLabel}. Порог конца: ${SETTINGS.endCheckCycles} циклов без новых промптов.</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const body = overlay.querySelector("#magnific-exporter-body");
    const stopBtn = overlay.querySelector("#magnific-exporter-stop");

    return {
      update(text) {
        body.textContent = text;
      },
      onStop(cb) {
        stopBtn.addEventListener("click", () => {
          stopBtn.disabled = true;
          cb();
        });
      },
      finish(text) {
        body.textContent = text;
        const spinner = overlay.querySelector("#magnific-exporter-spinner");
        if (spinner) spinner.style.display = "none";
      },
      remove() {
        overlay.remove();
        const styleEl = document.getElementById("magnific-exporter-style");
        if (styleEl) styleEl.remove();
      }
    };
  }

  // Попытка найти “реальный” скролл-контейнер (лента часто скроллится внутри div)
  function isScrollableY(el) {
    if (!el || el === document.documentElement || el === document.body) return false;
    const style = window.getComputedStyle(el);
    const overflowY = style?.overflowY || "";
    if (!/(auto|scroll|overlay)/i.test(overflowY)) return false;
    return el.scrollHeight - el.clientHeight > 120;
  }

  function findScrollableAncestor(el) {
    let cur = el?.parentElement || null;
    while (cur && cur !== document.body && cur !== document.documentElement) {
      if (isScrollableY(cur)) return cur;
      cur = cur.parentElement;
    }
    return null;
  }

  function pickScroller() {
    // 1) Приоритет: скролл-родитель у элементов ленты
    const firstFeedEl = document.querySelector('[data-cy="feed-virtual-item"]');
    const feedScroller = findScrollableAncestor(firstFeedEl);
    if (feedScroller) return feedScroller;

    // 2) Если лента ещё не видна целиком, пробуем оттолкнуться от кнопки Load more.
    const loadMoreBtn = document.querySelector('[data-cy="load-more-button"]');
    const loadMoreScroller = findScrollableAncestor(loadMoreBtn);
    if (loadMoreScroller) return loadMoreScroller;

    // 3) Fallback: самый “глубокий” scrollHeight-кандидат
    const divs = Array.from(document.querySelectorAll("div"));
    const candidates = divs
      .map((el) => {
        try {
          const dh = el.scrollHeight - el.clientHeight;
          return { el, dh };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .filter((x) => x.dh > 300);

    candidates.sort((a, b) => b.dh - a.dh);
    return candidates[0]?.el || document.scrollingElement || document.documentElement;
  }

  function deriveModelQuality(tags, items) {
    const tagsNorm = tags.map((t) => t.trim()).filter(Boolean);
    const quality = tagsNorm.find((t) => norm(t) === "auto" || norm(t) === "default") || "";
    const modelCandidates = tagsNorm.filter((t) => {
      const n = norm(t);
      return n !== "auto" && n !== "default";
    });
    const model =
      modelCandidates.find((t) =>
        /nano|banana|kling|stable|sd|google|imagen|flux|veo|seedream|ideogram|recraft|midjourney|gemini|gpt|pro/i.test(
          t
        )
      ) ||
      modelCandidates[0] ||
      "";
    if (!model && Array.isArray(items) && items.length) {
      const iconHints = items.map((i) => i.icon || "").join(" ").toLowerCase();
      if (iconHints.includes("imagen")) return { model: "Imagen", quality };
      if (iconHints.includes("stable")) return { model: "Stable Diffusion", quality };
      if (iconHints.includes("kling")) return { model: "Kling", quality };
      if (iconHints.includes("veo")) return { model: "Veo", quality };
    }
    return { model, quality };
  }

  function normalizeType(text) {
    if (!text) return "";
    return text.replace(/[-_]+/g, " ").trim();
  }

  function toAbsoluteUrl(url) {
    try {
      return new URL(String(url || ""), location.href).href;
    } catch {
      return "";
    }
  }

  function padNum(value, size) {
    return String(value).padStart(size, "0");
  }

  function formatExportTimestamp(date) {
    return [
      padNum(date.getDate(), 2),
      padNum(date.getMonth() + 1, 2),
      String(date.getFullYear()).slice(-2),
      padNum(date.getHours(), 2),
      padNum(date.getMinutes(), 2)
    ].join(".");
  }

  function sanitizeFilenamePart(value, fallback) {
    const cleaned = String(value || "")
      .trim()
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\s+/g, "_")
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/_+/g, "_")
      .replace(/^[_\-.]+|[_\-.]+$/g, "")
      .slice(0, 48);
    return cleaned || fallback;
  }

  function parseProjectPathSegment() {
    const pathname = location.pathname || "";
    const match = pathname.match(/^\/app\/projects(?:\/([^/?#]+))?/);
    const segment = match?.[1] || "";
    if (segment) return segment;
    if (/^\/app\/projects(?:\/)?$/i.test(pathname)) return "work";
    return "project";
  }

  function getExportContext() {
    const accountFromHeader = cleanPromptText(
      document.querySelector('[data-cy="header-current-project-link"] span')?.textContent ||
        document.querySelector('[data-cy="header-current-project-link"]')?.textContent
    );
    const accountFromSidebar = cleanPromptText(
      document
        .querySelector('[data-cy="projects-selector-sidebar-trigger"]')
        ?.textContent?.replace(/^[A-Z]\s+/, "")
    );
    const accountLabel =
      accountFromHeader ||
      accountFromSidebar ||
      (/magnific\.com$/i.test(location.hostname || "") ? "magnific" : "account");

    const topBarEl = document.querySelector('[data-cy="projects-top-bar"]');
    const topBarFirstColumnText = cleanPromptText(topBarEl?.firstElementChild?.textContent);
    const topBarWholeText = cleanPromptText(topBarEl?.textContent)
      .replace(/\bnew\s+folder\b/i, "")
      .trim();

    const pathSegment = parseProjectPathSegment();
    const pathProjectLabel =
      pathSegment === "home" ||
      pathSegment === "history" ||
      pathSegment === "work" ||
      pathSegment === "project"
        ? pathSegment
        : `project_${pathSegment.slice(0, 8)}`;
    const projectLabel =
      pathSegment === "home" || pathSegment === "history" || pathSegment === "work" || pathSegment === "project"
        ? pathSegment
        : topBarFirstColumnText || topBarWholeText || pathProjectLabel;

    const projectIdSuffix = /^[a-f0-9-]{8,}$/i.test(pathSegment) ? pathSegment.slice(0, 8) : "";

    return {
      accountLabel,
      projectLabel,
      projectIdSuffix
    };
  }

  function getImageExtFromUrl(url) {
    try {
      const pathname = new URL(url).pathname || "";
      const ext = pathname.split(".").pop()?.toLowerCase() || "";
      if (/^(jpg|jpeg|png|webp|gif|bmp|avif)$/i.test(ext)) return ext === "jpeg" ? "jpg" : ext;
    } catch {}
    return "jpg";
  }

  function cleanIdForFilename(value, fallback) {
    const cleaned = String(value || "")
      .replace(/[^\w-]+/g, "")
      .slice(0, 24);
    return cleaned || fallback;
  }

  function cleanPromptText(value) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function looksPromptTruncated(text) {
    return /(?:\.\.\.|…)\s*$/.test(text || "");
  }

  function pickBetterPrompt(current, next) {
    const a = cleanPromptText(current);
    const b = cleanPromptText(next);
    if (!a) return b;
    if (!b) return a;
    if (looksPromptTruncated(a) && !looksPromptTruncated(b)) return b;
    if (b.length > a.length) return b;
    return a;
  }

  async function extractPromptViaCopy(headerEl) {
    const copyBtn = headerEl.querySelector('[data-cy="feed-family-copy-prompt-button"]');
    if (!copyBtn) return "";

    const clipboard = navigator?.clipboard;
    const originalWriteText =
      clipboard && typeof clipboard.writeText === "function" ? clipboard.writeText : null;
    let captured = "";
    const onCopy = (e) => {
      const text = cleanPromptText(e?.clipboardData?.getData("text/plain"));
      if (text) captured = text;
      // Не трогаем системный буфер обмена пользователя во время парсинга.
      e.preventDefault();
    };

    try {
      document.addEventListener("copy", onCopy, false);
      if (originalWriteText) {
        clipboard.writeText = async (value) => {
          captured = cleanPromptText(value);
        };
      }
      copyBtn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      await sleep(90);
    } catch {
      return "";
    } finally {
      document.removeEventListener("copy", onCopy, false);
      try {
        if (originalWriteText) clipboard.writeText = originalWriteText;
      } catch {}
    }

    return captured;
  }

  function parseHeader(headerEl) {
    const promptEl = headerEl.querySelector('[data-cy="feed-item-prompt"]');
    const attrPromptCandidates = [
      promptEl?.getAttribute("title"),
      promptEl?.getAttribute("aria-label"),
      promptEl?.getAttribute("data-prompt"),
      promptEl?.getAttribute("data-full-text")
    ]
      .map(cleanPromptText)
      .filter(Boolean);

    let prompt = cleanPromptText(promptEl?.textContent) || cleanPromptText(promptEl?.innerText);

    if (attrPromptCandidates.length) {
      const bestAttr = attrPromptCandidates.sort((a, b) => b.length - a.length)[0];
      if (bestAttr.length > prompt.length) prompt = bestAttr;
    }

    const tags = Array.from(headerEl.querySelectorAll('[data-cy="feed-item-tags"]'))
      .map((el) => cleanPromptText(el.textContent || el.innerText))
      .filter(Boolean);

    const dateGroup = cleanPromptText(
      headerEl
        .querySelector('[data-cy="select-all-row-button"]')
        ?.parentElement?.querySelector("p")?.textContent
    );

    return { prompt, tags, dateGroup };
  }

  function parseItemsFromGrid(containerEl) {
    const itemEls = containerEl.querySelectorAll('[data-item]');
    const items = [];
    for (const it of itemEls) {
      const id = it.getAttribute("data-item") || it.dataset?.item || "";
      const img = it.querySelector("img");
      const thumbnail = img?.getAttribute("src") || "";
      const alt = img?.getAttribute("alt") || "";
      const badgeText = it.querySelector('[data-cy="thumbnail-badge"] span')?.textContent?.trim() || "";
      const iconUse =
        it.querySelector('[data-cy="thumbnail-icon-badge"] use')?.getAttribute("xlink:href") ||
        it.querySelector('[data-cy="thumbnail-icon-badge"] use')?.getAttribute("href") ||
        "";

      items.push({
        id,
        alt,
        thumbnail,
        resolution: badgeText,
        icon: iconUse
      });
    }
    return items;
  }

  function ensureRecord(state, key, prompt, headerIndex, dateGroup) {
    if (!state.records.has(key)) {
      state.records.set(key, {
        key,
        header_index: headerIndex ?? "",
        prompt: prompt || "",
        date_group: dateGroup || "",
        tagsSet: new Set(),
        itemIdsSet: new Set(),
        itemsById: new Map()
      });
    }
    const rec = state.records.get(key);
    if (prompt && !rec.prompt) rec.prompt = prompt;
    if (dateGroup && !rec.date_group) rec.date_group = dateGroup;
    return rec;
  }

  function mergeTags(rec, tags) {
    for (const t of tags) rec.tagsSet.add(t);
  }

  function mergeItems(rec, items) {
    for (const item of items) {
      const itemId = item.id || item.thumbnail || "";
      if (!itemId) continue;
      rec.itemIdsSet.add(item.id || itemId);
      if (!rec.itemsById.has(itemId)) rec.itemsById.set(itemId, item);
    }
  }

  function findFeedContainers() {
    const containers = Array.from(document.querySelectorAll('[data-cy="feed-virtual-item"]'));
    return containers.map((el) => {
      const indexRaw = el.getAttribute("data-index");
      const index = indexRaw ? Number(indexRaw) : null;
      const header = el.querySelector('[data-cy="feed-virtual-item-header"]');
      const hasGrid = !!el.querySelector('[data-cy="main-feed-item"], [data-cy="image-creation-feed-item"]');
      const rect = el.getBoundingClientRect();
      const top = rect.top + window.scrollY;
      return { el, index, header, hasGrid, top };
    });
  }

  async function clickLoadMoreIfNeeded() {
    const btn = document.querySelector('[data-cy="load-more-button"]');
    if (!btn || btn.disabled) return false;

    const rect = btn.getBoundingClientRect();
    const isVisible = rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight + 120;
    if (!isVisible) return false;

    try {
      btn.scrollIntoView({ block: "center", inline: "nearest" });
    } catch {}

    btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
    await sleep(120);
    return true;
  }

  function buildOrderedContainers(containers) {
    return containers
      .slice()
      .sort((a, b) => {
        const ai = Number.isFinite(a.index) ? a.index : Number.POSITIVE_INFINITY;
        const bi = Number.isFinite(b.index) ? b.index : Number.POSITIVE_INFINITY;
        if (ai !== bi) return ai - bi;
        return a.top - b.top;
      });
  }

  // Безопасная привязка grid к header:
  // 1) сначала точный/соседний индекс;
  // 2) затем только СЛЕДУЮЩИЙ контейнер с grid (не предыдущий), с маленьким окном поиска.
  // Никаких "последний видимый grid" — это и давало смещения.
  function pickGridForHeader(headerContainer, gridsByIndex, orderedContainers, posByEl) {
    if (!headerContainer) return null;

    if (Number.isFinite(headerContainer.index)) {
      const exact = gridsByIndex.get(headerContainer.index);
      if (exact) return exact;
      const next = gridsByIndex.get(headerContainer.index + 1);
      if (next) return next;
      const prev = gridsByIndex.get(headerContainer.index - 1);
      if (prev) return prev;
    }

    const pos = posByEl.get(headerContainer.el);
    if (!Number.isFinite(pos)) return null;

    const LOOKAHEAD = 4;
    for (let i = pos + 1; i <= Math.min(orderedContainers.length - 1, pos + LOOKAHEAD); i++) {
      const c = orderedContainers[i];
      if (c?.hasGrid && c.top >= headerContainer.top) return c;
    }
    return null;
  }

  // 3) Парсинг видимых “кусочков” истории
  async function scrapeOnce(state) {
    const containers = findFeedContainers();
    const headers = containers.filter((c) => c.header);
    const grids = containers.filter((c) => c.hasGrid);

    const gridsByIndex = new Map();
    for (const g of grids) {
      if (Number.isFinite(g.index)) gridsByIndex.set(g.index, g);
    }

    const orderedContainers = buildOrderedContainers(containers);
    const posByEl = new Map(orderedContainers.map((c, i) => [c.el, i]));

    for (const h of headers) {
      const { prompt, tags, dateGroup } = parseHeader(h.header);
      const headerIndex = Number.isFinite(h.index) ? h.index : "";
      const key = Number.isFinite(h.index) ? `idx:${h.index}` : `prompt:${prompt}`;
      const rec = ensureRecord(state, key, prompt, headerIndex, dateGroup);
      mergeTags(rec, tags);
      rec.prompt = pickBetterPrompt(rec.prompt, prompt);

      // Основной путь: один раз (или до 3 раз при обрезке) пытаемся взять full prompt через кнопку Copy.
      const attempts = state.copyAttempts.get(key) || 0;
      const shouldTryCopy =
        attempts === 0 ||
        (looksPromptTruncated(rec.prompt) && attempts < SETTINGS.copyPromptMaxAttempts);
      if (shouldTryCopy) {
        state.copyAttempts.set(key, attempts + 1);
        const copiedPrompt = await extractPromptViaCopy(h.header);
        rec.prompt = pickBetterPrompt(rec.prompt, copiedPrompt);
      }

      const grid = pickGridForHeader(h, gridsByIndex, orderedContainers, posByEl);

      if (grid) {
        const items = parseItemsFromGrid(grid.el);
        mergeItems(rec, items);
      }
    }
  }

  // 4) Главный цикл прокрутки до “дна”
  async function run() {
    if (SETTINGS.exportPreviewImages) {
      const keepImages = window.confirm(
        "Выгрузка с картинками может занять продолжительное время (до нескольких минут). " +
          "Нажмите OK, чтобы продолжить, или Отмена для полной отмены выгрузки."
      );
      if (!keepImages) {
        window.alert(
          "Выгрузка отменена.\n" +
            "Чтобы запускать только текст, переключите режим:\n" +
            "правый клик по иконке расширения -> Режим выгрузки -> Только текст\n" +
            "или откройте Параметры (Options)."
        );
        window.__magnificExporterRunning = false;
        return;
      }
    }

    const scroller = pickScroller();
    console.log("Magnific exporter: scroller picked:", scroller);

    const ui = createOverlay();
    let stopRequested = false;
    let endReason = "";
    ui.onStop(() => {
      stopRequested = true;
      ui.update("Остановлено пользователем. Завершаю…");
    });

    // Важно: старт с самого верха
    try {
      if (scroller === document.documentElement || scroller === document.body) window.scrollTo(0, 0);
      else scroller.scrollTop = 0;
    } catch {}

    const state = {
      records: new Map(),
      copyAttempts: new Map(),
      lastCount: 0,
      stagnant: 0
    };

    // Сколько раз подряд можно “не видеть прироста”, прежде чем решить что дно
    const STAGNANT_LIMIT = SETTINGS.endCheckCycles;
    // Сколько максимум итераций (страховка от вечного цикла)
    const MAX_ITERS = SETTINGS.maxIters;

    for (let i = 0; i < MAX_ITERS; i++) {
      await scrapeOnce(state);

      const count = state.records.size;
      if (count === state.lastCount) state.stagnant++;
      else state.stagnant = 0;
      state.lastCount = count;

      ui.update(
        `Промптов: ${count}. Итерация: ${i + 1}/${MAX_ITERS}. ` +
          `Нет новых: ${state.stagnant}/${STAGNANT_LIMIT} (если растёт — значит лента заканчивается).`
      );

      if (stopRequested) {
        endReason = "Остановлено пользователем.";
        break;
      }

      // Прокрутка вниз
      try {
        const step = (scroller.clientHeight || window.innerHeight) * 0.85;
        if (scroller === document.documentElement || scroller === document.body) {
          window.scrollBy(0, step);
        } else {
          scroller.scrollTop += step;
        }
      } catch {}

      const clickedLoadMore = await clickLoadMoreIfNeeded();
      if (clickedLoadMore) {
        ui.update(
          `Промптов: ${count}. Итерация: ${i + 1}/${MAX_ITERS}. ` +
            `Нет новых: ${state.stagnant}/${STAGNANT_LIMIT}. Нажимаю Load more…`
        );
      }

      // “дно”: долго нет новых промптов
      if (state.stagnant >= STAGNANT_LIMIT && !clickedLoadMore) {
        endReason = `Похоже, конец ленты: ${state.stagnant} циклов без новых промптов.`;
        break;
      }

      await sleep(SETTINGS.postScrollSettleMs);
      if (clickedLoadMore) await sleep(SETTINGS.loadMoreSettleMs);
      await sleep(SETTINGS.stepDelayMs);
    }

    if (!endReason) endReason = "Достигнут лимит итераций, завершаю…";
    ui.update(`Финализация данных… ${endReason}`);

    // 5) Финал: нормализуем и сохраняем
    const exportTime = new Date();
    const exportTimestamp = formatExportTimestamp(exportTime);
    const { accountLabel, projectLabel, projectIdSuffix } = getExportContext();
    const accountPart = sanitizeFilenamePart(accountLabel, "account");
    const projectPart = sanitizeFilenamePart(projectLabel, "project");
    const projectSuffix = projectIdSuffix ? `_${sanitizeFilenamePart(projectIdSuffix, "project")}` : "";
    const exportBaseName = `magnific_history_${accountPart}_${projectPart}${projectSuffix}_${exportTimestamp}`;
    const previewsDir = `${exportBaseName}_previews`;

    const out = Array.from(state.records.values()).map((r, promptIndex) => {
      const items = Array.from(r.itemsById.values());
      const tags = Array.from(r.tagsSet.values()).map((t) => t.trim()).filter(Boolean);
      const { model, quality } = deriveModelQuality(tags, items);

      const tagsClean = tags.filter((t) => {
        const n = norm(t);
        if (n === "auto" || n === "default") return false;
        if (model && n === norm(model)) return false;
        return true;
      });

      const resolutions = uniq(items.map((i) => i.resolution).filter(Boolean));
      const types = uniq(items.map((i) => normalizeType(i.alt)).filter(Boolean));
      const images = items.map((item, imageIndex) => {
        const previewUrl = toAbsoluteUrl(item.thumbnail);
        const hasPreviewUrl = /^https?:\/\//i.test(previewUrl);
        const imageId = cleanIdForFilename(item.id, `item${padNum(imageIndex + 1, 2)}`);
        const imageExt = hasPreviewUrl ? getImageExtFromUrl(previewUrl) : "";
        const file = hasPreviewUrl
          ? `${previewsDir}/p${padNum(promptIndex + 1, 4)}_i${padNum(imageIndex + 1, 2)}_${imageId}.${imageExt}`
          : "";

        return {
          id: item.id || "",
          url: hasPreviewUrl ? previewUrl : "",
          file,
          type: normalizeType(item.alt),
          resolution: item.resolution || "",
          status: hasPreviewUrl ? "pending_validation" : "missing_preview",
          note: hasPreviewUrl ? "" : "No downloadable preview URL found in the feed item."
        };
      });

      const imageSlotCount = images.length;
      const missingImageCount = images.filter((image) => image.status === "missing_preview").length;

      return {
        prompt_index: promptIndex + 1,
        prompt: r.prompt,
        date_group: r.date_group || "",
        model,
        quality,
        types,
        resolutions,
        tags: tagsClean,
        image_slot_count: imageSlotCount,
        missing_image_count: missingImageCount,
        image_status: imageSlotCount
          ? missingImageCount === imageSlotCount
            ? "all_missing_or_failed"
            : missingImageCount > 0
              ? "partial"
              : "ready_for_validation"
          : "no_items_detected",
        images
      };
    });
    const filename = `${exportBaseName}.json`;
    const payload = {
      type: "MAGNIFIC_EXPORT_READY",
      records: out,
      filename,
      exportImages: SETTINGS.exportPreviewImages
    };

    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        console.error("Magnific exporter: failed to send export payload:", chrome.runtime.lastError.message);
      }
      const imagesQueued =
        Number(response?.imagesQueued || 0) ||
        (SETTINGS.exportPreviewImages
          ? out.reduce(
              (sum, record) =>
                sum + record.images.filter((image) => image.status === "pending_validation").length,
              0
            )
          : 0);
      const imagePart = SETTINGS.exportPreviewImages ? ` Превью: ${imagesQueued}.` : "";

      ui.finish(`Экспорт завершён: ${out.length} промптов.${imagePart} ${endReason} Скачивание началось.`);
      setTimeout(() => ui.remove(), 4000);
      window.__magnificExporterRunning = false;
    });
  }

  run().catch((e) => {
    console.error("Magnific exporter failed:", e);
    alert("Экспорт завершился с ошибкой. Откройте консоль для деталей.");
    window.__magnificExporterRunning = false;
  });
})();
