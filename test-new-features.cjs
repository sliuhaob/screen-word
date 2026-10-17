'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { normalizeBinding, bindingLabel, readBinding, writeBinding, HotkeyManager } = require('./src/electron/hotkeys.cjs');
const { ChineseDictionary } = require('./src/electron/chinese-dictionary.cjs');
const db = new ChineseDictionary({ dictionaryPath: path.resolve(__dirname, 'resources/ecdict.sqlite') });
after(() => db.close());
test('binding normalization and reserved / unsafe keys', () => {
  for (const button of ['XBUTTON1', 'XBUTTON2', 'MIDDLE']) assert.equal(normalizeBinding({ type:'mouse', button }).button, button);
  for (const accelerator of ['F8', 'Control+Alt+D', 'Shift+F7', 'Alt+Space']) assert.equal(normalizeBinding({ type:'keyboard', accelerator }).accelerator, accelerator);
  for (const accelerator of ['D', 'Shift+A', 'Escape', 'Alt+F4', 'F99', 'Control+Control+A']) assert.throws(() => normalizeBinding({ type:'keyboard', accelerator }));
  assert.throws(() => normalizeBinding({type:'mouse',button:'toString'}));
  assert.equal(bindingLabel({type:'keyboard',accelerator:'Control+Alt+D'}),'Ctrl+Alt+D');
});
test('settings persist atomically and invalid settings fall back to the original side button', () => {
  const dir = fs.mkdtempSync(path.join(__dirname,'settings-test-')), file = path.join(dir,'settings.json');
  assert.equal(readBinding(file).button, 'XBUTTON1');
  writeBinding(file, { type:'keyboard', accelerator:'Alt+F8' });
  assert.deepEqual(readBinding(file), { type:'keyboard', accelerator:'Alt+F8' });
  writeBinding(file, { type:'mouse', button:'MIDDLE' });
  assert.equal(readBinding(file).button,'MIDDLE');
  assert.ok(!fs.existsSync(file+'.tmp'));
  fs.writeFileSync(file,'invalid'); assert.equal(readBinding(file).button,'XBUTTON1');
});
function manager(persist = () => {}) {
  const registered = new Map(), mouse = { active:null, async start(button) { this.active = button; }, stop() { this.active = null; } };
  let fires = 0;
  const hotkeys = new HotkeyManager({ keyboard: { register: (key, fn) => { if (key === 'F12') return false; registered.set(key,fn); return true; }, unregister: (key) => registered.delete(key) }, mouse, binding:{type:'mouse',button:'XBUTTON1'}, persist, onTrigger:()=>fires++ });
  return { hotkeys, registered, mouse, fires:()=>fires };
}
test('changes take effect live and old registrations are removed', async () => {
  const {hotkeys,registered,mouse,fires}=manager();
  await hotkeys.start(); assert.equal(mouse.active,'XBUTTON1');
  await hotkeys.setBinding({type:'keyboard',accelerator:'Control+Alt+D'});
  assert.equal(mouse.active,null); registered.get('Control+Alt+D')(); assert.equal(fires(),1);
  await hotkeys.setBinding({type:'mouse',button:'XBUTTON2'});
  assert.equal(registered.size,0); assert.equal(mouse.active,'XBUTTON2');
  hotkeys.stop(); assert.equal(mouse.active,null);
});
test('shortcut conflicts roll back to the prior active binding', async () => {
  const {hotkeys,mouse}=manager(); await hotkeys.start();
  await assert.rejects(hotkeys.setBinding({type:'keyboard',accelerator:'F12'}),/占用/);
  assert.equal(hotkeys.binding.button,'XBUTTON1'); assert.equal(mouse.active,'XBUTTON1');
});
test('disk failures roll back, and idle validation leaves no global registration', async () => {
  const {hotkeys,mouse,registered}=manager(()=>{throw Error('disk');}); await hotkeys.start();
  await assert.rejects(hotkeys.setBinding({type:'keyboard',accelerator:'F8'}),/disk/);
  assert.equal(mouse.active,'XBUTTON1'); assert.equal(registered.size,0);
  const idle=manager(); await idle.hotkeys.setBinding({type:'keyboard',accelerator:'F8'});
  assert.equal(idle.registered.size,0); assert.equal(idle.hotkeys.binding.accelerator,'F8');
});
test('recording suspends old keys and resumes them on finish', async () => {
  const {hotkeys,registered}=manager(); await hotkeys.setBinding({type:'keyboard',accelerator:'F8'}); await hotkeys.start();
  hotkeys.suspend(); assert.equal(registered.size,0); assert.equal(hotkeys.live,true);
  await hotkeys.resume(); assert.ok(registered.has('F8'));
  hotkeys.stop(); assert.equal(registered.size,0);
});
test('prefix suggestions are bounded, case insensitive and use the index', () => {
  const words=db.suggest('ACROPH'); assert.ok(words.includes('acrophobic')); assert.ok(words.length<=12);
  assert.ok(db.suggest('tip o').includes('tip off'));
  assert.equal(db.suggest('').length,0); assert.equal(db.suggest('中文').length,0);
  const plan=db.database.prepare('EXPLAIN QUERY PLAN SELECT word FROM entries WHERE word >= ? COLLATE NOCASE AND word < ? COLLATE NOCASE ORDER BY word COLLATE NOCASE LIMIT 12').all('a','a\uffff');
  assert.ok(plan.some(p=>/SEARCH.*(?:INDEX|PRIMARY KEY)/.test(p.detail)), JSON.stringify(plan));
});
test('manual searches share all meanings, aliases and corrected content with screen lookup', () => {
  for(const word of ['acrophobic','alacritously','found','tipped off']) assert.deepEqual(db.lookup(word,{manual:true}),db.lookup(word));
  assert.match(db.lookup('tipped off',{manual:true}).translations.join(' '),/通知|泄露/);
  assert.equal(db.lookup("' OR 1=1 --",{manual:true}).found,false);
});
