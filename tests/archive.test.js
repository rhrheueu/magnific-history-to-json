const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { ZipWriter, crc32 } = require('../zip.js');
const { buildExport } = require('../offscreen.js');

test('CRC32 соответствует эталону ZIP, небезопасные пути отклоняются', () => {
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
  for (const name of ['../x', '/abs', 'a/../b', 'a\\b']) assert.throws(() => new ZipWriter().add(name, 'x'));
  const writer = new ZipWriter(); writer.offset = 0xffffffff;
  assert.throws(() => writer.add('large', 'x'), /слишком большой/);
});
async function inspectZip(blob, script) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'magnific-zip-test-'));
  try {
    const file = path.join(dir, 'export.zip'); await fs.writeFile(file, new Uint8Array(await blob.arrayBuffer()));
    execFileSync('python3', ['-c', 'import zipfile,json,sys\nz=zipfile.ZipFile(sys.argv[1])\nassert z.testzip() is None\n' + script, file]);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

test('ZIP читается стандартным распаковщиком: UTF-8 имена, содержимое и CRC', async () => {
  const zip = new ZipWriter(); zip.add('отчёт.json', '{"ok":true}'); zip.add('previews/a.png', new Uint8Array([1,2,3]));
  await inspectZip(zip.blob(), 'assert json.loads(z.read("отчёт.json"))["ok"]\nassert z.read("previews/a.png")==bytes([1,2,3])');
});

test('один ZIP содержит JSON и превью, повторные URL скачиваются один раз, HTML отмечен ошибкой', async () => {
  const previous = global.fetch; const calls = [];
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jOc8AAAAASUVORK5CYII=', 'base64');
  global.fetch = async (url) => { calls.push(url); return url.endsWith('bad') ? new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } }) : new Response(png, { headers: { 'Content-Type': 'image/png' } }); };
  try {
    const records = [{ images: [{ url:'https://example.test/a', file:'old/path' }, { url:'https://example.test/a' }, { url:'https://example.test/bad' }, { url:'' }], export_status:'finished' }];
    const result = await buildExport({ records, filename:'report.json', exportImages:true, period:{ preset:'last3Months' } });
    assert.equal(calls.length, 2); assert.equal(result.imagesArchived, 1); assert.equal(result.imageFailures, 1);
    assert.equal(records[0].images[0].file, 'old/path'); // Исходные записи не мутируются.
    await inspectZip(result.blob, 'r=json.loads(z.read("report.json"))[0]\nassert r["images"][0]["file"]==r["images"][1]["file"]\nassert z.read(r["images"][0]["file"]).startswith(b"\\x89PNG")\nassert r["images"][2]["status"]=="download_failed"\nassert r["missing_image_count"]==2\nassert json.loads(z.read("export_summary.json"))["report_period"]["preset"]=="last3Months"');
  } finally { global.fetch = previous; }
});

test('только JSON не запрашивает картинки и не содержит ложных путей на диске', async () => {
  const previous = global.fetch; global.fetch = () => { throw new Error('Unexpected network'); };
  try {
    const result = await buildExport({ records:[{ images:[{ url:'https://example.test/a', file:'old/path' }] }], filename:'report.json', exportImages:false });
    const [record] = JSON.parse(await result.blob.text());
    assert.equal(record.images[0].file, ''); assert.equal(record.images[0].status, 'not_downloaded');
  } finally { global.fetch = previous; }
});

test('пустая история сохраняет период и итог в сводке архива', async () => {
  const result = await buildExport({ records:[], filename:'empty.json', exportImages:true, period:{ preset:'last6Months' } });
  await inspectZip(result.blob, 'assert json.loads(z.read("empty.json"))==[]\nassert json.loads(z.read("export_summary.json"))["report_period"]["preset"]=="last6Months"');
});


test('загрузки сохраняются в uploads с пометками, генерации остаются в previews', async () => {
  const previous=global.fetch;
  global.fetch=async()=>new Response(new Uint8Array([1,2,3]),{headers:{'Content-Type':'image/png'}});
  try {
    const result=await buildExport({filename:'kinds.json',exportImages:true,records:[
      {images:[{url:'https://example.test/reference',type:'upload reference'}]},
      {images:[{url:'https://example.test/generation',type:'text to image'}]}
    ]});
    await inspectZip(result.blob,'r=json.loads(z.read("kinds.json"))\nassert r[0]["images"][0]["asset_kind"]=="upload"\nassert r[0]["images"][0]["file"].startswith("uploads/")\nassert r[1]["images"][0]["asset_kind"]=="generation"\nassert r[1]["images"][0]["file"].startswith("previews/")\nassert json.loads(z.read("export_summary.json"))["uploads_archived"]==1');
  } finally {global.fetch=previous;}
});

for(const [label,reply] of [
 ['HTTP 403',()=>new Response('denied',{status:403})],['HTTP 404',()=>new Response('missing',{status:404})],['HTTP 429',()=>new Response('rate limit',{status:429})],
 ['JSON вместо изображения',()=>new Response('{}',{headers:{'Content-Type':'application/json'}})],
 ['пустое изображение',()=>new Response(new Uint8Array(),{headers:{'Content-Type':'image/png'}})],
 ['сбой сети',()=>{throw new TypeError('Network failed');}],['таймаут',()=>{throw new DOMException('Timed out','TimeoutError');}]
])test('архив продолжает работу: '+label,async()=>{const prev=global.fetch;global.fetch=async()=>reply();try{const result=await buildExport({records:[{images:[{url:'https://example.test/bad'}]}],filename:'failure.json',exportImages:true});assert.equal(result.imagesArchived,0);assert.equal(result.imageFailures,1);await inspectZip(result.blob,'r=json.loads(z.read("failure.json"))[0]\nassert r["images"][0]["status"]=="download_failed"\nassert r["images"][0]["file"]==""\nassert r["images"][0]["note"]');}finally{global.fetch=prev;}});
test('неподдерживаемая ссылка и отсутствие ссылки не запрашиваются',async()=>{const prev=global.fetch;global.fetch=async()=>{throw Error('must not fetch');};try{const result=await buildExport({records:[{images:[{url:'file:///tmp/x.png'},{url:''}]}],filename:'links.json',exportImages:true});await inspectZip(result.blob,'r=json.loads(z.read("links.json"))[0]\nassert r["images"][0]["status"]=="download_failed"\nassert r["images"][1]["status"]=="missing_preview"');}finally{global.fetch=prev;}});
test('общий URL референса и генерации скачивается один раз, роли сохраняются',async()=>{const prev=global.fetch;let calls=0;global.fetch=async()=>{calls++;return new Response(new Uint8Array([1]),{headers:{'Content-Type':'image/png'}});};try{const result=await buildExport({records:[{images:[{url:'https://example.test/shared',type:'upload reference'},{url:'https://example.test/shared',type:'text to image'}]}],filename:'shared.json',exportImages:true});assert.equal(calls,1);await inspectZip(result.blob,'r=json.loads(z.read("shared.json"))[0]\nassert r["images"][0]["file"]==r["images"][1]["file"]\nassert r["images"][0]["file"].startswith("uploads/")\nassert r["images"][0]["asset_kind"]=="upload"\nassert r["images"][1]["asset_kind"]=="generation"');}finally{global.fetch=prev;}});
test('Stop сохраняется в JSON и сводке, включая пустой отчёт',async()=>{for(const records of [[],[{export_status:'stopped',images:[]}]]){const result=await buildExport({records,filename:'stopped.json',exportImages:true,exportStatus:'stopped',period:{start:'2026-10-21',end:'2026-11-13'}});await inspectZip(result.blob,'s=json.loads(z.read("export_summary.json"))\nassert s["export_status"]=="stopped"\nassert s["report_period"]["start"]=="2026-10-21"');}});
test('границы ZIP32: число файлов, UTF-8 имя и размер каталога',()=>{let z=new ZipWriter();z.count=65534;assert.throws(()=>z.add('a','x'),/слишком большой/);z=new ZipWriter();assert.throws(()=>z.add('а'.repeat(40000),'x'),/слишком большой/);z=new ZipWriter();z.offset=0xffffffff-10;assert.throws(()=>z.blob(),/4 ГБ/);});
