const EXPORT_READY = "FREEPIK_EXPORT_READY";
const EXPORT_MODE_KEY = "exportMode";
const EXPORT_MODE_WITH_IMAGES = "with_images";
const EXPORT_MODE_TEXT_ONLY = "text_only";
const EXPORT_MODE_SET = new Set([EXPORT_MODE_WITH_IMAGES, EXPORT_MODE_TEXT_ONLY]);

const MENU_PARENT_ID = "freepik-export-menu-parent";
const MENU_WITH_IMAGES_ID = "freepik-export-mode-with-images";
const MENU_TEXT_ONLY_ID = "freepik-export-mode-text-only";

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
        window.__freepikExporterOptions = opts;
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

  if (message.type === "FREEPIK_GET_EXPORT_MODE") {
    void getExportMode().then((exportMode) => {
      sendResponse({ ok: true, exportMode });
    });
    return true;
  }

  if (message.type === "FREEPIK_SET_EXPORT_MODE") {
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
    const jsonText =
      typeof message.jsonText === "string"
        ? message.jsonText
        : JSON.stringify(message.jsonText ?? [], null, 2);

    const filename =
      typeof message.filename === "string" && message.filename.trim()
        ? message.filename
        : `freepik_history_${new Date().toISOString().slice(0, 10)}.json`;

    const imageDownloads = Array.isArray(message.imageDownloads)
      ? message.imageDownloads
          .filter((entry) => entry && typeof entry === "object")
          .map((entry) => ({
            url: typeof entry.url === "string" ? entry.url : "",
            filename: typeof entry.filename === "string" ? entry.filename : ""
          }))
          .filter((entry) => /^https?:\/\//i.test(entry.url) && entry.filename)
      : [];

    const dataUrl =
      "data:application/json;charset=utf-8," + encodeURIComponent(jsonText);

    void downloadFile({
      url: dataUrl,
      filename,
      saveAs: true
    }).then(async (jsonResult) => {
      if (!jsonResult.ok) return;
      if (!imageDownloads.length) return;
      await downloadImagesSequentially(imageDownloads);
    });

    sendResponse({ ok: true, imagesQueued: imageDownloads.length });
  }
});
