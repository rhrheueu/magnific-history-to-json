(() => {
  const encoder = new TextEncoder();
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let bit = 0; bit < 8; bit++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0);
    table[i] = c >>> 0;
  }
  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }
  class ZipWriter {
    constructor() { this.parts = []; this.central = []; this.offset = 0; this.count = 0; }
    add(name, bytes) {
      if (typeof bytes === "string") bytes = encoder.encode(bytes);
      if (!(bytes instanceof Uint8Array)) throw new Error("Expected UTF-8 text or Uint8Array.");
      if (!name || name.startsWith("/") || name.includes("\\") || name.split("/").includes("..")) throw new Error("Unsafe ZIP path.");
      const filename = encoder.encode(name);
      if (filename.length > 65535 || this.count >= 65534 || this.offset + bytes.length + filename.length + 30 > 0xffffffff) {
        throw new Error("Архив слишком большой. Выберите более короткий период.");
      }
      const crc = crc32(bytes);
      const local = new Uint8Array(30 + filename.length);
      const lv = new DataView(local.buffer);
      lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, 0x800, true);
      lv.setUint16(12, 33, true); // 1980-01-01, допустимая дата DOS.
      lv.setUint32(14, crc, true); lv.setUint32(18, bytes.length, true); lv.setUint32(22, bytes.length, true);
      lv.setUint16(26, filename.length, true); local.set(filename, 30);
      const central = new Uint8Array(46 + filename.length);
      const cv = new DataView(central.buffer);
      cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, 0x800, true);
      cv.setUint16(14, 33, true); cv.setUint32(16, crc, true); cv.setUint32(20, bytes.length, true); cv.setUint32(24, bytes.length, true);
      cv.setUint16(28, filename.length, true); cv.setUint32(42, this.offset, true); central.set(filename, 46);
      this.parts.push(local, bytes); this.central.push(central);
      this.offset += local.length + bytes.length; this.count++;
    }
    blob() {
      const size = this.central.reduce((sum, bytes) => sum + bytes.length, 0);
      if (this.offset + size + 22 > 0xffffffff) throw new Error("Архив больше 4 ГБ. Выберите более короткий период.");
      const end = new Uint8Array(22); const view = new DataView(end.buffer);
      view.setUint32(0, 0x06054b50, true); view.setUint16(8, this.count, true); view.setUint16(10, this.count, true);
      view.setUint32(12, size, true); view.setUint32(16, this.offset, true);
      return new Blob([...this.parts, ...this.central, end], { type: "application/zip" });
    }
  }
  const api = { ZipWriter, crc32 };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else globalThis.MagnificZip = api;
})();
