const EXPORT_READY = "MAGNIFIC_EXPORT_READY";
const EXPORT_MODE_KEY = "exportMode";
const EXPORT_MODE_WITH_IMAGES = "with_images";
const EXPORT_MODE_TEXT_ONLY = "text_only";
const EXPORT_MODE_SET = new Set([EXPORT_MODE_WITH_IMAGES, EXPORT_MODE_TEXT_ONLY]);

const MENU_PARENT_ID = "magnific-export-menu-parent";
const MENU_WITH_IMAGES_ID = "magnific-export-mode-with-images";
const MENU_TEXT_ONLY_ID = "magnific-export-mode-text-only";

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
    try {
      const response = await fetch(url, {
        method,
        redirect: "follow",
        credentials: "include",
        cache: "no-store"
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

async function downloadImagesSequentially(entries) {
  for (const entry of entries) {
    await downloadFile({
      url: entry.url,
      filename: entry.filename,
      saveAs: false
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
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

    void (async () => {
      const exportImages = message.exportImages !== false;
      const prepared =
        Array.isArray(message.records)
          ? await prepareExportRecords(message.records, exportImages)
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

      const jsonText = JSON.stringify(prepared.records, null, 2);
      const dataUrl = "data:application/json;charset=utf-8," + encodeURIComponent(jsonText);

      const jsonResult = await downloadFile({
        url: dataUrl,
        filename,
        saveAs: true
      });
      if (!jsonResult.ok) return;
      if (!prepared.imageDownloads.length) return;
      await downloadImagesSequentially(prepared.imageDownloads);
    })().catch((error) => {
      console.error("Failed to prepare export payload:", error);
    });

    sendResponse({ ok: true });
  }
});
