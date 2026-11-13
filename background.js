const EXPORT_READY = "MAGNIFIC_EXPORT_READY";
const EXPORT_PROGRESS = "MAGNIFIC_EXPORT_PROGRESS";
const EXPORT_MODE_KEY = "exportMode";
const EXPORT_MODE_WITH_IMAGES = "with_images";
const EXPORT_MODE_TEXT_ONLY = "text_only";
const EXPORT_MODE_SET = new Set([EXPORT_MODE_WITH_IMAGES, EXPORT_MODE_TEXT_ONLY]);

function normalizeExportMode(value) {
  return EXPORT_MODE_SET.has(value) ? value : EXPORT_MODE_WITH_IMAGES;
}

function getExportMode() {
  return new Promise((resolve) => {
    chrome.storage.local.get([EXPORT_MODE_KEY], (result) => {
      resolve(normalizeExportMode(result?.[EXPORT_MODE_KEY]));
    });
  });
}

function setExportMode(mode) {
  const normalized = normalizeExportMode(mode);
  return new Promise((resolve) => {
    chrome.storage.local.set({ [EXPORT_MODE_KEY]: normalized }, () => {
      resolve(normalized);
    });
  });
}

// Диагностический режим действует только на один запуск и не меняет обычную выгрузку.
async function consumeExportMode() {
  const mode = await getExportMode();
  if (mode === EXPORT_MODE_TEXT_ONLY) await setExportMode(EXPORT_MODE_WITH_IMAGES);
  return mode;
}
chrome.runtime.onInstalled.addListener(() => { void setExportMode(EXPORT_MODE_WITH_IMAGES); });

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  try {
    const exportMode = await consumeExportMode();

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (opts) => {
        window.__magnificExporterOptions = opts;
      },
      args: [{ exportMode }]
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["report.js", "feed.js", "parser.js"]
    });
  } catch (err) {
    console.error("Failed to inject parser.js:", err);
    await chrome.tabs.create({ url: chrome.runtime.getURL("start.html") });
  }
});

function downloadFile({ url, filename, saveAs = false }) {
  return new Promise((resolve) => {
    chrome.downloads.download(
      {
        url,
        filename,
        saveAs
      },
      (downloadId) => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;
          console.error("Download failed:", error, filename);
          resolve({ ok: false, error });
          return;
        }
        resolve({ ok: true, downloadId });
      }
    );
  });
}

function normalizeImageRecord(image) {
  return {
    id: typeof image?.id === "string" ? image.id : "",
    url: typeof image?.url === "string" ? image.url : "",
    file: typeof image?.file === "string" ? image.file : "",
    type: typeof image?.type === "string" ? image.type : "",
    asset_kind: ["generation", "upload", "unknown"].includes(image?.asset_kind) ? image.asset_kind : "",
    media_type: ["image", "video", "audio", "unknown"].includes(image?.media_type) ? image.media_type : "unknown",
    resolution: typeof image?.resolution === "string" ? image.resolution : "",
    status: typeof image?.status === "string" ? image.status : "",
    note: typeof image?.note === "string" ? image.note : ""
  };
}

function normalizeExportRecord(record, index) {
  return {
    prompt_index:
      Number.isFinite(record?.prompt_index) && Number(record.prompt_index) > 0
        ? Number(record.prompt_index)
        : index + 1,
    feed_group_index: Number.isInteger(record?.feed_group_index) ? record.feed_group_index : null,
    exporter_version: typeof record?.exporter_version === "string" ? record.exporter_version : "",
    prompt: typeof record?.prompt === "string" ? record.prompt : "",
    prompt_source: typeof record?.prompt_source === "string" ? record.prompt_source : "",
    prompt_visible: typeof record?.prompt_visible === "string" ? record.prompt_visible : "",
    prompt_copied: typeof record?.prompt_copied === "string" ? record.prompt_copied : "",
    prompt_copy_status: typeof record?.prompt_copy_status === "string" ? record.prompt_copy_status : "",
    prompt_copy_attempts: Number.isFinite(record?.prompt_copy_attempts) ? Number(record.prompt_copy_attempts) : 0,
    prompt_copy_error_code:
      typeof record?.prompt_copy_error_code === "string" ? record.prompt_copy_error_code : "",
    prompt_copy_error: typeof record?.prompt_copy_error === "string" ? record.prompt_copy_error : "",
    prompt_needs_review: Boolean(record?.prompt_needs_review),
    prompt_issue: typeof record?.prompt_issue === "string" ? record.prompt_issue : "",
    date_group: typeof record?.date_group === "string" ? record.date_group : "",
    report_period: record?.report_period && typeof record.report_period === "object" ? {
      preset: String(record.report_period.preset || ""),
      label: String(record.report_period.label || ""),
      site_label: String(record.report_period.site_label || ""),
      start: String(record.report_period.start || ""),
      end: String(record.report_period.end || ""),
      effective_end: String(record.report_period.effective_end || ""),
      period_in_progress: Boolean(record.report_period.period_in_progress)
    } : null,
    export_status: typeof record?.export_status === "string" ? record.export_status : "",
    model: typeof record?.model === "string" ? record.model : "",
    quality: typeof record?.quality === "string" ? record.quality : "",
    parameters: Array.isArray(record?.parameters) ? record.parameters.filter((p) => p && typeof p.kind === "string" && typeof p.value === "string").map(({ kind, value }) => ({ kind, value })) : [],
    types: Array.isArray(record?.types) ? record.types.filter((value) => typeof value === "string") : [],
    resolutions: Array.isArray(record?.resolutions)
      ? record.resolutions.filter((value) => typeof value === "string")
      : [],
    tags: Array.isArray(record?.tags) ? record.tags.filter((value) => typeof value === "string") : [],
    asset_kinds: Array.isArray(record?.asset_kinds) ? record.asset_kinds.filter((kind) => ["generation", "upload", "unknown"].includes(kind)) : [],
    images: Array.isArray(record?.images) ? record.images.map(normalizeImageRecord) : [],
    image_slot_count: Number.isFinite(record?.image_slot_count) ? Number(record.image_slot_count) : 0,
    missing_image_count: Number.isFinite(record?.missing_image_count) ? Number(record.missing_image_count) : 0,
    image_status: typeof record?.image_status === "string" ? record.image_status : ""
  };
}

function notifyExportProgress(tabId, payload) {
  if (!Number.isFinite(tabId)) return;
  chrome.tabs.sendMessage(tabId, { type: EXPORT_PROGRESS, ...payload }, () => { void chrome.runtime.lastError; });
}
let creatingOffscreen;
async function ensureOffscreen() {
  if (creatingOffscreen) return creatingOffscreen;
  creatingOffscreen = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [chrome.runtime.getURL("offscreen.html")] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Assemble report JSON and preview images into a single downloadable ZIP." });
  })();
  try { await creatingOffscreen; } finally { creatingOffscreen = null; }
}
const finalizing = new Set();
async function finishDownload(id, state, error) {
  if (finalizing.has(id)) return;
  finalizing.add(id);
  try {
    const key = `export_download_${id}`;
    const job = (await chrome.storage.session.get(key))[key];
    if (!job) return;
    await chrome.storage.session.remove(key);
    await chrome.runtime.sendMessage({ target: "offscreen", type: "MAGNIFIC_RELEASE_BLOB", url: job.url }).catch(() => {});
    notifyExportProgress(job.tabId, { exportSessionId: job.exportSessionId,
      stage: state === "complete" ? "complete" : "error", error: error || "Скачивание прервано.",
      imagesArchived: job.imagesArchived, imageFailures: job.imageFailures });
  } finally { finalizing.delete(id); }
}
chrome.downloads.onChanged.addListener((delta) => {
  if (["complete", "interrupted"].includes(delta.state?.current)) void finishDownload(delta.id, delta.state.current, delta.error?.current);
});
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!message || message.target === "offscreen") return;
  if (message.type === "MAGNIFIC_GET_TAB_ACTIVITY") {
    if (!Number.isInteger(sender.tab?.id)) { respond({ ok: false, error: "Вкладка не найдена." }); return; }
    void (async () => {
      const tab = await chrome.tabs.get(sender.tab.id);
      const window = await chrome.windows.get(tab.windowId);
      respond({ ok: true, active: tab.active === true && window.state !== "minimized" });
    })().catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  if (message.type === "MAGNIFIC_GET_EXPORT_MODE") {
    void getExportMode().then((exportMode) => respond({ ok: true, exportMode })); return true;
  }
  if (message.type === "MAGNIFIC_SET_EXPORT_MODE") {
    void setExportMode(message.exportMode).then(async (exportMode) => {
      respond({ ok: true, exportMode });
    }).catch((error) => respond({ ok: false, error: error.message })); return true;
  }
  if (message.type === EXPORT_READY) {
    const tabId = sender.tab?.id;
    if (!Number.isFinite(tabId) || !Array.isArray(message.records)) { respond({ ok: false, error: "Нет данных экспорта." }); return; }
    const exportSessionId = message.exportSessionId;
    void (async () => {
      await ensureOffscreen();
      const response = await chrome.runtime.sendMessage({ target: "offscreen", type: "MAGNIFIC_BUILD_ARCHIVE",
        records: message.records.map(normalizeExportRecord), filename: message.filename,
        period: message.period, exportStatus: message.exportStatus,
        exportImages: message.exportImages !== false, tabId, exportSessionId });
      if (!response?.ok) throw new Error("Не удалось запустить сборку архива.");
      respond({ ok: true });
      notifyExportProgress(tabId, { exportSessionId, stage: "processing_started" });
    })().catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
  // Принимаем Blob URL только от собственного документа сборки архива.
  if (sender.url !== chrome.runtime.getURL("offscreen.html")) return;
  const meta = { exportSessionId: message.exportSessionId };
  if (message.type === "MAGNIFIC_ARCHIVE_PROGRESS") {
    notifyExportProgress(message.tabId, { ...meta, stage: "archive_progress", current: message.current, total: message.total });
    respond({ ok: true }); return;
  }
  if (message.type === "MAGNIFIC_ARCHIVE_HEARTBEAT") { respond({ ok: true }); return; }
  if (message.type === "MAGNIFIC_ARCHIVE_ERROR") {
    notifyExportProgress(message.tabId, { ...meta, stage: "error", error: message.error }); respond({ ok: true }); return;
  }
  if (message.type === "MAGNIFIC_ARCHIVE_READY") {
    void (async () => {
      const result = await downloadFile({ url: message.url, filename: message.filename, saveAs: false });
      if (!result.ok) { respond(result); return; }
      await chrome.storage.session.set({ [`export_download_${result.downloadId}`]: {
        tabId: message.tabId, exportSessionId: message.exportSessionId, url: message.url,
        imagesArchived: message.imagesArchived, imageFailures: message.imageFailures
      } });
      respond({ ok: true });
      notifyExportProgress(message.tabId, { ...meta, stage: "download_started" });
      // Маленький JSON может скачаться до записи downloadId в session storage.
      const [download] = await chrome.downloads.search({ id: result.downloadId });
      if (["complete", "interrupted"].includes(download?.state)) await finishDownload(result.downloadId, download.state, download.error);
    })().catch((error) => respond({ ok: false, error: error.message }));
    return true;
  }
});
