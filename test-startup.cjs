'use strict';
// Run the packaged controller and renderer with hidden, isolated test windows.
// Desktop capture is replaced by a trap; no user profile or live screen is read.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const assert = require('node:assert/strict');
const electron = require('electron');
const { app, BrowserWindow } = electron;
app.disableHardwareAcceleration();
const resources = path.join(__dirname, process.env.SCREEN_WORD_TEST_PAYLOAD || 'dist/win-unpacked', 'resources');
const archive = path.join(resources, 'app.asar');
const entry = path.join(archive, 'electron/main.cjs');
app.setPath('userData', path.join(__dirname, 'startup-test-profile'));
const requireApp = require('node:module').createRequire(entry);
const windows = [], imports = [];
let context, captures = 0, useFixture = false;
const fixturePath = path.join(__dirname, 'qa-fixtures/eight-generations.png');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) { if (await predicate()) return; await wait(30); }
  throw Error('Startup check timed out');
}
class HiddenWindow extends BrowserWindow {
  constructor(options) {
    super({ ...options, show: false, webPreferences: { ...options.webPreferences, offscreen: true, backgroundThrottling: false } });
    this.showCalls = 0;
    this.virtualVisible = false;
    this.show = () => { this.virtualVisible=true; this.showCalls++; this.lastShownAt = performance.now(); };
    const nativeHide=this.hide.bind(this);
    this.hide=()=>{this.virtualVisible=false;this.lastHiddenAt=performance.now();nativeHide();};
    this.isVisible=()=>this.virtualVisible;
    this.batchEvents = [];
    const send = this.webContents.send.bind(this.webContents);
    this.webContents.send = (channel, value) => {
      if (channel === 'overlay:words') this.batchEvents.push({requestId:value.requestId, revision:value.revision, complete:value.complete, stage:value.stage, at:performance.now(), count:value.words.length});
      send(channel,value);
    };
    this.minimize = () => {};
    this.focus = () => {};
    this.moveTop = () => {};
    windows.push(this);
  }
}
const fakeApp = new Proxy(app, { get(target, key) {
  if (key === 'isPackaged') return true;
  if (key === 'getAppPath') return () => archive;
  if (['setName', 'setPath', 'quit'].includes(key)) return () => {};
  const value = target[key]; return typeof value === 'function' ? value.bind(target) : value;
} });
async function main() {
  const testProcess = Object.create(process);
  Object.defineProperty(testProcess, 'resourcesPath', { value: resources });
  context = vm.createContext({ console, setTimeout, clearTimeout, process: testProcess, __dirname: path.dirname(entry),
    require: name => {
      imports.push(name);
      if (name === 'electron') return { ...electron, app: fakeApp, BrowserWindow: HiddenWindow,
        desktopCapturer: { getSources: async () => {
          if (!useFixture) throw Error('Unexpected desktop capture');
          assert.equal(windows[1].isVisible(),false,'overlay must be hidden at the capture boundary');
          captures++;
          return [{ display_id: String(electron.screen.getPrimaryDisplay().id), thumbnail: electron.nativeImage.createFromPath(fixturePath) }];
        } } };
      return requireApp(name);
    },
  });
  const source = fs.readFileSync(entry, 'utf8');
  vm.runInContext(source.slice(0, source.indexOf('const gotLock =')), context);
  const begin = performance.now();
  context.startApplication();
  const mainWindow = windows[0];
  await until(() => !mainWindow.webContents.isLoadingMainFrame());
  const run = code => mainWindow.webContents.executeJavaScript(code, true);
  await until(() => run("typeof loaded !== 'undefined' && loaded"));
  const initialReadyMs = Math.round(performance.now() - begin);
  assert.equal(windows.length, 1);
  assert.equal(context.publicState().monitoring, false);
  assert.equal(context.publicState().mouseHotkeyReady, false);
  assert.equal(imports.includes('./ocr.cjs'), false);
  assert.equal(vm.runInContext('ocrPipeline === null && overlayWindow === null && !hotkeys.live', context), true);
  assert.equal(await run("toggleButton.textContent === '启用取词' && !toggleButton.disabled"), true);
  assert.equal(await run("!document.getElementById('imageButton') && !('openImage' in window.screenCapture)"), true);
  assert.equal(typeof context.openImage, 'undefined');
  await run("searchInput.value='acrophobic';document.getElementById('searchForm').requestSubmit()");
  await until(() => run("resultBox.innerText.includes('恐高')"));
  assert.equal(context.publicState().monitoring, false);
  assert.equal(imports.includes('./ocr.cjs'), false);
  await run('toggleButton.click()');
  await until(() => context.publicState().monitoring);
  await vm.runInContext('ocrPipeline.prewarm()', context);
  assert.equal(windows.length, 2);
  assert.equal(imports.filter(name => name === './ocr.cjs').length, 1);
  assert.equal(vm.runInContext('hotkeys.live', context), true);
  assert.equal(captures, 0);
  useFixture = true;
  const captureStart = performance.now();
  const captureResult = await context.beginPicking(); assert.equal(captureResult.ok, true); assert.equal(captures, 1);
  const overlay = windows[1];
  assert.equal(overlay.isContentProtected(),false,'word boxes and definitions must allow recording');
  const stageTimings = [{ name:'eight-generations', firstShownMs:Math.round(overlay.lastShownAt-captureStart), allShownMs:Math.round(performance.now()-captureStart) }];
  assert.equal(overlay.showCalls,1);
  // Nearly simultaneous lanes may coalesce directly into one final batch.
  assert.ok(overlay.batchEvents.at(-1).complete, JSON.stringify(overlay.batchEvents));
  const overlayRun = code => overlay.webContents.executeJavaScript(code, true);
  await until(() => overlayRun('payload?.complete && layer.children.length > 0'));
  const captureWords = JSON.stringify(vm.runInContext('runtime.latestCapture.words', context));
  assert.equal(await overlayRun("!document.querySelector('img,canvas,video') && ['eight','generations','is','a','very','long','time'].every(w=>[...layer.children].some(b=>b.dataset.word===w))"), true);
  assert.equal(await overlayRun("[document.documentElement,document.body,surface].every(e=>getComputedStyle(e).backgroundColor==='rgba(0, 0, 0, 0)' && getComputedStyle(e).backgroundImage==='none')"), true);
  const toolbarOverlaps = await overlayRun("(() => { const r=document.querySelector('.toolbar').getBoundingClientRect(); return {toolbar:r.toJSON(),words:[...layer.children].filter(b=>{const w=b.getBoundingClientRect();return Math.min(r.right,w.right)>Math.max(r.left,w.left)&&Math.min(r.bottom,w.bottom)>Math.max(r.top,w.top)}).map(b=>({word:b.dataset.word,rect:b.getBoundingClientRect().toJSON()}))}; })()");
  assert.ok(!toolbarOverlaps.words.some(w => ['eight','generations','is','a','very','long','time'].includes(w.word)), 'toolbar must not cover the caption');
  await wait(200);
  const transparentPreview = await overlay.webContents.capturePage();
  const size = transparentPreview.getSize(), pixels = transparentPreview.toBitmap();
  assert.equal(pixels[(Math.floor(size.height * .6) * size.width + Math.floor(size.width * .5)) * 4 + 3], 0);
  fs.writeFileSync(path.join(__dirname, '透明词框预览.png'), transparentPreview.toPNG());
  context.cancelPicking();
  await until(() => overlayRun("surface.hidden && !layer.children.length"));
  await run('toggleButton.click()');
  await until(() => !context.publicState().monitoring);
  assert.equal(vm.runInContext('hotkeys.live', context), false);
  vm.runInContext('ocrPipeline.clear()', context);
  // Internal deterministic replay remains testable, without any user-facing
  // file picker or renderer IPC entry.
  const replayFrame = await requireApp('./ocr-frame.cjs').frameFromFile(fixturePath, electron.nativeImage);
  assert.equal((await context.beginPicking({ frameProvider: async () => replayFrame })).ok, true);
  await until(() => context.publicState().picking && !context.publicState().scanning);
  await until(() => overlayRun('payload?.complete && layer.children.length > 0'));
  assert.equal(captures, 1);
  assert.equal(context.publicState().monitoring, false);
  assert.equal(JSON.stringify(vm.runInContext('runtime.latestCapture.words', context)), captureWords);
  assert.equal(await overlayRun("!document.querySelector('img,canvas,video')"), true);
  context.cancelPicking();
  await until(() => overlayRun('surface.hidden'));
  const captionFrame = await requireApp('./ocr-frame.cjs').frameFromFile(path.join(__dirname, 'qa-fixtures/seven-generations.png'), electron.nativeImage);
  const priorShows = overlay.showCalls, captionStart = performance.now();
  assert.equal((await context.beginPicking({ frameProvider: async () => captionFrame })).ok, true);
  stageTimings.push({name:'seven-generations',firstShownMs:Math.round(overlay.lastShownAt-captionStart),allShownMs:Math.round(performance.now()-captionStart)});
  assert.equal(overlay.showCalls,priorShows+1);
  const lastRequest=overlay.batchEvents.at(-1).requestId;
  const lastBatches=overlay.batchEvents.filter(e=>e.requestId===lastRequest);
  assert.ok(lastBatches.length>=1 && lastBatches.at(-1).complete===true);
  assert.ok(lastBatches.every((e,i)=>e.revision===i+1));
  await until(() => overlayRun("payload?.complete && document.querySelector('[data-word=generations]') && document.querySelector('[data-word=represents]')"));
  assert.equal(await overlayRun("Boolean(document.querySelector('[data-word=ents]'))"), false);
  assert.equal(await overlayRun("(() => { const b=document.querySelector('[data-word=generations]'),r=b.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===b; })()"), true);
  await overlayRun("document.querySelector('[data-word=generations]').click()");
  await until(() => overlayRun("!card.hidden && lookupWord.value==='generations' && body.innerText.includes('代')"));
  const captionDefinition = await overlayRun('body.innerText');
  await wait(150);
  fs.writeFileSync(path.join(__dirname, 'generations-lookup.png'), (await overlay.webContents.capturePage()).toPNG());
  context.cancelPicking();
  const report = { passed: true, resources, initialReadyMs, startupPaused: true, startupOcrImported: false,
    startupWindowCount: 1, searchWhilePaused: true, explicitEnableLoadsWorkers: true,
    explicitEnableCreatesOverlay: true, pauseUnregistersKey: true, desktopCaptured: false, personalProfileUsed: false,
    screenReplaySameResult: true, transparentOverlayVerified: true, screenshotDisplayed: false, imageEntryRemoved: true, fixtureCaptureCount: captures,
    generationsClickable: true, representsWhole: true, captionDefinition,
    progressiveVerified: true, stageTimings, stageTimingScope: 'Prewarmed, isolated hidden controller/renderer using a fixture frame; first shown is the show() call after paint acknowledgement, not actual game/OS composition.',
    contentProtectionDisabled: true, captureOverlayHidden: true, obsRecordingTested: false,
    timingScope: 'From controller start to isolated hidden renderer ready; excludes Electron launch and portable extraction.' };
  fs.writeFileSync(path.join(__dirname, 'startup-test-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
}
async function cleanup() {
  if (context) await vm.runInContext('isQuitting = true; hotkeys?.stop(); chineseDictionary?.close(); ocrPipeline?.terminate();', context);
  for (const w of windows) if (!w.isDestroyed()) w.destroy();
}
app.whenReady().then(main).then(async () => { await cleanup(); app.exit(0); }).catch(async error => {
  console.error(error); await cleanup(); app.exit(1);
});
