const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');

function backgroundFixture({ injectionFailure = false, downloadState = 'complete', downloadError = '', tabActive = true, windowState = 'normal', existingOffscreen = true, storedSession = {} } = {}) {
  const listeners = {}; const downloads = []; const progress = []; const messages = []; const session = storedSession; const local = {}; const injections = []; const createdTabs = []; let offscreenCreated=0;
  const event = (name) => ({ addListener(fn) { listeners[name] = fn; } });
  const chrome = {
    runtime: { onInstalled:event('installed'), onStartup:event('startup'), onMessage:event('message'),
      getURL:(path)=>`chrome-extension://test/${path}`, getContexts:async()=>existingOffscreen?[{}]:[],
      sendMessage:async(message)=>{messages.push(message);return {ok:true};} },
    contextMenus:{onClicked:event('menu')}, action:{onClicked:event('action')},
    storage:{local:{get(keys,cb){cb({...local});},set(value,cb){Object.assign(local,value);cb();}},session:{get:async(key)=>({[key]:session[key]}),set:async(value)=>Object.assign(session,value),remove:async(key)=>{delete session[key];}}},
    tabs:{get:async(id)=>({id,active:tabActive,windowId:1}),create:async(options)=>{createdTabs.push(options);},sendMessage(tabId,message,cb){progress.push({tabId,...message});cb();}},
    windows:{get:async()=>({state:windowState})},
    downloads:{onChanged:event('download'), download(options,cb){downloads.push(options);if(downloadError)chrome.runtime.lastError={message:downloadError};cb(downloadError?undefined:7);delete chrome.runtime.lastError;},search:async()=>[{state:downloadState}]},
    scripting:{executeScript:async(options)=>{if(injectionFailure)throw new Error("Protected page");injections.push(options);}},
    offscreen:{createDocument:async()=>{offscreenCreated++;}}
  };
  vm.runInNewContext(fs.readFileSync(require.resolve('../background.js'),'utf8'),{chrome,console:{...console,error(){}}});
  const send = (message,sender) => new Promise((resolve)=>listeners.message(message,sender,resolve));
  return {send,downloads,progress,messages,session,local,injections,createdTabs,clickAction:listeners.action,listeners,chrome,getOffscreenCreated:()=>offscreenCreated};
}

test('сборка передаётся в offscreen, а период сохраняется даже у пустого отчёта',async()=>{
  const bg=backgroundFixture();
  const response=await bg.send({type:'MAGNIFIC_EXPORT_READY',records:[],filename:'report.json',period:{preset:'last6Months'},exportImages:true,exportSessionId:'test'},{tab:{id:12}});
  assert.equal(response.ok,true);
  assert.equal(bg.messages[0].target,'offscreen');
  assert.equal(bg.messages[0].period.preset,'last6Months');
  assert.equal(bg.downloads.length,0);
});

test('одна автоматическая загрузка ZIP, завершение подтверждается Chrome, Blob освобождается',async()=>{
  const bg=backgroundFixture();
  await bg.send({type:'MAGNIFIC_ARCHIVE_READY',url:'blob:test',filename:'report.zip',tabId:12,exportSessionId:'test',imagesArchived:3,imageFailures:1},{url:'chrome-extension://test/offscreen.html'});
  await new Promise(setImmediate);
  assert.equal(bg.downloads.length,1);
  assert.equal(bg.downloads[0].saveAs,false);
  assert.equal(bg.downloads[0].filename,'report.zip');
  const result=bg.progress.find((item)=>item.stage==='complete');
  assert.equal(result.imagesArchived,3); assert.equal(result.imageFailures,1);
  assert.ok(bg.messages.some((item)=>item.type==='MAGNIFIC_RELEASE_BLOB'&&item.url==='blob:test'));
  assert.equal(Object.keys(bg.session).length,0);
});

test('ссылка на архив от веб-страницы не запускает скачивание',()=>{
  const bg=backgroundFixture();
  void bg.send({type:'MAGNIFIC_ARCHIVE_READY',url:'blob:untrusted',filename:'bad.zip'},{tab:{id:1},url:'https://www.magnific.com/app/projects/all-assets'});
  assert.equal(bg.downloads.length,0);
});


test('диагностический JSON действует один раз и автоматически возвращает картинки',async()=>{
  const bg=backgroundFixture();
  await bg.send({type:'MAGNIFIC_SET_EXPORT_MODE',exportMode:'text_only'},{});
  await bg.clickAction({id:9});
  assert.equal(bg.injections[0].args[0].exportMode,'text_only');
  assert.equal(bg.local.exportMode,'with_images');
  await bg.clickAction({id:10});
  assert.equal(bg.injections[2].args[0].exportMode,'with_images');
});

test('на служебной странице открывает страницу помощи с переходом в Magnific',async()=>{
 const bg=backgroundFixture({injectionFailure:true});
 await bg.clickAction({id:12});
 assert.equal(bg.createdTabs.length,1);
 assert.equal(bg.createdTabs[0].url,'chrome-extension://test/start.html');
});

for(const [name,tabActive,windowState,expected] of [['активная',true,'normal',true],['фоновая',false,'normal',false],['свёрнутое окно',true,'minimized',false],['другое приложение',true,'normal',true]]) {
 test('активность Chrome: '+name,async()=>{const bg=backgroundFixture({tabActive,windowState});const result=await bg.send({type:'MAGNIFIC_GET_TAB_ACTIVITY'},{tab:{id:12}});assert.equal(result.ok,true);assert.equal(result.active,expected);});
}
test('активность: нет отправителя или вкладка закрылась',async()=>{
 const bg=backgroundFixture();assert.equal((await bg.send({type:'MAGNIFIC_GET_TAB_ACTIVITY'},{})).ok,false);
 bg.chrome.tabs.get=async()=>{throw Error('Tab closed');};assert.equal((await bg.send({type:'MAGNIFIC_GET_TAB_ACTIVITY'},{tab:{id:12}})).ok,false);
});
test('без вкладки действие не вызывает инъекцию',async()=>{const bg=backgroundFixture();await bg.clickAction(undefined);assert.equal(bg.injections.length,0);});
test('неизвестный режим возвращается к картинкам',async()=>{const bg=backgroundFixture();bg.local.exportMode='unknown';await bg.clickAction({id:1});assert.equal(bg.injections[0].args[0].exportMode,'with_images');assert.deepEqual(Array.from(bg.injections[1].files),['report.js','feed.js','parser.js']);});
test('пустые/невалидные данные экспорта отклоняются до сборки',async()=>{const bg=backgroundFixture();for(const records of [null,{},'bad'])assert.equal((await bg.send({type:'MAGNIFIC_EXPORT_READY',records},{tab:{id:1}})).ok,false);assert.equal((await bg.send({type:'MAGNIFIC_EXPORT_READY',records:[]},{})).ok,false);assert.equal(bg.messages.length,0);});
test('ошибка Chrome Downloads возвращается сборщику',async()=>{const bg=backgroundFixture({downloadError:'USER_CANCELED'});const result=await bg.send({type:'MAGNIFIC_ARCHIVE_READY',url:'blob:sample',filename:'report.zip',tabId:12},{url:'chrome-extension://test/offscreen.html'});assert.equal(result.ok,false);assert.equal(result.error,'USER_CANCELED');assert.equal(Object.keys(bg.session).length,0);});
test('прерывание загрузки освобождает Blob и сообщает ошибку один раз',async()=>{
 const bg=backgroundFixture({downloadState:'in_progress'});await bg.send({type:'MAGNIFIC_ARCHIVE_READY',url:'blob:sample',filename:'report.zip',tabId:12},{url:'chrome-extension://test/offscreen.html'});
 bg.listeners.download({id:7,state:{current:'interrupted'},error:{current:'NETWORK_FAILED'}});bg.listeners.download({id:7,state:{current:'interrupted'}});await new Promise(setImmediate);
 assert.equal(bg.progress.filter(p=>p.stage==='error').length,1);assert.equal(bg.messages.filter(m=>m.type==='MAGNIFIC_RELEASE_BLOB').length,1);assert.equal(Object.keys(bg.session).length,0);
});
test('новый фоновый процесс завершает сохранённую загрузку',async()=>{const bg=backgroundFixture({storedSession:{export_download_9:{tabId:12,url:'blob:old',imagesArchived:2,exportSessionId:'restored'}}});bg.listeners.download({id:9,state:{current:'complete'}});await new Promise(setImmediate);assert.equal(bg.progress[0].stage,'complete');assert.equal(bg.progress[0].imagesArchived,2);assert.equal(Object.keys(bg.session).length,0);});
test('параллельные запросы используют одно создание offscreen',async()=>{const bg=backgroundFixture({existingOffscreen:false});await Promise.all([1,2].map(id=>bg.send({type:'MAGNIFIC_EXPORT_READY',records:[],filename:'report.json'},{tab:{id}})));assert.equal(bg.getOffscreenCreated(),1);});
test('ошибка сборки передаётся в интерфейс исходной сессии',async()=>{const bg=backgroundFixture();await bg.send({type:'MAGNIFIC_ARCHIVE_ERROR',tabId:12,error:'ZIP limit',exportSessionId:'a'},{url:'chrome-extension://test/offscreen.html'});assert.equal(bg.progress[0].stage,'error');assert.equal(bg.progress[0].exportSessionId,'a');assert.equal(bg.progress[0].error,'ZIP limit');});
