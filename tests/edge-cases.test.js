const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Report=require('../report.js');
const Feed=require('../feed.js');
for(const locale of ['ru','es','pt-br','fr','de','it','ja','zh-cn','es-419','RU']) {
 test('маршрут: '+locale,()=>{assert.equal(Report.isSupportedPage(`https://www.magnific.com/${locale}/app/projects/all-assets?x=1#top`),true);});
}
for(const url of ['https://example.com/app/projects/all-assets','https://notmagnific.com/app/projects/all-assets','https://magnific.com.evil.test/app/projects/all-assets','https://magnific.com@evil.test/app/projects/all-assets','https://www.magnific.com/app/projects-fake','https://www.magnific.com/app/ai-image-generator','https://www.magnific.com/app','http://magnific.com/app/projects/all-assets','ftp://magnific.com/app/projects/all-assets','file:///tmp/report.html','chrome://extensions/','chrome-extension://test/start.html','javascript:alert(1)','https://www.magnific.com/ru/es/app/projects/all-assets']) {
 test('отказ адреса: '+url,()=>assert.equal(Report.isSupportedPage(url),false));
}
for(const invalid of ['2026-02-29','1900-02-29','2026-04-31','2026-13-01','2026-00-01','2026-11-00','2026-1-01','13.11.2026','2026/11/13','0000-01-01','2026-10-21T00:00:00Z']) {
 test('неверная дата: '+invalid,()=>assert.throws(()=>Report.resolvePeriod(invalid,'2026-11-13',new Date(2026,10,13))));
}
test('високосные и однодневные периоды не меняют границы',()=>{for(const date of ['2000-02-29','2024-02-29','2026-11-13']){const p=Report.resolvePeriod(date,date,new Date(2026,10,13));assert.equal(p.start,date);assert.equal(p.effective_end,date);}});
test('даты 20-го и 25-го дают один отчёт 21-20, январь переходит через год',()=>{assert.deepEqual(Report.defaultPeriod(new Date(2026,10,20)),Report.defaultPeriod(new Date(2026,10,25)));assert.deepEqual(Report.defaultPeriod(new Date(2026,0,1)),{start:'2025-12-21',end:'2026-01-20'});});
test('активность страницы: документ скрыт, Chrome active/inactive, ошибка канала',async()=>{
 const ctx={document:{hidden:true},chrome:{runtime:{sendMessage(m,cb){cb({ok:true,active:true});}}}};vm.runInNewContext(fs.readFileSync(require.resolve('../report.js'),'utf8'),ctx);const api=ctx.MagnificReport;
 assert.equal(await api.isPageActive(),false);ctx.document.hidden=false;assert.equal(await api.isPageActive(),true);
 ctx.chrome.runtime.sendMessage=(m,cb)=>cb({ok:true,active:false});assert.equal(await api.isPageActive(),false);
 ctx.chrome.runtime.sendMessage=(m,cb)=>cb(undefined);await assert.rejects(api.isPageActive(),/Перезагрузите/);
});
test('большая многострочная группа сохраняет все 1000 карточек владения',()=>{const owners=new Map();for(let start=0;start<1000;start+=10){const blocks=Array.from({length:10},(_,i)=>({index:start+i,header:start+i===0?{}:null,hasGrid:start+i>0}));for(const result of Feed.assignGridOwners(blocks,owners))assert.equal(result.headerIndex,0);}assert.equal(owners.get(999),0);});
