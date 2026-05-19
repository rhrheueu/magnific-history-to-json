const EXPORT_READY = "MAGNIFIC_EXPORT_READY";
const EXPORT_PROGRESS = "MAGNIFIC_EXPORT_PROGRESS";
const EXPORT_MODE_KEY = "exportMode";
const EXPORT_MODE_WITH_IMAGES = "with_images";
const EXPORT_MODE_TEXT_ONLY = "text_only";
const EXPORT_MODE_SET = new Set([EXPORT_MODE_WITH_IMAGES, EXPORT_MODE_TEXT_ONLY]);

const MENU_PARENT_ID = "magnific-export-menu-parent";
const MENU_WITH_IMAGES_ID = "magnific-export-mode-with-images";
const MENU_TEXT_ONLY_ID = "magnific-export-mode-text-only";
const IMAGE_HEAD_TIMEOUT_MS = 8000;
const IMAGE_GET_TIMEOUT_MS = 12000;

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

function removeAllContextMenus() {
  return new Promise((resolve) => {
    chrome.contextMenus.removeAll(() => resolve());
  });
}

function createContextMenu(props) {
  return new Promise((resolve) => {
    chrome.contextMenus.create(props, () => resolve());
  });
}

async function rebuildContextMenus() {
  const mode = await getExportMode();
  await removeAllContextMenus();

  await createContextMenu({
    id: MENU_PARENT_ID,
    contexts: ["action"],
    title: "Режим выгрузки"
  });

  await createContextMenu({
    id: MENU_WITH_IMAGES_ID,
    parentId: MENU_PARENT_ID,
    contexts: ["action"],
    type: "radio",
    title: "С картинками (по умолчанию)",
    checked: mode === EXPORT_MODE_WITH_IMAGES
  });

  await createContextMenu({
    id: MENU_TEXT_ONLY_ID,
    parentId: MENU_PARENT_ID,
    contexts: ["action"],
    type: "radio",
    title: "Только текст",
    checked: mode === EXPORT_MODE_TEXT_ONLY
  });
}

chrome.runtime.onInstalled.addListener(() => {
  void rebuildContextMenus();
});

chrome.runtime.onStartup.addListener(() => {
  void rebuildContextMenus();
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === MENU_WITH_IMAGES_ID) {
    void setExportMode(EXPORT_MODE_WITH_IMAGES);
    return;
  }

  if (info.menuItemId === MENU_TEXT_ONLY_ID) {
    void setExportMode(EXPORT_MODE_TEXT_ONLY);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  try {
    const exportMode = await getExportMode();

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (opts) => {
        window.__magnificExporterOptions = opts;
      },
      args: [{ exportMode }]
    });

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["parser.js"]
    });
  } catch (err) {
    console.error("Failed to inject parser.js:", err);
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

async function inspectImageUrl(url) {
  const attempts = ["HEAD", "GET"];

  for (const method of attempts) {
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(new Error(`Image ${method} request timed out after ${method === "HEAD" ? IMAGE_HEAD_TIMEOUT_MS : IMAGE_GET_TIMEOUT_MS}ms.`)),
      method === "HEAD" ? IMAGE_HEAD_TIMEOUT_MS : IMAGE_GET_TIMEOUT_MS
    );
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        credentials: "include",
        cache: "no-store",
        signal: controller.signal
      });
      const contentType = (response.headers.get("content-type") || "")
        .split(";")[0]
        .trim()
        .toLowerCase();
      const finalUrl = typeof response.url === "string" && response.url ? response.url : url;

      if (response.ok && contentType.startsWith("image/")) {
        return {
          ok: true,
          finalUrl,
          contentType
        };
      }

      if (method === "GET") {
        return {
          ok: false,
          finalUrl,
          contentType,
          statusCode: response.status || 0,
          note: contentType
            ? `Expected image/* but received ${contentType}.`
            : "Response did not expose an image content type."
        };
      }
    } catch (error) {
      if (method === "GET") {
        return {
          ok: false,
          finalUrl: url,
          contentType: "",
          statusCode: 0,
          note: error?.message || "Failed to validate image URL."
        };
      }
    } finally {
      clearTimeout(timeoutId);
    }
  }

  return {
    ok: false,
    finalUrl: url,
    contentType: "",
    statusCode: 0,
    note: "Image validation did not complete."
  };
}

async function inspectImageUrls(urls) {
  const uniqueUrls = Array.from(new Set(urls.filter((url) => /^https?:\/\//i.test(url))));
  const results = new Map();
  const queue = uniqueUrls.slice();
  const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
    while (queue.length) {
      const nextUrl = queue.shift();
      if (!nextUrl) continue;
      const result = await inspectImageUrl(nextUrl);
      results.set(nextUrl, result);
    }
  });
  await Promise.all(workers);
  return results;
}

function normalizeImageRecord(image) {
  return {
    id: typeof image?.id === "string" ? image.id : "",
    url: typeof image?.url === "string" ? image.url : "",
    file: typeof image?.file === "string" ? image.file : "",
    type: typeof image?.type === "string" ? image.type : "",
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
    model: typeof record?.model === "string" ? record.model : "",
    quality: typeof record?.quality === "string" ? record.quality : "",
    types: Array.isArray(record?.types) ? record.types.filter((value) => typeof value === "string") : [],
    resolutions: Array.isArray(record?.resolutions)
      ? record.resolutions.filter((value) => typeof value === "string")
      : [],
    tags: Array.isArray(record?.tags) ? record.tags.filter((value) => typeof value === "string") : [],
    images: Array.isArray(record?.images) ? record.images.map(normalizeImageRecord) : [],
    image_slot_count: Number.isFinite(record?.image_slot_count) ? Number(record.image_slot_count) : 0,
    missing_image_count: Number.isFinite(record?.missing_image_count) ? Number(record.missing_image_count) : 0,
    image_status: typeof record?.image_status === "string" ? record.image_status : ""
  };
}

async function prepareExportRecords(records, exportImages) {
  const normalizedRecords = Array.isArray(records) ? records.map(normalizeExportRecord) : [];
  const inspectResults = await inspectImageUrls(
    normalizedRecords.flatMap((record) => record.images.map((image) => image.url))
  );

  const imageDownloads = [];
  const preparedRecords = normalizedRecords.map((record) => {
    const images = record.images.map((image) => {
      if (!/^https?:\/\//i.test(image.url)) {
        return {
          ...image,
          file: "",
          status: "missing_preview",
          note: image.note || "No downloadable preview URL found in the feed item."
        };
      }

      const inspected = inspectResults.get(image.url);
      if (!inspected?.ok) {
        return {
          ...image,
          file: "",
          status: "skipped_non_image",
          content_type: inspected?.contentType || "",
          status_code: inspected?.statusCode || 0,
          note: inspected?.note || "Image URL validation failed."
        };
      }

      const validatedImage = {
        ...image,
        url: inspected.finalUrl || image.url,
        status: exportImages ? "validated" : "validated_not_downloaded",
        content_type: inspected.contentType || "",
        note: ""
      };

      if (exportImages && validatedImage.file) {
        imageDownloads.push({
          url: validatedImage.url,
          filename: validatedImage.file
        });
      }

      return validatedImage;
    });

    const imageSlotCount = images.length;
    const missingImageCount = images.filter(
      (image) => image.status === "missing_preview" || image.status === "skipped_non_image"
    ).length;
    const validatedImageCount = images.filter((image) => image.status.startsWith("validated")).length;

    return {
      ...record,
      images,
      image_slot_count: imageSlotCount,
      missing_image_count: missingImageCount,
      validated_image_count: validatedImageCount,
      image_status: imageSlotCount
        ? validatedImageCount === 0
          ? "all_missing_or_failed"
          : missingImageCount > 0
            ? "partial"
            : exportImages
              ? "validated"
              : "validated_not_downloaded"
        : "no_items_detected"
    };
  });

  return {
    records: preparedRecords,
    imageDownloads: Array.from(new Map(imageDownloads.map((entry) => [entry.filename, entry])).values())
  };
}

function buildPromptIssuesReport(records) {
  return records
    .filter((record) => record.prompt_needs_review)
    .map((record) => ({
      prompt_index: record.prompt_index,
      prompt: record.prompt,
      prompt_source: record.prompt_source,
      prompt_visible: record.prompt_visible,
      prompt_copied: record.prompt_copied,
      prompt_copy_status: record.prompt_copy_status,
      prompt_copy_attempts: record.prompt_copy_attempts,
      prompt_copy_error_code: record.prompt_copy_error_code,
      prompt_copy_error: record.prompt_copy_error,
      prompt_needs_review: record.prompt_needs_review,
      prompt_issue: record.prompt_issue,
      date_group: record.date_group,
      image_slot_count: record.image_slot_count,
      image_status: record.image_status
    }));
}

async function downloadImagesSequentially(entries) {
  let successCount = 0;
  let failedCount = 0;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    const result = await downloadFile({
      url: entry.url,
      filename: entry.filename,
      saveAs: false
    });
    if (result.ok) successCount++;
    else failedCount++;
    if (typeof entry?.onProgress === "function") {
      entry.onProgress({
        ok: result.ok,
        error: result.error || "",
        current: index + 1,
        total: entries.length,
        filename: entry.filename
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    successCount,
    failedCount,
    total: entries.length
  };
}

function buildDataUrlFromJson(value) {
  return "data:application/json;charset=utf-8," + encodeURIComponent(JSON.stringify(value, null, 2));
}

async function downloadJsonValue(value, filename, saveAs) {
  return downloadFile({
    url: buildDataUrlFromJson(value),
    filename,
    saveAs
  });
}

function notifyExportProgress(tabId, payload) {
  if (!Number.isFinite(tabId)) return;
  chrome.tabs.sendMessage(
    tabId,
    {
      type: EXPORT_PROGRESS,
      ...payload
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === "MAGNIFIC_GET_EXPORT_MODE") {
    void getExportMode().then((exportMode) => {
      sendResponse({ ok: true, exportMode });
    });
    return true;
  }

  if (message.type === "MAGNIFIC_SET_EXPORT_MODE") {
    void setExportMode(message.exportMode)
      .then(async (exportMode) => {
        await rebuildContextMenus();
        sendResponse({ ok: true, exportMode });
      })
      .catch((error) => {
        sendResponse({
          ok: false,
          error: error?.message || "Failed to update export mode."
        });
      });
    return true;
  }

  if (message.type === EXPORT_READY) {
    const filename =
      typeof message.filename === "string" && message.filename.trim()
        ? message.filename
        : `magnific_history_${new Date().toISOString().slice(0, 10)}.json`;
    const exportSessionId =
      typeof message.exportSessionId === "string" && message.exportSessionId.trim()
        ? message.exportSessionId
        : `session_${Date.now()}`;
    const tabId = Number.isFinite(sender?.tab?.id) ? sender.tab.id : null;
    const checkpointFilename = filename.replace(/\.json$/i, "_checkpoint.json");
    const promptIssuesFilename = filename.replace(/\.json$/i, "_prompt_copy_issues.json");

    void (async () => {
      const exportImages = message.exportImages !== false;
      const rawRecords =
        Array.isArray(message.records)
          ? message.records.map(normalizeExportRecord)
          : {
              records:
                typeof message.jsonText === "string"
                  ? JSON.parse(message.jsonText)
                  : Array.isArray(message.jsonText)
                    ? message.jsonText
                    : [],
              imageDownloads: Array.isArray(message.imageDownloads)
                ? message.imageDownloads
                    .filter((entry) => entry && typeof entry === "object")
                    .map((entry) => ({
                      url: typeof entry.url === "string" ? entry.url : "",
                      filename: typeof entry.filename === "string" ? entry.filename : ""
                    }))
                    .filter((entry) => /^https?:\/\//i.test(entry.url) && entry.filename)
                : []
            };
      const normalizedRecords = Array.isArray(rawRecords) ? rawRecords : rawRecords.records || [];
      const rawImageDownloads = Array.isArray(rawRecords?.imageDownloads) ? rawRecords.imageDownloads : [];
      const promptIssues = buildPromptIssuesReport(normalizedRecords);
      const checkpointResult = await downloadJsonValue(normalizedRecords, checkpointFilename, false);
      if (promptIssues.length) {
        await downloadJsonValue(promptIssues, promptIssuesFilename, false);
      }
      notifyExportProgress(tabId, {
        exportSessionId,
        stage: "checkpoint_saved",
        checkpointSaved: checkpointResult.ok,
        promptIssuesCount: promptIssues.length,
        imagesQueued: normalizedRecords.reduce(
          (sum, record) => sum + record.images.filter((image) => image.status === "pending_validation").length,
          0
        ),
        exportImages
      });
      sendResponse({
        ok: checkpointResult.ok,
        checkpointSaved: checkpointResult.ok,
        promptIssuesCount: promptIssues.length,
        imagesQueued: normalizedRecords.reduce(
          (sum, record) => sum + record.images.filter((image) => image.status === "pending_validation").length,
          0
        ),
        validationInBackground: exportImages
      });
      if (!checkpointResult.ok) return;

      if (exportImages) {
        notifyExportProgress(tabId, {
          exportSessionId,
          stage: "validating_images"
        });
      }
      const prepared = Array.isArray(message.records)
        ? await prepareExportRecords(normalizedRecords, exportImages)
        : {
            records: normalizedRecords,
            imageDownloads: rawImageDownloads
          };
      const jsonResult = await downloadJsonValue(prepared.records, filename, true);
      notifyExportProgress(tabId, {
        exportSessionId,
        stage: "final_json_saved",
        ok: jsonResult.ok,
        totalImages: prepared.imageDownloads.length
      });
      if (!jsonResult.ok) {
        notifyExportProgress(tabId, {
          exportSessionId,
          stage: "error",
          error: jsonResult.error || "Failed to save final JSON."
        });
        return;
      }
      if (promptIssues.length) {
        // Файл проблемных prompt'ов уже сохранён вместе с checkpoint.
      }
      if (!prepared.imageDownloads.length) {
        notifyExportProgress(tabId, {
          exportSessionId,
          stage: "complete",
          imagesDownloaded: 0,
          totalImages: 0
        });
        return;
      }
      notifyExportProgress(tabId, {
        exportSessionId,
        stage: "downloading_images",
        current: 0,
        total: prepared.imageDownloads.length
      });
      const imageDownloadStats = await downloadImagesSequentially(
        prepared.imageDownloads.map((entry) => ({
          ...entry,
          onProgress: (progress) => {
            notifyExportProgress(tabId, {
              exportSessionId,
              stage: "image_progress",
              ...progress
            });
          }
        }))
      );
      notifyExportProgress(tabId, {
        exportSessionId,
        stage: "complete",
        imagesDownloaded: imageDownloadStats.successCount,
        imageDownloadFailures: imageDownloadStats.failedCount,
        totalImages: imageDownloadStats.total
      });
    })().catch((error) => {
      console.error("Failed to prepare export payload:", error);
      notifyExportProgress(tabId, {
        exportSessionId,
        stage: "error",
        error: error?.message || "Failed to prepare export payload."
      });
      try {
        sendResponse({
          ok: false,
          error: error?.message || "Failed to prepare export payload."
        });
      } catch {}
    });

    return true;
  }
});
