'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { ChineseDictionary } = require('./src/electron/chinese-dictionary.cjs');
const { detectDictionaryPhrases } = require('./src/electron/phrase-utils.cjs');
const { MouseSideHotkey } = require('./src/electron/mouse-hotkey.cjs');
const dictionary = new ChineseDictionary({ dictionaryPath: path.resolve(__dirname, 'resources/ecdict.sqlite') });
after(() => dictionary.close());
test('bundled dictionary meanings and unknown-word behavior', () => {
  assert.match(dictionary.lookup('acrophobic').translations.join(' '), /恐高/);
  assert.match(dictionary.lookup('alacritously').translations.join(' '), /欣然/);
  assert.match(dictionary.lookup('basketweaver').translations.join(' '), /编篮|编筐/);
  assert.equal(dictionary.lookup('zzzzinvalidwordzzzz').found, false);
});
test('regular and irregular verbs and phrases retain their lemmas', () => {
  for (const [word, lemma] of [['tipped', 'tip'], ['tipping', 'tip'], ['went', 'go'], ['written', 'write'], ['tipped off', 'tip off'], ['took off', 'take off'], ['gave up', 'give up']]) {
    assert.equal(dictionary.lookup(word).headword, lemma, word);
  }
  assert.equal(dictionary.lookup('saw off').headword, 'saw off');
  assert.equal(dictionary.lookup('fed up').headword, 'fed up');
  assert.ok(dictionary.lookup('found').entries.some((e) => e.headword === 'found'));
  assert.ok(dictionary.lookup('found').entries.some((e) => e.headword === 'find'));
});
test('phrase detection keeps individual words and recognizes tipped off', () => {
  const words = 'akasaka was tipped off that'.split(' ').map((text, i) => ({ text, x: 20 + 95 * i, y: 100, width: 90, height: 35, tokenIndex: i, lineId: '0', confidence: 95 }));
  const result = detectDictionaryPhrases(words, (s) => dictionary.lookup(s), 5, { preserveWords: true });
  assert.ok(result.some((e) => e.text === 'tip off' && e.surfaceText === 'tipped off'));
  assert.equal(result.filter((e) => !e.isPhrase).length, words.length);
});
test('mouse side-button stream handles fragmented lines', () => {
  let triggers = 0, ready = false;
  const hook = new MouseSideHotkey({ packaged: false, appPath: __dirname, onTrigger: () => triggers++, onStatus: (s) => { ready = s.ready; } });
  hook.consume('REA'); hook.consume('DY\r\nTRIG'); hook.consume('GER\n');
  assert.equal(ready, true); assert.equal(triggers, 1);
});
test('standalone source has no memory controls, storage, or IPC', () => {
  for (const dir of ['src/desktop', 'src/electron']) {
    for (const name of fs.readdirSync(path.join(__dirname, dir))) {
      const code = fs.readFileSync(path.join(__dirname, dir, name), 'utf8');
      assert.doesNotMatch(code, /memory:|add-to-memory|localStorage|syncMemory|memoryForm|addToMemory|加入到记忆/);
    }
  }
  assert.match(fs.readFileSync(path.join(__dirname, 'src/electron/main.cjs'), 'utf8'), /com\.screenword\.standalone/);
});
function controller() {
  const sourcePath = path.join(__dirname, 'src/electron/main.cjs');
  const originalRequire = createRequire(sourcePath);
  const handlers = new Map();
  const fakeApp = { setName() {}, setPath() {}, getPath: () => __dirname, getAppPath: () => __dirname };
  let resolveCapture, rejectCapture;
  const counts = { captures: 0, nativeCaptures: 0, shown: 0, minimized: 0, intervals: 0, prewarms: 0, ocrImports: 0, mainCreated: 0, targets: [], payloads: [], frames: [], cleared: 0 };
  const ctx = vm.createContext({
    require: (name) => {
      if (name === 'electron') return { app: fakeApp, screen: { getAllDisplays: () => [{ id: '1', bounds: { x: 0, y: 0, width: 100, height: 100 } }, { id: '2', bounds: { x: 100, y: 0, width: 100, height: 100 } }] }, ipcMain: { handle: (c, f) => handlers.set(c, f), on: (c, f) => handlers.set(c, f) }, desktopCapturer: { getSources: async () => {
        counts.nativeCaptures++; counts.capturedVisible = ctx.nativeVisible; counts.hiddenGap = Date.now()-ctx.lastHiddenAt;
        throw Error('native capture trap');
      } } };
      if (name === './ocr.cjs') { counts.ocrImports++; return { OfflineRecognizer: class {} }; }
      return originalRequire(name);
    },
    process: { stdout: { on() {} }, stderr: { on() {} }, on() {}, env: {} },
    console, setTimeout, clearTimeout, ScreenOcrPipeline: originalRequire('./screen-ocr.cjs').ScreenOcrPipeline,
    setInterval: () => { counts.intervals++; return 1; }, clearInterval() {},
    __dirname: path.dirname(sourcePath),
  });
  const source = fs.readFileSync(sourcePath, 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('const gotLock =')), ctx);
  ctx.counts = counts;
  ctx.realCaptureDisplay = ctx.captureDisplay;
  ctx.nativeVisible = false;
  ctx.lastHiddenAt = -Infinity;
  ctx.focused = false;
  ctx.autoAck = true;
  ctx.cursorDisplay = { id: '1', scaleFactor: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } };
  ctx.testWords = [{ text: 'hello', x: 10, y: 10, width: 40, height: 20, confidence: 95, tokenIndex: 0, lineId: '0' }];
  ctx.testCapture = display => { counts.captures++; counts.targets.push(display.id); return new Promise((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; }); };
  vm.runInContext(`
    captureDisplay = testCapture;
    displayAtCursor = () => cursorDisplay;
    recognizer = { getWorker: async () => { counts.prewarms++; }, recognize: async () => ({ words: testWords }) };
    ocrPipeline = new ScreenOcrPipeline(recognizer, { getWorker: async () => { counts.prewarms++; }, recognize: async () => ({ words: testWords }) });
    chineseDictionary = { lookup: () => ({ found: false }) };
    mouseHotkey = { stop() {} };
    hotkeys = { live: true, suspended: false, binding: { type: 'mouse', button: 'XBUTTON1' }, async start() { this.live = true; }, stop() { this.live = false; }, suspend() { this.suspended = true; }, async resume() { this.suspended = false; } };
    mainWindow = { isDestroyed: () => false, isFocused: () => focused, minimize() { counts.minimized++; focused = false; }, webContents: { id: 1, send() {} } };
    overlayWindow = { isDestroyed: () => false, isVisible: () => nativeVisible, setAlwaysOnTop() {}, hide() { nativeVisible=false; lastHiddenAt=Date.now(); }, setBounds() {}, show() { counts.shown++; nativeVisible=true; }, moveTop() {}, focus() {}, webContents: { id: 2, focus() {}, send(channel, data) {
      if (channel === 'overlay:frame') counts.frames.push(data);
      if (channel === 'overlay:words') { counts.payloads.push({ channel, data }); if (autoAck) wordsAck.finish(true); }
      if (channel === 'overlay:clear') counts.cleared++;
    } } };
    runtime.monitoring = true;
    registerIpc();
  `, ctx);
  return { ctx, handlers, counts, finishCapture: () => resolveCapture({ buffer: Buffer.from(`image-${counts.captures}`), makeSupplement: () => ({ buffer: Buffer.from('enhanced'), mode: 'bright-text' }), width: 100, height: 100, displayId: counts.targets.at(-1), bounds: {} }), failCapture: () => rejectCapture(new Error('test capture failed')) };
}
test('stop during in-flight recognition cannot repopulate results or reopen overlay', async () => {
  const { ctx, finishCapture } = controller();
  const scan = ctx.scanScreen();
  ctx.stopMonitoring();
  finishCapture();
  assert.equal((await scan).stopped, true);
  const state = ctx.publicState();
  assert.equal(state.monitoring, false);
  assert.equal(state.scanning, false);
  assert.equal(state.recognizedCount, 0);
  assert.equal(state.message, '取词键已暂停');
});

test('native capture hides a visible overlay and allows desktop composition to settle', async () => {
  const {ctx,counts}=controller(); ctx.nativeVisible=true;
  await assert.rejects(ctx.realCaptureDisplay(ctx.cursorDisplay),/native capture trap/);
  assert.equal(counts.nativeCaptures,1); assert.equal(counts.capturedVisible,false);
  assert.ok(counts.hiddenGap>=70); assert.ok(counts.cleared>0);
});

test('rapid recapture after closing a word card waits for the recent hide', async () => {
  const {ctx,counts,finishCapture}=controller();
  const first=ctx.beginPicking(); finishCapture(); await first;
  assert.equal((await ctx.beginPicking()).cancelled,true);
  await assert.rejects(ctx.realCaptureDisplay(ctx.cursorDisplay),/native capture trap/);
  assert.equal(counts.capturedVisible,false); assert.ok(counts.hiddenGap>=70);
});

test('pausing while a window hide settles prevents the pending native capture', async () => {
  const {ctx,counts}=controller(); ctx.nativeVisible=true;
  vm.runInContext('captureDisplay=realCaptureDisplay;',ctx);
  const pending=ctx.scanScreen(); ctx.stopMonitoring();
  assert.equal((await pending).stopped,true); assert.equal(counts.nativeCaptures,0);
  assert.equal(ctx.publicState().monitoring,false);
});
test('enabling only arms the key: no startup capture or periodic timer; sender authorization', async () => {
  const { ctx, handlers, counts } = controller();
  ctx.stopMonitoring();
  assert.equal((await ctx.startMonitoring({ minimize: false })).ok, true);
  assert.equal(counts.captures, 0); assert.equal(counts.intervals, 0); assert.equal(counts.minimized, 0);
  const source = fs.readFileSync(path.join(__dirname, 'src/electron/main.cjs'), 'utf8');
  assert.doesNotMatch(source, /setInterval|SCAN_INTERVAL|armScanTimer/);
  assert.equal(counts.prewarms, 2);
  assert.match(source, /app\.whenReady\(\)\.then\(startApplication\)/);
  assert.equal(handlers.has('overlay:add-to-memory'), false);
  assert.equal(handlers.get('monitor:get-state')({ sender: { id: 999 } }), null);
  assert.equal(handlers.get('monitor:get-state')({ sender: { id: 1 } }).monitoring, true);
  assert.equal((await handlers.get('monitor:toggle')({ sender: { id: 999 } })).ok, false);
});

test('one key captures and opens the result; rapid keys share the same job', async () => {
  const { ctx, counts, finishCapture } = controller();
  const pending = ctx.beginPicking();
  assert.equal(ctx.beginPicking(), pending); assert.equal(ctx.beginPicking(), pending);
  assert.equal(counts.captures, 1); assert.equal(counts.shown, 0);
  finishCapture(); assert.equal((await pending).ok, true);
  assert.equal(counts.shown, 1); assert.equal(ctx.publicState().picking, true);
  assert.equal(counts.payloads.at(-1).data.words[0].text, 'hello');
});

test('registered hotkey callback reaches capture, and pausing disables it', async () => {
  const { ctx, counts, finishCapture } = controller();
  ctx.triggerPicking(); assert.equal(counts.captures, 1);
  const pending = ctx.beginPicking(); finishCapture(); await pending;
  ctx.stopMonitoring(); ctx.triggerPicking(); assert.equal(counts.captures, 1);
});

test('first reliable lane opens transparent words; final update never reopens the window', async () => {
  const { ctx, counts, finishCapture } = controller();
  let finish;
  ctx.slowLane = new Promise(resolve => { finish = resolve; });
  vm.runInContext('ocrPipeline.supplementRecognizer.recognize = () => slowLane;', ctx);
  const pending = ctx.beginPicking(); finishCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(counts.shown, 1); assert.equal(ctx.publicState().scanning, true);
  assert.equal(counts.frames.length, 0); assert.equal(counts.payloads.length, 1);
  assert.equal(counts.payloads[0].data.complete, false);
  assert.equal(counts.payloads[0].data.revision, 1);
  ctx.setOverlayEditing(true);
  finish({ words: [{ ...ctx.testWords[0], text: 'later', x: 60 }] });
  assert.equal((await pending).ok, true);
  assert.equal(counts.shown, 1);
  assert.equal(vm.runInContext('overlayEditing', ctx), true);
  assert.equal(counts.payloads.length, 2);
  assert.equal(counts.payloads.at(-1).data.complete, true);
  assert.deepEqual(Object.keys(counts.payloads[0].data).sort(), ['bindingLabel', 'captureHeight', 'captureWidth', 'complete', 'requestId', 'revision', 'stage', 'words']);
  assert.equal(counts.frames.length, 0);
  assert.equal(ctx.publicState().scanning, false);
});

test('closing early suppresses late update; next press waits for workers then recaptures', async () => {
  const { ctx, counts, finishCapture } = controller();
  let finish;
  ctx.slowLane = new Promise(resolve => { finish = resolve; });
  vm.runInContext('ocrPipeline.supplementRecognizer.recognize = () => slowLane;', ctx);
  const pending = ctx.beginPicking(); finishCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(counts.shown, 1);
  assert.equal((await ctx.beginPicking()).cancelled, true);
  const next = ctx.beginPicking(); assert.equal(ctx.beginPicking(), next);
  assert.equal(counts.captures, 1);
  finish({ words: ctx.testWords }); assert.equal((await pending).stopped, true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(counts.payloads.length, 1); assert.equal(counts.captures, 2);
  finishCapture(); assert.equal((await next).ok, true);
  assert.equal(counts.shown, 2);
  assert.equal(counts.payloads.at(-1).data.requestId, 2);
});

test('cold startup is paused with no OCR import, models, hook, overlay or screenshot', () => {
  const { ctx, counts } = controller();
  vm.runInContext('ocrPipeline = null; recognizer = null; overlayWindow = null; runtime.monitoring = false; runtime.message = "取词键尚未启用";', ctx);
  ctx.createMainWindow = () => { counts.mainCreated++; };
  ctx.createOverlayWindow = () => { throw Error('Startup must not create an overlay'); };
  ctx.startApplication();
  const state = ctx.publicState();
  assert.equal(counts.mainCreated, 1);
  assert.equal(counts.ocrImports, 0); assert.equal(counts.prewarms, 0);
  assert.equal(counts.captures, 0); assert.equal(counts.intervals, 0);
  assert.equal(state.monitoring, false); assert.equal(state.scanning, false);
  assert.equal(vm.runInContext('ocrPipeline === null && recognizer === null && overlayWindow === null && !hotkeys.live && !mouseHotkey.child && !chineseDictionary.database', ctx), true);
  ctx.triggerPicking(); assert.equal(counts.captures, 0);
});

test('background preload does not block enable; failure after pause cannot change paused state', async () => {
  const { ctx, counts } = controller();
  let fail;
  ctx.pendingPrewarm = new Promise((_resolve, reject) => { fail = reject; });
  vm.runInContext('ocrPipeline.prewarm = () => pendingPrewarm;', ctx);
  ctx.stopMonitoring();
  assert.equal((await ctx.startMonitoring({ minimize: false })).ok, true);
  assert.equal(counts.captures, 0); ctx.stopMonitoring();
  fail(Error('model loading failed')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.publicState().monitoring, false);
  assert.equal(ctx.publicState().message, '取词键已暂停');
});

test('enable failure cannot leave capture active or start preloading', async () => {
  const { ctx, counts } = controller();
  ctx.stopMonitoring(); vm.runInContext('hotkeys.start = async () => { throw Error("key conflict"); };', ctx);
  assert.equal((await ctx.startMonitoring({ minimize: false })).ok, false);
  assert.equal(ctx.publicState().monitoring, false); assert.equal(counts.prewarms, 0);
});

test('key closes the visible layer; the next key always captures a fresh image', async () => {
  const { ctx, counts, finishCapture } = controller();
  const first = ctx.beginPicking(); finishCapture(); await first;
  assert.equal((await ctx.beginPicking()).cancelled, true); assert.equal(counts.captures, 1);
  ctx.testWords[0].text = 'changed';
  const next = ctx.beginPicking(); assert.equal(counts.captures, 2); finishCapture(); await next;
  assert.equal(counts.shown, 2); assert.equal(counts.payloads.at(-1).data.words[0].text, 'changed');
});

test('pause during a key-triggered scan cancels display; a later activation recovers', async () => {
  const { ctx, counts, finishCapture } = controller();
  const pending = ctx.beginPicking(); ctx.stopMonitoring(); finishCapture();
  assert.equal((await pending).stopped, true); assert.equal(counts.shown, 0);
  await ctx.startMonitoring({ minimize: false }); assert.equal(counts.captures, 1);
  const next = ctx.beginPicking(); finishCapture(); assert.equal((await next).ok, true); assert.equal(counts.shown, 1);
});

test('overlay-ready race cannot reopen an old generation after pause and resume', async () => {
  const { ctx, counts, finishCapture } = controller();
  let ready;
  ctx.testReady = new Promise(resolve => { ready = resolve; });
  vm.runInContext('overlayReady = testReady;', ctx);
  const pending = ctx.beginPicking(); finishCapture();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(ctx.beginPicking(), pending); assert.equal(counts.captures, 1);
  ctx.stopMonitoring(); await ctx.startMonitoring({ minimize: false }); ready();
  assert.equal((await pending).stopped, true); assert.equal(counts.shown, 0);
});

test('trigger from own window minimizes before capture and preserves the selected monitor', async () => {
  const { ctx, counts, finishCapture } = controller();
  ctx.focused = true; ctx.cursorDisplay = { id: '2' };
  const pending = ctx.beginPicking();
  assert.equal(counts.minimized, 1); assert.equal(counts.captures, 0);
  ctx.cursorDisplay = { id: '1' };
  await new Promise(resolve => setTimeout(resolve, 175));
  assert.deepEqual(counts.targets, ['2']); finishCapture(); assert.equal((await pending).ok, true);
});

test('empty/error results do not retry automatically and allow a later key attempt', async () => {
  const { ctx, counts, finishCapture, failCapture } = controller();
  ctx.testWords = [];
  const empty = ctx.beginPicking(); finishCapture(); assert.equal((await empty).ok, false);
  assert.equal(counts.captures, 1); assert.equal(counts.shown, 0); assert.equal(ctx.publicState().scanning, false);
  assert.equal(counts.payloads.length, 0); ctx.cancelPicking();
  const failed = ctx.beginPicking(); failCapture(); assert.match((await failed).error, /test capture/);
  assert.equal(counts.captures, 2); assert.equal(counts.shown, 0);
  ctx.testWords = [{ text: 'recovered', x: 10, y: 10, width: 50, height: 20, confidence: 95, tokenIndex: 0, lineId: '0' }];
  const next = ctx.beginPicking(); finishCapture(); assert.equal((await next).ok, true);
});

test('paused mode and binding recording suppress screen capture', async () => {
  const { ctx, counts } = controller();
  ctx.stopMonitoring(); assert.equal((await ctx.beginPicking()).ok, false);
  await ctx.startMonitoring({ minimize: false }); ctx.beginKeyCapture();
  assert.equal((await ctx.beginPicking()).recording, true); assert.equal(counts.captures, 0);
  await ctx.finishKeyCapture(); ctx.stopMonitoring();
});

test('new search and settings IPC reject foreign renderers', async () => {
  const { handlers } = controller();
  const foreign = {sender:{id:999}};
  assert.equal((await handlers.get('hotkey:save')(foreign,{type:'mouse',button:'MIDDLE'})).ok,false);
  assert.equal((await handlers.get('hotkey:capture-start')(foreign)).ok,false);
  assert.equal(handlers.get('dictionary:search')(foreign,'acrophobic').found,false);
  assert.equal(handlers.get('dictionary:suggest')(foreign,'ac').words.length,0);
  assert.equal(handlers.has('image:open'), false);
});

test('word layout must acknowledge before the overlay is shown; foreign/stale replies are ignored', async () => {
  const { ctx, counts, finishCapture, handlers } = controller(); ctx.autoAck = false;
  const pending = ctx.beginPicking(); finishCapture(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(counts.shown, 0); const id = counts.payloads[0].data.requestId;
  const revision = counts.payloads[0].data.revision;
  handlers.get('overlay:words-ready')({ sender: { id: 999 } }, id, revision, true);
  handlers.get('overlay:words-ready')({ sender: { id: 2 } }, id + 1, revision, true);
  handlers.get('overlay:words-ready')({ sender: { id: 2 } }, id, revision - 1, true);
  assert.equal(counts.shown, 0);
  handlers.get('overlay:words-ready')({ sender: { id: 2 } }, id, revision, true);
  assert.equal((await pending).ok, true); assert.equal(counts.shown, 1);
});
test('cancel while preparing word boxes clears the layer and suppresses late acknowledgement', async () => {
  const { ctx, counts, finishCapture, handlers } = controller(); ctx.autoAck = false;
  const pending = ctx.beginPicking(); finishCapture(); await new Promise(resolve => setImmediate(resolve));
  const id = counts.payloads[0].data.requestId; ctx.cancelPicking();
  handlers.get('overlay:words-ready')({ sender: { id: 2 } }, id, counts.payloads[0].data.revision, true);
  assert.equal((await pending).stopped, true); assert.equal(counts.shown, 0); assert.ok(counts.cleared);
});
test('internal frame replay shares the final-only controller without enabling global capture', async () => {
  const { ctx, counts } = controller(); ctx.stopMonitoring();
  const frame = { buffer: Buffer.from('file-image'), width: 100, height: 100,
    makeSupplement: () => ({ buffer: Buffer.from('enhanced'), mode: 'bright-text' }) };
  assert.equal((await ctx.beginPicking({ frameProvider: async () => frame })).ok, true);
  assert.equal(counts.captures, 0); assert.equal(counts.shown, 1); assert.equal(counts.payloads.length, 1);
  assert.equal(ctx.publicState().monitoring, false); ctx.cancelPicking();
});
test('enabling screen capture during internal replay dismisses the old word layer', async () => {
  const { ctx, counts } = controller(); ctx.stopMonitoring();
  const frame = { buffer: Buffer.from('file-image'), width: 100, height: 100,
    makeSupplement: () => ({ buffer: Buffer.from('enhanced'), mode: 'bright-text' }) };
  await ctx.beginPicking({ frameProvider: async () => frame });
  assert.equal(ctx.publicState().picking, true);
  assert.equal((await ctx.startMonitoring({ minimize: false })).ok, true);
  assert.equal(ctx.publicState().picking, false); assert.ok(counts.cleared >= 2);
});

test('initial window fits a high-DPI 688px workspace', () => {
  const source=fs.readFileSync(path.join(__dirname,'src/electron/main.cjs'),'utf8');
  let options;
  const ctx=vm.createContext({path,__dirname,screen:{getPrimaryDisplay:()=>({workAreaSize:{width:1280,height:688}})},Menu:{setApplicationMenu(){}},
    BrowserWindow:class {constructor(config){options=config;this.webContents={setWindowOpenHandler(){},on(){}};}loadFile(){}once(){}on(){}},
    mainWindow:null,isQuitting:false,app:{quit(){}},runtime:{capturingKey:false}});
  vm.runInContext(source.slice(source.indexOf('function createMainWindow()'),source.indexOf('function createOverlayWindow()')),ctx);
  ctx.createMainWindow();assert.equal(options.height,460);assert.ok(options.minHeight<=options.height);assert.equal(options.width,660);
});

test('content sizing expands, shrinks and stays within the current display', () => {
  const {fitWindowToContent}=require('./src/electron/window-layout.cjs');
  let bounds={x:100,y:420,width:660,height:460}, maximized=false;
  const window={isDestroyed:()=>false,isMaximized:()=>maximized,isFullScreen:()=>false,isMinimized:()=>false,
    getBounds:()=>bounds,getContentBounds:()=>({...bounds,height:bounds.height-32}),setBounds:value=>{bounds=value;}};
  const screen={getDisplayMatching:()=>({workArea:{x:0,y:0,width:1280,height:688}})};
  fitWindowToContent(window,screen,1200);assert.equal(bounds.height,664);assert.equal(bounds.y,12);
  fitWindowToContent(window,screen,400);assert.equal(bounds.height,432);
  for(const bad of [NaN,Infinity,-1,'400',100001])fitWindowToContent(window,screen,bad);
  assert.equal(bounds.height,432);
  maximized=true;fitWindowToContent(window,screen,600);assert.equal(bounds.height,432);
});
