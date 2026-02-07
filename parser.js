(() => {
  // 0) Глобальный гард — не запускать повторно, пока не закончили
  if (window.__freepikExporterRunning) {
    alert("Freepik exporter уже запущен. Дождитесь завершения или нажмите Stop.");
    return;
  }
  window.__freepikExporterRunning = true;

  // 1) Проверка страницы
  const ok =
    location.hostname === "www.freepik.com" &&
    location.pathname.startsWith("/pikaso/projects/history");

  if (!ok) {
    console.warn("Freepik exporter: wrong page:", location.href);
    alert("Freepik exporter: open https://www.freepik.com/pikaso/projects/history first.");
    window.__freepikExporterRunning = false;
    return;
  }

  // 2) Утилиты
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const norm = (s) => (s || "").trim().toLowerCase();
  const uniq = (arr) => Array.from(new Set(arr));
  const SETTINGS = {
    // Сколько циклов подряд без новых промптов считать концом ленты.
    // Увеличьте, если страница долго подгружает элементы.
    endCheckCycles: 30,
    // Лимит итераций (страховка от вечного цикла).
    maxIters: 5000,
    // Пауза между итерациями (мс).
    stepDelayMs: 250
  };

  // UI прогресса
  function createOverlay() {
    const existing = document.getElementById("freepik-exporter-overlay");
    if (existing) existing.remove();

    const style = document.createElement("style");
    style.id = "freepik-exporter-style";
    style.textContent = `
      #freepik-exporter-overlay {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 280px;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
        color: #0f172a;
      }
      #freepik-exporter-card {
        background: #ffffff;
        border: 1px solid #e2e8f0;
        border-radius: 12px;
        box-shadow: 0 10px 30px rgba(15, 23, 42, 0.15);
        padding: 12px 12px 10px;
      }
      #freepik-exporter-title {
        display: flex;
        align-items: center;
        gap: 8px;
        font-weight: 600;
        font-size: 13px;
        margin-bottom: 6px;
      }
      #freepik-exporter-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid #cbd5f5;
        border-top-color: #2563eb;
        border-radius: 999px;
        animation: freepik-spin 1s linear infinite;
      }
      #freepik-exporter-body {
        font-size: 12px;
        line-height: 1.4;
        color: #334155;
        margin-bottom: 10px;
      }
      #freepik-exporter-actions {
        display: flex;
        gap: 8px;
        justify-content: flex-end;
      }
      #freepik-exporter-stop {
        background: #ef4444;
        color: #ffffff;
        border: none;
        padding: 6px 10px;
        border-radius: 8px;
        font-size: 12px;
        cursor: pointer;
      }
      #freepik-exporter-stop:disabled {
        opacity: 0.6;
        cursor: default;
      }
      #freepik-exporter-note {
        font-size: 11px;
        color: #64748b;
        margin-top: 6px;
      }
      @keyframes freepik-spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }
    `;
    document.head.appendChild(style);

    const overlay = document.createElement("div");
    overlay.id = "freepik-exporter-overlay";
    overlay.innerHTML = `
      <div id="freepik-exporter-card">
        <div id="freepik-exporter-title">
          <div id="freepik-exporter-spinner"></div>
          <div>Freepik exporter</div>
        </div>
        <div id="freepik-exporter-body">Инициализация…</div>
        <div id="freepik-exporter-actions">
          <button id="freepik-exporter-stop">Stop</button>
        </div>
        <div id="freepik-exporter-note">Порог конца: ${SETTINGS.endCheckCycles} циклов без новых промптов.</div>
      </div>
    `;
    document.body.appendChild(overlay);

    const body = overlay.querySelector("#freepik-exporter-body");
    const stopBtn = overlay.querySelector("#freepik-exporter-stop");

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
        const spinner = overlay.querySelector("#freepik-exporter-spinner");
        if (spinner) spinner.style.display = "none";
      },
      remove() {
        overlay.remove();
        const styleEl = document.getElementById("freepik-exporter-style");
        if (styleEl) styleEl.remove();
      }
    };
  }

  // Попытка найти “реальный” скролл-контейнер (лента History часто скроллится внутри div)
  function pickScroller() {
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
      modelCandidates.find((t) => /nano|kling|stable|sd|google|pro|imagen/i.test(t)) ||
      modelCandidates[0] ||
      "";
    if (!model && Array.isArray(items) && items.length) {
      const iconHints = items.map((i) => i.icon || "").join(" ").toLowerCase();
      if (iconHints.includes("imagen")) return { model: "Imagen", quality };
      if (iconHints.includes("stable")) return { model: "Stable Diffusion", quality };
      if (iconHints.includes("kling")) return { model: "Kling", quality };
    }
    return { model, quality };
  }

  function normalizeType(text) {
    if (!text) return "";
    return text.replace(/[-_]+/g, " ").trim();
  }

  function parseHeader(headerEl) {
    const promptEl = headerEl.querySelector('[data-cy="feed-item-prompt"]');
    const prompt = promptEl?.innerText?.trim() || "";
    const tags = Array.from(headerEl.querySelectorAll('[data-cy="feed-item-tags"]'))
      .map((el) => el.innerText?.trim())
      .filter(Boolean);
    return { prompt, tags };
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

  function ensureRecord(state, key, prompt, headerIndex) {
    if (!state.records.has(key)) {
      state.records.set(key, {
        key,
        header_index: headerIndex ?? "",
        prompt: prompt || "",
        tagsSet: new Set(),
        itemIdsSet: new Set(),
        itemsById: new Map()
      });
    }
    const rec = state.records.get(key);
    if (prompt && !rec.prompt) rec.prompt = prompt;
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

  // 3) Парсинг видимых “кусочков” истории
  function scrapeOnce(state) {
    const containers = findFeedContainers();
    const headers = containers.filter((c) => c.header);
    const grids = containers.filter((c) => c.hasGrid);

    const gridsByIndex = new Map();
    for (const g of grids) {
      if (Number.isFinite(g.index)) gridsByIndex.set(g.index, g);
    }

    const gridsByTop = grids
      .map((g) => ({ ...g }))
      .sort((a, b) => a.top - b.top || (a.index ?? 0) - (b.index ?? 0));

    for (const h of headers) {
      const { prompt, tags } = parseHeader(h.header);
      const headerIndex = Number.isFinite(h.index) ? h.index : "";
      const key = Number.isFinite(h.index) ? `idx:${h.index}` : `prompt:${prompt}`;
      const rec = ensureRecord(state, key, prompt, headerIndex);
      mergeTags(rec, tags);

      // Привязка гридов: сначала по индексу, затем по позиции
      let grid = null;
      if (Number.isFinite(h.index)) {
        grid =
          gridsByIndex.get(h.index) ||
          gridsByIndex.get(h.index - 1) ||
          gridsByIndex.get(h.index + 1) ||
          null;
      }
      if (!grid && gridsByTop.length) {
        // Берём ближайший грид по вертикали ниже
        const below = gridsByTop.filter((g) => g.top >= h.top);
        grid = below.length ? below[0] : gridsByTop[gridsByTop.length - 1];
      }

      if (grid) {
        const items = parseItemsFromGrid(grid.el);
        mergeItems(rec, items);
      }
    }
  }

  // 4) Главный цикл прокрутки до “дна”
  async function run() {
    const scroller = pickScroller();
    console.log("Freepik exporter: scroller picked:", scroller);

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
      lastCount: 0,
      stagnant: 0
    };

    // Сколько раз подряд можно “не видеть прироста”, прежде чем решить что дно
    const STAGNANT_LIMIT = SETTINGS.endCheckCycles;
    // Сколько максимум итераций (страховка от вечного цикла)
    const MAX_ITERS = SETTINGS.maxIters;

    for (let i = 0; i < MAX_ITERS; i++) {
      scrapeOnce(state);

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

      // “дно”: долго нет новых промптов
      if (state.stagnant >= STAGNANT_LIMIT) {
        endReason = `Похоже, конец ленты: ${state.stagnant} циклов без новых промптов.`;
        break;
      }

      await sleep(SETTINGS.stepDelayMs);
    }

    if (!endReason) endReason = "Достигнут лимит итераций, завершаю…";
    ui.update(`Финализация данных… ${endReason}`);

    // 5) Финал: нормализуем и сохраняем
    const out = Array.from(state.records.values()).map((r) => {
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

      return {
        prompt: r.prompt,
        model,
        quality,
        types,
        resolutions,
        tags: tagsClean
      };
    });

    const jsonText = JSON.stringify(out, null, 2);
    const filename = `freepik_history_${new Date().toISOString().slice(0, 10)}.json`;

    chrome.runtime.sendMessage({ type: "FREEPIK_EXPORT_READY", jsonText, filename }, () => {
      ui.finish(`Экспорт завершён: ${out.length} промптов. ${endReason} Скачивание началось.`);
      setTimeout(() => ui.remove(), 4000);
      window.__freepikExporterRunning = false;
    });
  }

  run().catch((e) => {
    console.error("Freepik exporter failed:", e);
    alert("Freepik exporter failed. Open console for details.");
    window.__freepikExporterRunning = false;
  });
})();
