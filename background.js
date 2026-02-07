const EXPORT_READY = "FREEPIK_EXPORT_READY";

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || !tab.id) return;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["parser.js"]
    });
  } catch (err) {
    console.error("Failed to inject parser.js:", err);
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;

  if (message.type === EXPORT_READY) {
    const jsonText =
      typeof message.jsonText === "string"
        ? message.jsonText
        : JSON.stringify(message.jsonText ?? [], null, 2);

    const filename =
      typeof message.filename === "string" && message.filename.trim()
        ? message.filename
        : `freepik_history_${new Date().toISOString().slice(0, 10)}.json`;

    const dataUrl =
      "data:application/json;charset=utf-8," + encodeURIComponent(jsonText);

    chrome.downloads.download(
      {
        url: dataUrl,
        filename,
        saveAs: true
      },
      () => {
        if (chrome.runtime.lastError) {
          console.error("Download failed:", chrome.runtime.lastError.message);
        }
      }
    );

    sendResponse({ ok: true });
  }
});
