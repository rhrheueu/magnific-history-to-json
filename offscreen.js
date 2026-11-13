(() => {
  const zipApi = typeof module !== "undefined" && module.exports ? require("./zip.js") : globalThis.MagnificZip;
  const assetApi = typeof module !== "undefined" && module.exports ? require("./report.js") : globalThis.MagnificReport;
  async function buildExport(job, progress = () => {}) {
    const records = structuredClone(job.records);
    for (const record of records) {
      for (const image of record.images) image.asset_kind = ["generation", "upload", "unknown"].includes(image.asset_kind)
        ? image.asset_kind : assetApi.getAssetKind(image.type);
      record.asset_kinds = [...new Set(record.images.map((image) => image.asset_kind))];
    }
    const uploadUrls = new Set(records.flatMap((record) => record.images.filter((image) => image.asset_kind === "upload").map((image) => image.url)));
    const urls = [...new Set(records.flatMap((record) => record.images.map((image) => image.url)).filter((url) => /^https?:\/\//i.test(url)))];
    const writer = job.exportImages ? new zipApi.ZipWriter() : null;
    const results = new Map();
    let completed = 0; let imagesArchived = 0; let imageFailures = 0;
    // Превью уже сжаты; ZIP STORE не тратит время на их повторное сжатие.
    // Обрабатываем каждый URL один раз и не держим дубликаты изображений в памяти.
    const queue = job.exportImages ? urls.slice() : [];
    progress({ current: 0, total: queue.length });
    await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
      while (queue.length) {
        const url = queue.shift();
        try {
          const response = await fetch(url, { credentials: "include", signal: AbortSignal.timeout(30000) });
          const contentType = (response.headers.get("content-type") || "").split(";")[0].toLowerCase().trim();
          if (!response.ok || !contentType.startsWith("image/")) throw new Error(`HTTP ${response.status}: ${contentType || "unknown content type"}`);
          const bytes = new Uint8Array(await response.arrayBuffer());
          if (!bytes.length) throw new Error("Пустой файл превью.");
          const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/avif": "avif", "image/gif": "gif", "image/bmp": "bmp", "image/svg+xml": "svg" })[contentType] || "img";
          const file = `${uploadUrls.has(url) ? "uploads" : "previews"}/image_${String(imagesArchived + 1).padStart(5, "0")}.${ext}`;
          writer.add(file, bytes); imagesArchived++;
          results.set(url, { file, status: "archived", content_type: contentType });
        } catch (error) {
          if (/Архив|ZIP|Unsafe/.test(error.message || "")) throw error;
          imageFailures++;
          results.set(url, { file: "", status: "download_failed", note: error.message || "Ошибка загрузки превью." });
        }
        completed++;
        progress({ current: completed, total: urls.length });
      }
    }));
    for (const record of records) {
      record.images = record.images.map((image) => ({ ...image,
        ...(image.url ? job.exportImages ? results.get(image.url) || { file: "", status: "download_failed", note: "Неподдерживаемая ссылка." }
          : { file: "", status: "not_downloaded", note: "Режим только JSON: ссылка не проверялась." }
          : { file: "", status: "missing_preview", note: "В карточке отсутствует превью." }) }));
      record.image_slot_count = record.images.length;
      record.missing_image_count = record.images.filter((image) => !["archived", "not_downloaded"].includes(image.status)).length;
      record.validated_image_count = record.images.filter((image) => image.status === "archived").length;
      record.image_status = !record.images.length ? "no_items_detected" : record.missing_image_count ? "partial" : job.exportImages ? "archived" : "not_downloaded";
    }
    const jsonText = JSON.stringify(records, null, 2);
    if (!writer) return { blob: new Blob([jsonText], { type: "application/json" }), imagesArchived: 0, imageFailures: 0 };
    const basename = job.filename.replace(/\.json$/i, "");
    writer.add(`${basename}.json`, jsonText);
    writer.add("export_summary.json", JSON.stringify({
      exported_at: new Date().toISOString(), records: records.length, images_archived: imagesArchived,
      image_failures: imageFailures, missing_preview_slots: records.reduce((sum, record) => sum + record.missing_image_count, 0),
      report_period: job.period || records[0]?.report_period || null,
      uploads_archived: Array.from(results.values()).filter((image) => image.status === "archived" && image.file.startsWith("uploads/")).length,
      export_status: job.exportStatus || records[0]?.export_status || "finished",
      note: "Распакуйте архив целиком: images[].file содержит путь относительно JSON."
    }, null, 2));
    return { blob: writer.blob(), imagesArchived, imageFailures };
  }
  if (typeof module !== "undefined" && module.exports) { module.exports = { buildExport }; return; }
  const objectUrls = new Set();
  let queue = Promise.resolve();
  const send = (message) => chrome.runtime.sendMessage(message).catch(() => {});
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (message?.target !== "offscreen") return;
    if (message.type === "MAGNIFIC_RELEASE_BLOB") {
      if (objectUrls.delete(message.url)) URL.revokeObjectURL(message.url);
      respond({ ok: true }); return;
    }
    if (message.type !== "MAGNIFIC_BUILD_ARCHIVE") return;
    respond({ ok: true });
    const job = message;
    queue = queue.then(async () => {
      const meta = { tabId: job.tabId, exportSessionId: job.exportSessionId };
      // Поддерживает связь с фоновым процессом при больших периодах.
      const heartbeat = setInterval(() => void send({ type: "MAGNIFIC_ARCHIVE_HEARTBEAT", ...meta }), 15000);
      try {
        const result = await buildExport(job, (progress) => void send({ type: "MAGNIFIC_ARCHIVE_PROGRESS", ...meta, ...progress }));
        const url = URL.createObjectURL(result.blob); objectUrls.add(url);
        const response = await chrome.runtime.sendMessage({ type: "MAGNIFIC_ARCHIVE_READY", ...meta, url,
          filename: job.exportImages ? job.filename.replace(/\.json$/i, ".zip") : job.filename,
          imagesArchived: result.imagesArchived, imageFailures: result.imageFailures });
        if (!response?.ok) { objectUrls.delete(url); URL.revokeObjectURL(url); throw new Error(response?.error || "Не удалось начать скачивание."); }
      } catch (error) {
        await send({ type: "MAGNIFIC_ARCHIVE_ERROR", ...meta, error: error.message || String(error) });
      } finally { clearInterval(heartbeat); }
    }).catch(() => {});
  });
})();
