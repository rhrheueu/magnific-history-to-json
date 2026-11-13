(() => {
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();
  function parameterKind(value) {
    const text = clean(value);
    if (/^\d+(?:[.,]\d+)?\s*fps$/i.test(text)) return "fps";
    if (/^\d+(?:[.,]\d+)?\s*(?:sec(?:onds?)?|s|сек(?:унд[аы]?)?)$/i.test(text)) return "duration";
    if (/^\d+\s*[:/]\s*\d+$/.test(text)) return "aspect_ratio";
    if (/^(?:\d+\s*[x×]\s*\d+|\d+(?:[.,]\d+)?\s*[kp])$/i.test(text)) return "resolution";
    if (/^(?:auto|default|max|high|low|medium|standard|ultra|hd|full hd|высок(?:ий|ое|ая)|низк(?:ий|ое|ая)|средн(?:ий|ее|яя)|thinking(?:\s+(?:high|low|medium|fast))?|(?:no\s+)?audio|sound(?:\s+(?:on|off))?)$/i.test(text)) return "setting";
    return "";
  }
  function deriveMetadata(tags, items) {
    const values = [...new Set((tags || []).map(clean).filter(Boolean))];
    const uploadsOnly = items.length > 0 && items.every((item) => /^(?:(?:audio|image|video)[ _-]+)?upload(?:[ _-]|$)/i.test(item.alt || ""));
    const parameters = values.filter(parameterKind).map((value) => ({ kind: parameterKind(value), value }));
    const quality = values.find((v) => /^(?:auto|default|max|high|low|medium|standard|ultra|высок(?:ий|ое|ая)|низк(?:ий|ое|ая)|средн(?:ий|ее|яя))$/i.test(v)) || "";
    // Configuration tags are never candidates for the model, including unknown future models.
    const candidates = values.filter((v) => !parameterKind(v) && /\p{L}/u.test(v));
    const model = uploadsOnly ? "" : candidates[0] || "";
    return { model, quality: uploadsOnly ? "" : quality, parameters: uploadsOnly ? [] : parameters };
  }

  function gridsForHeader(header, byIndex) {
    if (!header || !Number.isFinite(header.index)) return [];
    const grids = header.hasGrid ? [header] : [];
    // One family can span several grid rows. A missing index or the next header ends
    // this visible contiguous run. Never borrow a previous row or skip a header/gap.
    for (let index = header.index + 1; ; index++) {
      const next = byIndex.get(index);
      if (!next || next.header || !next.hasGrid) break;
      grids.push(next);
    }
    return grids;
  }

  function assignGridOwners(containers, knownOwners) {
    const ordered = containers.filter((c) => Number.isFinite(c.index)).slice().sort((a,b) => a.index-b.index);
    // Remember observed ownership across virtualized rows, never across an unseen gap.
    for (const c of ordered) {
      if (c.header) knownOwners.set(c.index, c.index);
      else if (!c.hasGrid) knownOwners.delete(c.index);
    }
    const result = [];
    for (const c of ordered) {
      if (!c.hasGrid) continue;
      const owner = c.header ? c.index : knownOwners.get(c.index-1);
      if (!Number.isFinite(owner)) continue;
      knownOwners.set(c.index, owner);
      result.push({ grid: c, headerIndex: owner });
    }
    return result;
  }

  function parseItems(container) {
    const roots = [...container.querySelectorAll('[data-cy="main-feed-item"]')];
    const items = [], seen = new Set();
    for (const root of roots) {
      const id = root.getAttribute("data-item") || "";
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const media = root.querySelector('[data-cy^="generated-"]');
      const cy = media?.getAttribute("data-cy") || "";
      const img = media?.querySelector("img") || root.querySelector("img");
      const video = root.querySelector("video");
      const videoCard = !!root.querySelector('[data-cy="main-feed-video-item"]') || cy === "generated-video-generator" || !!video;
      const fromMarker = cy.startsWith("generated-") ? cy.slice("generated-".length) : "";
      const alt = fromMarker || clean(img?.getAttribute("alt")) || (videoCard ? "video-generator" : "");
      const mediaType = /audio/i.test(fromMarker) || root.querySelector("audio") ? "audio" : videoCard || /video/i.test(fromMarker) ? "video" : img || fromMarker ? "image" : "unknown";
      const thumbnail = img?.currentSrc || img?.getAttribute("src") || video?.getAttribute("poster") || "";
      const badgeTexts = [...root.querySelectorAll('[data-cy="thumbnail-badge"]')].map((e) => clean(e.textContent));
      const resolution = badgeTexts.find((v) => parameterKind(v) === "resolution") || "";
      const icon = root.querySelector('[data-cy="thumbnail-icon-badge"] use');
      items.push({ id, alt, media_type: mediaType, thumbnail, resolution,
        icon: icon?.getAttribute("xlink:href") || icon?.getAttribute("href") || "" });
    }
    return items;
  }
  function previewUrl(value, base) {
    if (!clean(value)) return "";
    try {
      const url = new URL(value, base);
      return /^https?:$/.test(url.protocol) && url.href !== base ? url.href : "";
    } catch { return ""; }
  }
  function withoutLocalFiles(records) {
    return records.map((row) => {
      const images = row.images.map((image) => ({ ...image, file: "", status: image.url ? "not_downloaded" : "missing_preview", note: image.url ? "JSON без архива: превью не сохранено, исходная ссылка оставлена." : "В карточке нет адреса превью." }));
      return { ...row, images, image_slot_count: images.length, validated_image_count: 0,
        missing_image_count: images.filter((i) => !i.url).length,
        image_status: !images.length ? "no_items_detected" : images.some((i) => !i.url) ? "partial" : "not_downloaded" };
    });
  }
  const api = { parameterKind, deriveMetadata, gridsForHeader, assignGridOwners, parseItems, previewUrl, withoutLocalFiles };
  globalThis.MagnificFeed = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();
