const test = require('node:test');
const assert = require('node:assert/strict');
const Feed = require('../feed.js');
const Report = require('../report.js');
const h = (index) => ({index,header:{},hasGrid:false});
const g = (index) => ({index,header:null,hasGrid:true});

test('не заимствует предыдущую сетку, не перепрыгивает заголовок или пропуск', () => {
  for (const values of [[g(9),h(10),h(11),g(12)],[h(10),g(12)],[g(9),h(10)]]) {
    const map = new Map(values.map(c=>[c.index,c]));
    assert.deepEqual(Feed.gridsForHeader(values.find(c=>c.index===10),map),[]);
  }
});
test('сохраняет все строки одной группы, останавливается перед следующей', () => {
  const values=[h(10),g(11),g(12),g(13),h(14),g(15)];
  assert.deepEqual(Feed.gridsForHeader(values[0],new Map(values.map(c=>[c.index,c]))).map(c=>c.index),[11,12,13]);
});
test('продолжает многострочную группу после исчезновения заголовка из DOM', () => {
  const owners=new Map();
  assert.deepEqual(Feed.assignGridOwners([h(10),g(11)],owners).map(x=>[x.grid.index,x.headerIndex]),[[11,10]]);
  assert.deepEqual(Feed.assignGridOwners([g(12),g(13),h(14),g(15)],owners).map(x=>[x.grid.index,x.headerIndex]),[[12,10],[13,10],[15,14]]);
});
test('не назначает владельца осиротевшей сетке через невиденный индекс', () => {
  const owners=new Map([[10,10],[11,10]]);
  assert.deepEqual(Feed.assignGridOwners([g(13)],owners),[]);
  assert.equal(owners.has(13),false);
});
test('пустой блок и новый заголовок прерывают цепочку прежней группы', () => {
  const owners=new Map([[10,10],[11,10]]);
  const values=[{index:12,header:null,hasGrid:false},g(13),h(14),g(15)];
  assert.deepEqual(Feed.assignGridOwners(values,owners).map(x=>[x.grid.index,x.headerIndex]),[[15,14]]);
});
test('индекс 0 и совмещённый заголовок/сетка являются корректными', () => {
  const first={index:0,header:{},hasGrid:true};
  assert.deepEqual(Feed.assignGridOwners([first,g(1)],new Map()).map(x=>[x.grid.index,x.headerIndex]),[[0,0],[1,0]]);
});
test('параметры и качество не становятся моделью, включая Krea и Magnific', () => {
  for(const model of ['Krea 2','Magnific One','Seedance 2.5','Wan 3.0','Minimax H3','Google Nano Banana 2']) {
    const m=Feed.deriveMetadata(['30fps','16:9','5 sec','high',model,'Thinking High'],[{alt:'video-generator'}]);
    assert.equal(m.model,model);assert.equal(m.quality,'high');
    assert.equal(m.parameters.find(p=>p.kind==='fps').value,'30fps');
  }
  assert.equal(Feed.deriveMetadata(['25fps','1:1','Thinking High','Auto'],[{alt:'video-generator'}]).model,'');
});
test('загрузкам не присваивает модель и параметры генерации', () => {
  assert.deepEqual(Feed.deriveMetadata(['Google Nano Banana 2','high','16:9'],[{alt:'upload-reference'}]),{model:'',quality:'',parameters:[]});
  assert.equal(Report.getAssetKind('video-generator'),'generation');
});
test('вложенные data-item не создают повторные или пустые карточки', () => {
  const element=(attrs={},textContent='')=>({getAttribute:key=>attrs[key]||null,textContent});
  const root={getAttribute:key=>key==='data-item'?'demo-video':'',querySelector(selector){
    if(selector==='[data-cy^="generated-"]')return {getAttribute:()=> 'generated-video-generator',querySelector:()=>element({src:'https://example.com/preview.jpg',alt:''})};
    if(selector==='[data-cy="main-feed-video-item"]')return {};
    return null;
  },querySelectorAll:()=>[]};
  const container={querySelectorAll(selector){assert.equal(selector,'[data-cy="main-feed-item"]');return [root,root];}};
  const items=Feed.parseItems(container);
  assert.equal(items.length,1);assert.equal(items[0].alt,'video-generator');assert.equal(items[0].media_type,'video');
  assert.equal(items[0].thumbnail,'https://example.com/preview.jpg');
});
test('дробное разрешение, Thinking Fast и max остаются параметрами', () => {
  assert.equal(Feed.parameterKind('1.5K'),'resolution');
  assert.equal(Feed.parameterKind('1,5K'),'resolution');
  assert.equal(Feed.deriveMetadata(['1.5K','Thinking Fast','max'],[{alt:'text-to-image'}]).model,'');
  assert.equal(Feed.deriveMetadata(['GPT 2.6','max'],[{alt:'text-to-image'}]).quality,'max');
});
test('аудиозагрузка не получает модель; пустая ссылка не становится страницей', () => {
  assert.equal(Report.getAssetKind('audio-upload'),'upload');
  assert.equal(Feed.deriveMetadata(['Krea 2'],[{alt:'audio-upload'}]).model,'');
  for(const input of ['',null,'  ','https://www.magnific.com/app/projects/all-assets'])assert.equal(Feed.previewUrl(input,'https://www.magnific.com/app/projects/all-assets'),'');
  assert.equal(Feed.previewUrl('/preview.jpg','https://www.magnific.com/app/projects/all-assets'),'https://www.magnific.com/preview.jpg');
});
test('резервный JSON не выдумывает сохранённые файлы и не меняет исходный отчёт',()=>{
 const source=[{export_status:'stopped',images:[{id:'a',url:'https://example.test/a',file:'not-created/a.jpg',status:'pending_validation'},{id:'b',url:'',file:'not-created/b.jpg'}]}];
 const result=Feed.withoutLocalFiles(source);
 assert.equal(result[0].images[0].file,'');assert.equal(result[0].images[0].status,'not_downloaded');assert.equal(result[0].images[1].status,'missing_preview');assert.equal(result[0].validated_image_count,0);assert.equal(result[0].missing_image_count,1);assert.equal(result[0].export_status,'stopped');assert.equal(source[0].images[0].file,'not-created/a.jpg');
});
