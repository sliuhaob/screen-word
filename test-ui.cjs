'use strict';
// Hidden Electron renderer tests: only test windows and generated text are captured.
// No desktop capture, user screenshots, personal profile or computer-use automation.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { app, BrowserWindow, ipcMain, globalShortcut, screen } = require('electron');
// Hidden offscreen captures do not need the user's GPU/display compositor.
app.disableHardwareAcceleration();
const resources = path.join(__dirname, process.env.SCREEN_WORD_TEST_PAYLOAD || 'dist/win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');
const { ChineseDictionary } = require(path.join(archive, 'electron/chinese-dictionary.cjs'));
const { OfflineRecognizer } = require(path.join(archive, 'electron/ocr.cjs'));
const { detectDictionaryPhrases } = require(path.join(archive, 'electron/phrase-utils.cjs'));
const { normalizeBinding, bindingLabel, writeBinding, readBinding, HotkeyManager } = require(path.join(archive, 'electron/hotkeys.cjs'));
const { MouseSideHotkey } = require(path.join(archive, 'electron/mouse-hotkey.cjs'));
const { fitWindowToContent } = require(path.join(archive, 'electron/window-layout.cjs'));
app.setPath('userData', path.join(__dirname, 'qa-profile'));
const dictionary = new ChineseDictionary({ packaged: true, resourcesPath: resources });
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let recognizer;
let checks = 0;
const progressFile = path.join(__dirname, 'ui-check-progress.log');
fs.writeFileSync(progressFile, '');
const check = (condition, label) => { assert.ok(condition, label); checks++; fs.appendFileSync(progressFile, `${checks}: ${label}\n`); };
async function within(promise, label) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), 10000); })]); }
  finally { clearTimeout(timer); }
}
async function eventually(predicate) {
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) { if (await predicate()) return; await sleep(80); }
}
function windowFor(preload, width, height) {
  const w = new BrowserWindow({ width, height, show: false, frame: false, transparent: true, webPreferences: { preload: path.join(archive, 'electron', preload), contextIsolation: true, nodeIntegration: false, sandbox: true, offscreen: true, backgroundThrottling: false } });
  w.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(message); });
  w.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
  return w;
}
async function main() {
  const mainWindow = windowFor('preload.cjs', 660, 460);
  ipcMain.on('window:fit-content',(event,height)=>{if(event.sender.id===mainWindow.webContents.id)fitWindowToContent(mainWindow,screen,height);});
  let monitoring = false, capturingKey = false, binding = {type:'mouse',button:'XBUTTON1'};
  const state = () => ({monitoring,capturingKey,binding,bindingLabel:bindingLabel(binding),message:monitoring?'已就绪，按鼠标后退侧键识别当前屏幕':'取词键尚未启用'});
  ipcMain.handle('monitor:get-state', state);
  ipcMain.handle('monitor:toggle', () => { monitoring=!monitoring;return {ok:true,...state()}; });
  ipcMain.handle('hotkey:capture-start', () => { capturingKey=true;mainWindow.webContents.send('monitor:state',state());return {ok:true}; });
  ipcMain.handle('hotkey:capture-end', () => { capturingKey=false;mainWindow.webContents.send('monitor:state',state());return {ok:true}; });
  ipcMain.handle('hotkey:save', (_e, next) => {
    try {
      next=normalizeBinding(next);if(next.accelerator==='F12')throw Error('这个快捷键已被占用');
      writeBinding(path.join(__dirname,'qa-profile/settings-test.json'), next);binding=next;return {ok:true,...state()};
    } catch(error){return {ok:false,error:error.message,...state()};}
  });
  ipcMain.handle('dictionary:search',async(_e,word)=>{if(word==='alacritously')await sleep(240);return dictionary.lookup(word,{manual:true});});
  ipcMain.handle('dictionary:suggest',(_e,prefix)=>({words:dictionary.suggest(prefix)}));
  await mainWindow.loadFile(path.join(archive, 'desktop/index.html'));
  await sleep(250);
  const mainRun = (code) => within(mainWindow.webContents.executeJavaScript(code, true), code);
  check(await mainRun("Boolean(document.getElementById('searchInput') && document.getElementById('bindingType'))"), 'new search and binding controls');
  check(await mainRun("toggleButton.textContent === '启用取词' && !toggleButton.disabled && toggleButton.getAttribute('aria-pressed')==='false' && document.getElementById('monitorTitle').textContent === '按键取词'"), 'startup paused until explicit enable');
  check(await mainRun("!document.getElementById('imageButton') && !('openImage' in window.screenCapture)"), 'image entry and renderer API removed');
  check(await mainRun("!document.querySelector('.logo,.edition,.brand p,.section-head p,.note,.muted')"),'requested decorations removed');
  check(await mainRun("resultBox.hidden && !resultBox.textContent"),'empty result panel removed');
  const compactHeight=mainWindow.getContentBounds().height;
  check(compactHeight<500,'initial window compact');
  check(await mainRun("Math.abs(innerHeight-document.querySelector('main').getBoundingClientRect().height)<=2"),'no blank area below content');
  fs.writeFileSync(path.join(__dirname,'简洁界面预览.png'),(await within(mainWindow.webContents.capturePage(), 'compact preview')).toPNG());
  await mainRun("bindingType.value='keyboard';bindingType.dispatchEvent(new Event('change'))");await sleep(180);
  check(mainWindow.getContentBounds().height>compactHeight,'keyboard controls expand window');
  await mainRun("bindingType.value='XBUTTON1';bindingType.dispatchEvent(new Event('change'))");await sleep(180);
  check(Math.abs(mainWindow.getContentBounds().height-compactHeight)<=2,'mouse binding collapses window');
  await mainRun('toggleButton.click()'); await sleep(100);
  check(await mainRun("toggleButton.textContent === '暂停取词'"), 'enabled by explicit click');
  await mainRun('toggleButton.click()'); await sleep(100);
  check(await mainRun("toggleButton.textContent === '启用取词'"), 'paused by explicit click');
  check(await mainRun('document.documentElement.scrollWidth <= innerWidth'), 'main UI fits width');
  await mainRun("searchInput.value='acroph';searchInput.dispatchEvent(new Event('input'))");await sleep(300);
  await eventually(() => mainRun("!suggestions.hidden && suggestions.innerText.includes('acrophobic') && suggestions.getBoundingClientRect().bottom<=innerHeight"));
  check(await mainRun("!suggestions.hidden && suggestions.innerText.includes('acrophobic')"),'matching suggestions');
  check(await mainRun("suggestions.getBoundingClientRect().bottom<=innerHeight"),'suggestions fit compact window');
  await mainRun("[...suggestions.children].find(li=>li.textContent==='acrophobic').click()");await sleep(120);
  check(await mainRun("resultBox.innerText.includes('恐高') && suggestions.hidden"),'suggestion click searches');
  check(!monitoring && await mainRun("toggleButton.textContent==='启用取词'"), 'search works while capture remains paused');
  await sleep(150);
  check(mainWindow.getContentBounds().height>compactHeight,'definition expands window');
  await mainRun("searchInput.value='';searchInput.dispatchEvent(new Event('input'))");await sleep(180);
  check(await mainRun('resultBox.hidden'),'clear search hides result');
  check(Math.abs(mainWindow.getContentBounds().height-compactHeight)<=2,'clear search collapses window');
  await mainRun("document.getElementById('searchForm').requestSubmit()");await sleep(100);
  check(await mainRun('resultBox.hidden'),'empty search leaves no placeholder');
  await mainRun("searchInput.value='tipped off';document.getElementById('searchForm').requestSubmit()");await sleep(120);
  check(await mainRun("resultBox.querySelector('h3').textContent==='tip off'"),'manual phrase inflection');
  for(const [form,lemma] of [['asked','ask'],['atoned','atone'],['atoning','atone'],['actioned','action']]) {
    await mainRun(`searchInput.value=${JSON.stringify(form)};document.getElementById('searchForm').requestSubmit()`);await sleep(100);
    check(await mainRun(`Boolean(resultBox.querySelector('.choices button[data-word="${form}"]') && resultBox.querySelector('.choices button[data-word="${lemma}"]'))`),`manual switches ${form}`);
    await mainRun(`resultBox.querySelector('.choices button[data-word="${form}"]').click()`);
    check(await mainRun(`resultBox.querySelector('h3').textContent===${JSON.stringify(form)}`),`select literal ${form}`);
    await mainRun(`resultBox.querySelector('.choices button[data-word="${lemma}"]').click()`);
    check(await mainRun(`resultBox.querySelector('h3').textContent===${JSON.stringify(lemma)}`),`select lemma ${lemma}`);
  }
  await mainRun("searchInput.value='found';document.getElementById('searchForm').requestSubmit()");await sleep(120);
  check(await mainRun("resultBox.querySelectorAll('.choices button').length>=2"),'manual homograph choices');
  await mainRun("searchInput.value='alacritously';document.getElementById('searchForm').requestSubmit();searchInput.value='acrophobic';document.getElementById('searchForm').requestSubmit()");await sleep(350);
  check(await mainRun("resultBox.querySelector('h3').textContent==='acrophobic' && resultBox.innerText.includes('恐高')"),'stale search cannot replace latest result');
  await mainRun("searchInput.value='tip o';searchInput.dispatchEvent(new Event('input'))");await sleep(300);
  await mainRun("searchInput.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.getElementById('searchForm').requestSubmit()");await sleep(120);
  check(await mainRun("resultBox.querySelector('h3').textContent.startsWith('tip o')"),'keyboard suggestion selection');
  await mainRun("searchInput.value='zzzzinvalidwordzzzz';document.getElementById('searchForm').requestSubmit()");await sleep(100);
  check(await mainRun("resultBox.innerText.includes('没有查到')"),'manual unknown result');
  await mainRun("bindingType.value='XBUTTON2';bindingType.dispatchEvent(new Event('change'));saveButton.click()");await sleep(100);
  check(binding.button==='XBUTTON2','mouse binding saved');
  await mainRun("bindingType.value='keyboard';bindingType.dispatchEvent(new Event('change'));recordKey.click()");await sleep(100);
  check(await mainRun('recording && saveButton.disabled'),'keyboard recording state');
  await mainRun("window.dispatchEvent(new KeyboardEvent('keydown',{key:'d',code:'KeyD',ctrlKey:true,altKey:true,bubbles:true,cancelable:true}))");await sleep(120);
  check(await mainRun("keyDisplay.value==='Ctrl+Alt+D' && !recording"),'capture keyboard combination');
  await mainRun('saveButton.click()');await sleep(120);
  check(binding.accelerator==='Control+Alt+D','keyboard binding saved');
  check(readBinding(path.join(__dirname,'qa-profile/settings-test.json')).accelerator==='Control+Alt+D','persistent setting');
  await mainRun("recordKey.click()");await sleep(80);
  await mainRun("window.dispatchEvent(new KeyboardEvent('keydown',{key:'F12',code:'F12',bubbles:true,cancelable:true}))");await sleep(100);
  await mainRun('saveButton.click()');await sleep(100);
  check(await mainRun("bindingMessage.innerText.includes('占用')"),'conflict explained');
  check(binding.accelerator==='Control+Alt+D','conflict preserves prior binding');
  await mainRun("searchInput.value='acrophobic';document.getElementById('searchForm').requestSubmit();accelerator='Control+Alt+D';keyDisplay.value='Ctrl+Alt+D';saveButton.click()");await sleep(100);
  fs.writeFileSync(path.join(__dirname, '界面预览.png'), (await within(mainWindow.webContents.capturePage(), 'main preview')).toPNG());

  const overlay = windowFor('overlay-preload.cjs', 1280, 800);
  const run = (code) => within(overlay.webContents.executeJavaScript(code, true), code);
  let cancels = 0;
  const edits = [];
  const wordsAcks = [];
  ipcMain.on('overlay:words-ready', (_e, id, revision, ok) => wordsAcks.push({ id, revision, ok }));
  ipcMain.on('overlay:lookup', (_e, word) => overlay.webContents.send('overlay:definition', dictionary.lookup(word)));
  ipcMain.on('overlay:set-editing', (_e, editing) => edits.push(editing));
  ipcMain.on('overlay:cancel', () => { cancels++; });
  await overlay.loadFile(path.join(archive, 'desktop/overlay.html'));
  const words = { requestId: 1, revision: 1, complete: false, captureWidth: 1280, captureHeight: 800, words: [
    { text: 'tip off', surfaceText: 'tipped off', isPhrase: true, x: 300, y: 210, width: 180, height: 45 },
    { text: 'acrophobic', x: 500, y: 210, width: 230, height: 45 },
    { text: 'alacritously', x: 1040, y: 720, width: 200, height: 45 },
  ] };
  words.bindingLabel='Ctrl+Alt+D';
  check(await run("surface.hidden && !document.querySelector('img,canvas,video')"), 'no screenshot element; words hidden before recognition');
  check(await run("[document.documentElement, document.body, surface].every(e=>getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(e).backgroundImage==='none')"), 'all background layers fully transparent');
  overlay.webContents.send('overlay:words', { ...words, revision: 0 }); await sleep(50);
  check(await run('!layer.children.length'), 'invalid revision is rejected');
  overlay.webContents.send('overlay:words', words); await sleep(100);
  await eventually(() => wordsAcks.some(a => a.id === 1 && a.ok));
  check(wordsAcks.some(a => a.id === 1 && a.ok), 'first batch acknowledges readiness');
  check(await run("!payload.complete && document.getElementById('frameStatus').textContent.includes('继续识别')"), 'first batch is usable while OCR continues');
  const transparentPreview = await overlay.webContents.capturePage();
  const previewSize = transparentPreview.getSize(), previewPixels = transparentPreview.toBitmap();
  check(previewPixels[(Math.floor(previewSize.height / 2) * previewSize.width + Math.floor(previewSize.width / 2)) * 4 + 3] === 0, 'rendered empty area has zero alpha');
  await run("document.querySelector('.phrase-box').click()"); await sleep(160);
  check(await run("lookupWord.value === 'tip off' && !card.hidden"), 'phrase opens inline');
  check(await run("body.innerText.includes('通知') || body.innerText.includes('泄露')"), 'real phrase definitions');
  check(await run("formNote.innerText.includes('tipped off')"), 'inflection note');
  check(await run("document.getElementById('cancelButton').innerText.includes('Ctrl+Alt+D')"),'overlay shows current binding');
  check(await run("Boolean(body.querySelector('.entry-choices button[data-headword=\"tipped off\"]'))"),'inflected phrase keeps original surface option');
  check(await run("!document.querySelector('select, textarea, input[type=checkbox]') && !document.body.innerText.includes('记忆')"), 'no memory UI');
  check(await run("Object.keys(window.wordOverlay).sort().join(',') === 'cancel,lookup,onClear,onDefinition,onWords,setEditing,wordsReady'"), 'limited API without screenshot channel');
  await run("document.querySelector('[data-word=acrophobic]').click()"); await sleep(150);
  check(await run("body.innerText.includes('恐高')"), 'new dictionary meaning');
  await run("lookupWord.focus(); lookupWord.value='found'; lookupWord.dispatchEvent(new Event('input'))"); await sleep(400);
  check(await run("document.querySelectorAll('.entry-choices button').length >= 2"), 'homograph choice');
  await run("document.querySelector('.entry-choices button[data-headword=find]').click()"); await sleep(60);
  check(await run("lookupWord.value === 'find'"), 'select lemma');
  await run("lookupWord.value='zzzzinvalidwordzzzz'; lookupWord.dispatchEvent(new Event('input'))"); await sleep(400);
  check(await run("body.innerText.includes('暂未收录')"), 'unknown word feedback');
  await run("lookupWord.value='hello!'; lookupWord.dispatchEvent(new Event('input'))"); await sleep(300);
  check(await run("body.innerText.includes('不含数字或句末标点')"), 'invalid input does not hang');
  await run("lookupWord.value='ＡＣＲＯＰＨＯＢＩＣ'; lookupWord.dispatchEvent(new Event('input'))"); await sleep(400);
  check(await run("body.innerText.includes('恐高')"), 'fullwidth input normalization');
  await run("lookupWord.dispatchEvent(new CompositionEvent('compositionstart')); window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',isComposing:true,keyCode:229}))");
  await sleep(50); check(cancels === 0, 'IME escape protected');
  await run("lookupWord.dispatchEvent(new CompositionEvent('compositionend'))");
  await run("document.querySelector('[data-word=alacritously]').click()"); await sleep(180);
  check(await run("body.innerText.includes('欣然')"), 'second correction');
  check(await run("(() => { const r=card.getBoundingClientRect(); return r.left>=0 && r.top>=0 && r.right<=innerWidth && r.bottom<=innerHeight; })()"), 'edge positioning');
  await run("lookupWord.focus(); lookupWord.setSelectionRange(2,2); window.dispatchEvent(new Event('resize'))");
  check(await run('document.activeElement === lookupWord && lookupWord.selectionStart === 2'), 'resize preserves caret');
  const editsBeforeUpdate = edits.length;
  await run("window.activeAnchor = selected; window.savedMeaning = body.innerText; lookupWord.dispatchEvent(new CompositionEvent('compositionstart')); lookupWord.value='正在输入'; lookupWord.setSelectionRange(2,2)");
  overlay.webContents.send('overlay:words', { ...words, update: true, complete: true, words: [
    ...words.words, { text: 'new', x: 800, y: 210, width: 80, height: 40 },
  ] }); await sleep(100);
  check(await run('selected === window.activeAnchor && selected.isConnected && !card.hidden'), 'duplicate final result cannot replace active anchor/card');
  check(await run("composing && lookupWord.value==='正在输入' && lookupWord.selectionStart===2 && document.activeElement===lookupWord"), 'duplicate result preserves IME/caret/focus');
  check(await run('body.innerText===window.savedMeaning'), 'duplicate result preserves definition');
  check(edits.length===editsBeforeUpdate,'duplicate result does not change editing state');
  check(await run("!document.querySelector('[data-word=new]') && document.querySelectorAll('[data-word=alacritously]').length===1"),'late boxes cannot replace fixed final result');
  overlay.webContents.send('overlay:words', { ...words, requestId: 0, update: true, words: [] }); await sleep(80);
  check(await run("!document.querySelector('[data-word=new]') && !card.hidden"),'stale request ignored');
  await run("window.stablePhrase = document.querySelector('.phrase-box')");
  const revisedWords = [...words.words.slice(0, 2), { ...words.words[2], text: 'alacrity', x: 1042 }, { text: 'new', x: 800, y: 210, width: 80, height: 40 }];
  overlay.webContents.send('overlay:words', { ...words, revision: 2, words: revisedWords }); await sleep(100);
  check(await run("document.querySelector('[data-word=new]') && !document.querySelector('[data-word=alacrity]') && selected === window.activeAnchor && selected.isConnected"), 'later batch adds unrelated words and defers active anchor correction');
  check(await run("composing && lookupWord.value==='正在输入' && lookupWord.selectionStart===2 && document.activeElement===lookupWord && body.innerText===window.savedMeaning"), 'real incremental update preserves IME, caret, focus and definition');
  check(edits.length===editsBeforeUpdate, 'incremental update does not toggle editing');
  check(await run("document.querySelector('.phrase-box')===window.stablePhrase"), 'unchanged buttons retain their DOM identity');
  const finalWords = [...revisedWords, { text: 'generations', x: 100, y: 400, width: 180, height: 40 }];
  overlay.webContents.send('overlay:words', { ...words, revision: 3, complete: true, words: finalWords }); await sleep(100);
  check(await run("payload.complete && document.querySelector('[data-word=generations]') && selected===window.activeAnchor && composing && body.innerText===window.savedMeaning"), 'final recovery arrives without interrupting open definition');
  check(wordsAcks.some(a=>a.id===1 && a.revision===3 && a.ok), 'final revision paint acknowledged');
  overlay.webContents.send('overlay:words', { ...words, revision: 4, complete: true, words: [] }); await sleep(50);
  check(await run("payload.revision===3 && document.querySelector('[data-word=generations]')"), 'completed request cannot be overwritten by late updates');
  await run("lookupWord.value='alacritously'; lookupWord.dispatchEvent(new CompositionEvent('compositionend'))"); await sleep(350);
  await sleep(180);
  fs.writeFileSync(path.join(__dirname, '释义卡预览.png'), (await within(overlay.webContents.capturePage(), 'definition preview')).toPNG());
  await run("document.getElementById('closeCardButton').click()"); await sleep(50);
  check(await run('card.hidden'), 'close card');
  check(await run("!document.querySelector('[data-word=alacritously]') && document.querySelector('[data-word=alacrity]')"), 'closing definition applies deferred correction');
  check(edits.includes(true) && edits.at(-1) === false, 'editing state released');
  await run("window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}))"); await sleep(50);
  check(cancels === 1, 'escape exits');
  overlay.webContents.send('overlay:words',{requestId:2,revision:1,complete:true,captureWidth:1280,captureHeight:800,words:[{text:'atoned',x:320,y:200,width:140,height:40},{text:'atoning',x:490,y:200,width:145,height:40}]});await sleep(100);
  check(await run("card.hidden && !document.querySelector('[data-word=new]')"),'new capture resets prior results');
  for(const form of ['atoned','atoning']) {
    await run(`document.querySelector('[data-word="${form}"]').click()`);await sleep(120);
    check(await run(`Boolean(body.querySelector('.entry-choices button[data-headword="${form}"]') && body.querySelector('.entry-choices button[data-headword="atone"]'))`),`overlay switches ${form}`);
    await run(`body.querySelector('.entry-choices button[data-headword="${form}"]').click()`);
    check(await run(`lookupWord.value===${JSON.stringify(form)}`),`overlay original ${form}`);
    await run("body.querySelector('.entry-choices button[data-headword=atone]').click()");
    check(await run("lookupWord.value==='atone' && body.innerText.includes('补偿')"),`overlay base ${form}`);
  }
  fs.writeFileSync(path.join(__dirname,'分词切换预览.png'),(await within(overlay.webContents.capturePage(), 'inflection preview')).toPNG());
  overlay.setSize(1000, 1000); await sleep(150);
  check(await run("(() => { const word=document.querySelector('[data-word=atoned]').getBoundingClientRect(); return Math.abs(word.left-(320*1000/1280-4))<1 && Math.abs(word.top-(200*1000/800-4))<1; })()"), 'transparent words follow monitor coordinates on resize');
  overlay.webContents.send('overlay:clear'); await sleep(80);
  check(await run("surface.hidden && !payload && !layer.children.length && card.hidden"), 'exit hides words and definition');
  overlay.webContents.send('overlay:words', words); await sleep(50);
  check(await run('!layer.children.length'), 'late results after exit remain invisible');
  await run(`renderWords(${JSON.stringify({ ...words, requestId: 3 })}); clearWords();`);
  await sleep(100);
  check(!wordsAcks.some(a => a.id === 3) && await run('surface.hidden && !layer.children.length'), 'clear cancels pending paint acknowledgement');
  overlay.webContents.send('overlay:words', { ...words, requestId: 3, revision: 2, complete: true }); await sleep(50);
  check(await run('surface.hidden && !layer.children.length'), 'late higher revision cannot reopen a cancelled request');
  overlay.webContents.send('overlay:words', { ...words, requestId: 4 }); await sleep(100);
  check(wordsAcks.some(a => a.id === 4 && a.ok) && await run('!surface.hidden && layer.children.length===3'), 'fresh result recovers after cancellation');

  // Verify the packaged Tesseract worker and language data without reading the desktop.
  const caption = new BrowserWindow({ width: 1200, height: 220, show: false, webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true, sandbox: true } });
  await caption.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<html><body style="margin:0;background:white;color:black;font:48px Arial;padding:60px 35px">Akasaka was tipped off that.</body></html>'));
  await sleep(200);
  recognizer = new OfflineRecognizer({ packaged: true, resourcesPath: resources });
  const ocr = await recognizer.recognize((await caption.webContents.capturePage()).toPNG());
  const detected = detectDictionaryPhrases(ocr.words, (term) => dictionary.lookup(term), 5, { preserveWords: true });
  check(detected.some((w) => w.text === 'tip off' && w.isPhrase), 'packaged OCR through lemma/phrase lookup');
  check(errors.length === 0, 'no renderer errors: ' + errors.join('\n'));
  for (const button of ['XBUTTON1','XBUTTON2','MIDDLE']) {
    const hook = new MouseSideHotkey({packaged:true,resourcesPath:resources,onTrigger:()=>{}});
    try { await hook.start(button);check(Boolean(hook.child),`native registration ${button}`); } finally {hook.stop();}
  }
  const realKeys = new HotkeyManager({keyboard:globalShortcut,mouse:{stop(){}},binding:{type:'keyboard',accelerator:'Control+Alt+Shift+F10'},persist:()=>{},onTrigger:()=>{}});
  try {
    await realKeys.start();check(globalShortcut.isRegistered('Control+Alt+Shift+F10'),'native keyboard registration');
    realKeys.suspend();check(!globalShortcut.isRegistered('Control+Alt+Shift+F10'),'recording releases native key');
    await realKeys.resume();check(globalShortcut.isRegistered('Control+Alt+Shift+F10'),'native key restored');
  } finally { realKeys.stop(); }
  await recognizer.terminate(); recognizer = null;
  dictionary.close();
  fs.writeFileSync(path.join(__dirname, 'ui-test-result.json'), JSON.stringify({ passed: true, checks, resources, ocrWords: ocr.words.map((w) => w.text), phrase: 'tip off', personalProfileUsed: false, desktopCaptured: false, errors, at: new Date().toISOString() }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, ocrWords: ocr.words.map((w) => w.text) }));
  app.exit(0);
}
app.whenReady().then(main).catch(async (e) => {
  console.error(e);
  if (recognizer) await recognizer.terminate();
  app.exit(1);
});
