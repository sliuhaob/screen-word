'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  app,
  BrowserWindow,
  Menu,
  desktopCapturer,
  ipcMain,
  nativeImage,
  screen,
  globalShortcut,
} = require('electron');
const { ChineseDictionary } = require('./chinese-dictionary.cjs');
const { isValidLookupTerm, normalizeWord } = require('./dictionaries.cjs');
const { frameFromCapture } = require('./ocr-frame.cjs');
const { lookupWords } = require('./screen-ocr.cjs');
const { MouseSideHotkey } = require('./mouse-hotkey.cjs');
const { HotkeyManager, readBinding, writeBinding, bindingLabel } = require('./hotkeys.cjs');
const { fitWindowToContent } = require('./window-layout.cjs');

// A packaged GUI app has no console. Tesseract may still emit harmless status
// lines; swallowing a closed stdout/stderr pipe prevents Windows error dialogs.
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});

let mainWindow = null;
let overlayWindow = null;
let overlayEditing = false;
let recognizer = null;
let ocrPipeline = null;
let chineseDictionary = null;
let mouseHotkey = null;
let currentScanPromise = null;
let currentPickPromise = null;
let currentPickGeneration = -1;
let queuedPickPromise = null;
let pickSequence = 0;
let isQuitting = false;
let scanGeneration = 0;
let overlayReady = Promise.resolve();
let hotkeys = null;
let captureTimer = null;
let controlQueue = Promise.resolve();
let requestedContentHeight = 420;
let wordsAck = null;
let overlayHiddenAt = -Infinity;
const serialize = (action) => {
  const next = controlQueue.then(action);
  controlQueue = next.catch(() => {});
  return next;
};

// Application identity, settings profile and single-instance lock.
app.setName('screen-word-standalone');
app.setPath('userData', path.join(app.getPath('appData'), 'screen-word-standalone'));

const runtime = {
  monitoring: false,
  scanning: false,
  picking: false,
  mouseHotkeyReady: false,
  latestCapture: null,
  message: '取词键尚未启用',
  capturingKey: false,
};

function publicState() {
  return {
    monitoring: runtime.monitoring,
    scanning: runtime.scanning,
    picking: runtime.picking,
    mouseHotkeyReady: runtime.mouseHotkeyReady,
    recognizedCount: runtime.latestCapture?.words?.length || 0,
    message: runtime.message,
    binding: hotkeys?.binding || readBinding(path.join(app.getPath('userData'), 'settings.json')),
    bindingLabel: hotkeys ? bindingLabel(hotkeys.binding) : '鼠标后退侧键',
    capturingKey: runtime.capturingKey,
  };
}

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('monitor:state', publicState());
  }
}

function setRuntime(patch) {
  Object.assign(runtime, patch);
  emitState();
}

function reportProcessError(kind, error) {
  const detail = error?.stack || error?.message || String(error);
  if (process.env.SCREEN_WORD_QA_LOG_PATH) {
    try {
      fs.appendFileSync(
        process.env.SCREEN_WORD_QA_LOG_PATH,
        `${new Date().toISOString()} [${kind}] ${detail}\n`,
        'utf8',
      );
    } catch { /* QA logging must never interrupt the app. */ }
  }
  if (error?.code !== 'EPIPE') {
    setRuntime({ message: `屏幕取词遇到错误：${error?.message || String(error)}` });
  }
}

process.on('uncaughtException', (error) => reportProcessError('uncaughtException', error));
process.on('unhandledRejection', (error) => reportProcessError('unhandledRejection', error));

function createMainWindow() {
  const available = screen.getPrimaryDisplay().workAreaSize;
  const width = Math.min(660, Math.max(320, available.width - 24));
  const height = Math.min(460, Math.max(280, available.height - 24));
  mainWindow = new BrowserWindow({
    width,
    height,
    minWidth: Math.min(500, width),
    minHeight: Math.min(280, height),
    backgroundColor: '#f6f5f0',
    title: '屏幕取词',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, '..', 'desktop', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow?.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) event.preventDefault();
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
    if (!isQuitting) app.quit();
  });
  mainWindow.on('blur', () => {
    if (runtime.capturingKey) void serialize(finishKeyCapture);
  });
  mainWindow.on('restore', () => fitWindowToContent(mainWindow, screen, requestedContentHeight));
  mainWindow.on('unmaximize', () => fitWindowToContent(mainWindow, screen, requestedContentHeight));
}

function createOverlayWindow() {
  overlayWindow = new BrowserWindow({
    width: 800,
    height: 600,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    show: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.cjs'),
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      devTools: false,
    },
  });
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  // Allow display recording to include both word boxes and definition cards.
  overlayWindow.setContentProtection(false);
  overlayReady = overlayWindow.loadFile(path.join(__dirname, '..', 'desktop', 'overlay.html'));
  overlayWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  overlayWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  overlayWindow.on('closed', () => { overlayWindow = null; });
}

function setOverlayEditing(editing) {
  if (!overlayWindow || overlayWindow.isDestroyed() || !runtime.picking) return;
  const nextEditing = Boolean(editing);
  if (overlayEditing === nextEditing) return;
  overlayEditing = nextEditing;
  if (nextEditing) {
    // Keep one stable native window for the whole definition-card session.
    // Refocusing during a select/IME popup dismisses that transient window.
    overlayWindow.setAlwaysOnTop(false);
    return;
  }
  overlayWindow.setAlwaysOnTop(true, 'screen-saver');
  overlayWindow.moveTop();
}

function prepareCaptureServices() {
  // OCR imports, workers and the hidden renderer are opt-in, not startup work.
  if (!ocrPipeline) {
    const { OfflineRecognizer } = require('./ocr.cjs');
    const { ScreenOcrPipeline } = require('./screen-ocr.cjs');
    const options = { packaged: app.isPackaged, resourcesPath: process.resourcesPath, appPath: app.getAppPath() };
    recognizer = new OfflineRecognizer(options);
    ocrPipeline = new ScreenOcrPipeline(recognizer, new OfflineRecognizer(options), { lookup: term => chineseDictionary.lookup(term) });
  }
  if (!overlayWindow || overlayWindow.isDestroyed()) createOverlayWindow();
}

function initializeServices() {
  chineseDictionary = new ChineseDictionary({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
  });
  mouseHotkey = new MouseSideHotkey({
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    appPath: app.getAppPath(),
    onTrigger: () => {
      triggerPicking();
    },
    onStatus: ({ ready, message }) => {
      runtime.mouseHotkeyReady = Boolean(ready);
      if (message) runtime.message = `取词键不可用：${message}`;
      emitState();
    },
  });
  const settingsFile = path.join(app.getPath('userData'), 'settings.json');
  hotkeys = new HotkeyManager({ keyboard: globalShortcut, mouse: mouseHotkey,
    binding: readBinding(settingsFile), persist: (binding) => writeBinding(settingsFile, binding),
    onTrigger: triggerPicking });
}

function triggerPicking() {
  if (!runtime.monitoring || runtime.capturingKey || !hotkeys?.live || hotkeys.suspended) return;
  void beginPicking().catch((error) => setRuntime({ message: error?.message || '无法打开屏幕取词层' }));
}

function beginKeyCapture() {
  clearTimeout(captureTimer);
  hotkeys.suspend();
  runtime.capturingKey = true;
  captureTimer = setTimeout(() => { void serialize(finishKeyCapture); }, 30000);
  emitState();
  return { ok: true };
}

async function finishKeyCapture() {
  clearTimeout(captureTimer); captureTimer = null;
  if (!runtime.capturingKey) return { ok: true };
  runtime.capturingKey = false;
  try { await hotkeys.resume(); }
  catch (error) { stopMonitoring(); setRuntime({ message: error.message }); }
  emitState();
  return { ok: true };
}

async function saveBinding(value) {
  await finishKeyCapture();
  try {
    await hotkeys.setBinding(value);
    setRuntime({ message: `取词键已保存：${bindingLabel(hotkeys.binding)}` });
    return { ok: true, ...publicState() };
  } catch (error) {
    if (runtime.monitoring && !hotkeys.live) stopMonitoring();
    return { ok: false, error: error.message, ...publicState() };
  }
}

function displayAtCursor() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

function hideOverlayWindow() {
  if (!overlayWindow || overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return false;
  overlayWindow.hide();
  overlayHiddenAt = Date.now();
  return true;
}

async function captureDisplay(display, { shouldStop = () => false } = {}) {
  // Capture exclusion would also hide the overlay from OBS. Instead hide our
  // window before capture and let a recent hide reach the desktop compositor.
  if (hideOverlayWindow()) {
    overlayEditing = false;
    runtime.picking = false;
    overlayWindow.webContents.send('overlay:clear');
  }
  const remaining = 80 - (Date.now() - overlayHiddenAt);
  if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining));
  if (shouldStop()) return null;
  const physicalWidth = Math.max(1, Math.round(display.bounds.width * display.scaleFactor));
  const physicalHeight = Math.max(1, Math.round(display.bounds.height * display.scaleFactor));
  const thumbnailSize = {
    width: physicalWidth,
    height: physicalHeight,
  };
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize,
    fetchWindowIcons: false,
  });
  let source = sources.find((candidate) => String(candidate.display_id) === String(display.id));
  if (!source) {
    const index = screen.getAllDisplays()
      .findIndex((candidate) => String(candidate.id) === String(display.id));
    source = sources[Math.max(0, index)] || sources[0];
  }
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('无法读取鼠标所在的屏幕');
  }

  return {
    ...frameFromCapture(source.thumbnail, nativeImage),
    displayId: String(display.id),
    bounds: { ...display.bounds },
  };
}

function scanScreen({ display, frameProvider, onResult = async () => {} } = {}) {
  if (currentScanPromise) return currentScanPromise;
  if (!runtime.monitoring && !frameProvider) return Promise.resolve({ ok: false, stopped: true });

  const generation = scanGeneration;
  currentScanPromise = (async () => {
    setRuntime({ scanning: true, message: '正在识别屏幕文字…' });
    try {
      const stopped = () => generation !== scanGeneration || (!frameProvider && !runtime.monitoring) || isQuitting;
      const capture = await (frameProvider ? frameProvider() : captureDisplay(display || displayAtCursor(), { shouldStop: stopped }));
      if (stopped()) return { ok: false, stopped: true };
      const publish = async (result, complete) => {
        if (stopped()) return;
        const clickableWords = lookupWords(result.words, term => chineseDictionary.lookup(term));
        runtime.latestCapture = {
          width: capture.width, height: capture.height, displayId: capture.displayId,
          bounds: capture.bounds, words: clickableWords,
        };
        await onResult(runtime.latestCapture, { complete, stage: result.stage || 'final' });
        if (stopped()) return;
        setRuntime({ scanning: !complete, message: clickableWords.length
          ? `已识别 ${clickableWords.length} 个可点击项${!complete ? '，继续补充中…' : result.degraded ? '（一路识别失败，可再次取词重试）' : '，请点击单词'}`
          : `未识别到清晰英文，可调整画面后再按 ${bindingLabel(hotkeys.binding)}` });
      };
      const result = await ocrPipeline.recognize(capture, {
        shouldStop: stopped,
        onPartial: result => publish(result, false),
      });
      if (result.stopped || stopped()) {
        return { ok: false, stopped: true };
      }
      await publish(result, true);
      if (stopped()) return { ok: false, stopped: true };
      return { ok: true, count: runtime.latestCapture.words.length };
    } catch (error) {
      if (generation !== scanGeneration || (!frameProvider && !runtime.monitoring) || isQuitting) {
        return { ok: false, stopped: true };
      }
      cancelPicking();
      setRuntime({
        scanning: false,
        message: error?.message || '屏幕识别失败',
      });
      return { ok: false, error: error?.message || '屏幕识别失败' };
    } finally {
      currentScanPromise = null;
    }
  })();
  return currentScanPromise;
}

async function startMonitoring({ minimize = true } = {}) {
  if (runtime.monitoring) return { ok: true, ...publicState() };
  if (runtime.capturingKey) return { ok: false, error: '请先完成快捷键录入', ...publicState() };
  if (runtime.picking || currentPickPromise) cancelPicking();
  try { await hotkeys.start(); }
  catch (error) { setRuntime({ message: error.message }); return { ok: false, error: error.message, ...publicState() }; }
  if (isQuitting) { hotkeys.stop(); return { ok: false, stopped: true }; }
  try { prepareCaptureServices(); }
  catch (error) { hotkeys.stop(); setRuntime({ message: error.message }); return { ok: false, error: error.message, ...publicState() }; }
  scanGeneration += 1;
  const generation = scanGeneration;
  runtime.monitoring = true;
  runtime.latestCapture = null;
  // Preload only after the user enables capture. The UI does not wait for it.
  void ocrPipeline.prewarm().catch((error) => {
    if (!isQuitting && runtime.monitoring && generation === scanGeneration) reportProcessError('ocr-prewarm', error);
  });
  setRuntime({ message: `已就绪，按 ${bindingLabel(hotkeys.binding)} 识别当前屏幕` });
  if (minimize && mainWindow && !mainWindow.isDestroyed()) mainWindow.minimize();
  return { ok: true, ...publicState() };
}

function stopMonitoring() {
  ocrPipeline?.clear();
  scanGeneration += 1;
  runtime.monitoring = false;
  runtime.scanning = false;
  runtime.latestCapture = null;
  hotkeys?.stop();
  cancelPicking();
  setRuntime({ message: '取词键已暂停' });
  return { ok: true, ...publicState() };
}

function toggleMonitoring() {
  return runtime.monitoring ? stopMonitoring() : startMonitoring();
}

function presentWords(capture, requestId, revision, complete, stage) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (wordsAck?.requestId === requestId) wordsAck = null;
      reject(Error('取词框准备超时，请重新取词'));
    }, 10000);
    wordsAck = { requestId, revision, finish(ok) { clearTimeout(timer); wordsAck = null; resolve(ok); } };
    // Only coordinates and words cross into the transparent renderer. Captured
    // pixels remain in the OCR pipeline and are never displayed as a background.
    overlayWindow.webContents.send('overlay:words', {
      requestId, revision, complete, stage, captureWidth: capture.width, captureHeight: capture.height,
      words: capture.words,
      bindingLabel: runtime.monitoring ? bindingLabel(hotkeys.binding) : 'Esc',
    });
  });
}

function beginPicking({ frameProvider } = {}) {
  if (!runtime.monitoring && !frameProvider) return Promise.resolve({ ok: false, error: '请先启用取词' });
  if (runtime.capturingKey || hotkeys?.suspended) return Promise.resolve({ ok: false, recording: true });
  if (runtime.picking) {
    cancelPicking();
    return Promise.resolve({ ok: true, cancelled: true });
  }
  // Include the overlay-ready wait in the single-flight guard. Key repeat must
  // not produce multiple screenshots or reopen the overlay after a stop.
  if (currentPickPromise) {
    if (currentPickGeneration === scanGeneration) return currentPickPromise;
    // A cancelled scan still owns the workers until both jobs settle. Queue
    // one fresh key request rather than mixing workers or returning stale data.
    if (!queuedPickPromise) {
      const queuedGeneration = scanGeneration;
      queuedPickPromise = currentPickPromise.catch(() => {}).then(() => {
        if (queuedGeneration !== scanGeneration || (!frameProvider && !runtime.monitoring) || isQuitting) return { ok: false, stopped: true };
        return beginPicking({ frameProvider });
      }).finally(() => { queuedPickPromise = null; });
    }
    return queuedPickPromise;
  }
  const generation = scanGeneration;
  currentPickGeneration = generation;
  const requestId = ++pickSequence;
  let revision = 0;
  const cursorDisplay = displayAtCursor();
  currentPickPromise = (async () => {
    // When triggered from this app's own window, capture the window behind it.
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isFocused()) {
      mainWindow.minimize();
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const stopped = () => generation !== scanGeneration || (!frameProvider && !runtime.monitoring) || isQuitting;
    if (stopped()) return { ok: false, stopped: true };
    // Always take a new snapshot on a key press. The OCR layer may reuse its
    // result only after comparing that snapshot's full image hash.
    const showResult = async (capture, { complete, stage }) => {
      if (!capture.words.length && !runtime.picking) return;
      await overlayReady;
      if (stopped() || !overlayWindow || overlayWindow.isDestroyed()) return;
      const display = screen.getAllDisplays().find(candidate => String(candidate.id) === capture.displayId) || cursorDisplay;
      const firstDisplay = !runtime.picking;
      if (firstDisplay) overlayWindow.setBounds(display.bounds);
      const ready = await presentWords(capture, requestId, ++revision, complete, stage);
      if (stopped()) return;
      if (!ready) throw Error('无法显示本次取词框，请重新取词');
      // Later batches must not refocus the window, reset IME, or interrupt a
      // definition already being edited. Only the first batch opens the layer.
      if (!firstDisplay) return;
      overlayEditing = false;
      overlayWindow.setAlwaysOnTop(true, 'screen-saver');
      runtime.picking = true;
      emitState();
      overlayWindow.show();
      overlayWindow.moveTop();
      overlayWindow.focus();
      overlayWindow.webContents.focus();
    };
    const scan = await scanScreen({ display: cursorDisplay, frameProvider, onResult: showResult });
    if (!scan.ok) return scan;
    if (stopped()) return { ok: false, stopped: true };
    await overlayReady;
    if (stopped() || !overlayWindow || overlayWindow.isDestroyed()) return { ok: false, stopped: true };
    if (!runtime.latestCapture?.words?.length) {
      setRuntime({ message: '当前画面没有识别到可点击的英文单词，请调整画面后重试' });
      return { ok: false, error: runtime.message };
    }

    return { ok: true, count: runtime.latestCapture.words.length };
  })().finally(() => { currentPickPromise = null; });
  return currentPickPromise;
}

function cancelPicking() {
  scanGeneration += 1;
  runtime.scanning = false;
  runtime.latestCapture = null;
  runtime.picking = false;
  overlayEditing = false;
  wordsAck?.finish(false);
  if (overlayWindow && !overlayWindow.isDestroyed()) {
    overlayWindow.setAlwaysOnTop(true, 'screen-saver');
    hideOverlayWindow();
    overlayWindow.webContents.send('overlay:clear');
  }
  if (runtime.monitoring && !runtime.scanning) {
    runtime.message = `已就绪，按 ${bindingLabel(hotkeys.binding)} 识别当前屏幕`;
  }
  if (!runtime.monitoring) runtime.message = '取词键尚未启用';
  emitState();
}

function registerIpc() {
  const fromMain = (event) => mainWindow && event.sender.id === mainWindow.webContents.id;
  const fromOverlay = (event) => overlayWindow && event.sender.id === overlayWindow.webContents.id;
  ipcMain.on('window:fit-content', (event, height) => {
    if (!fromMain(event) || typeof height !== 'number' || !Number.isFinite(height) || height <= 0 || height > 100000) return;
    requestedContentHeight = height;
    fitWindowToContent(mainWindow, screen, height);
  });
  ipcMain.handle('monitor:get-state', (event) => fromMain(event) ? publicState() : null);
  ipcMain.handle('monitor:toggle', (event) => fromMain(event) ? serialize(toggleMonitoring) : { ok: false });
  ipcMain.handle('hotkey:save', (event, value) => fromMain(event) ? serialize(() => saveBinding(value)) : { ok: false });
  ipcMain.handle('hotkey:capture-start', (event) => fromMain(event) ? serialize(beginKeyCapture) : { ok: false });
  ipcMain.handle('hotkey:capture-end', (event) => fromMain(event) ? serialize(finishKeyCapture) : { ok: false });
  ipcMain.handle('dictionary:search', (event, value) => {
    if (!fromMain(event) || typeof value !== 'string' || value.length > 200) return { found: false, error: '请输入英文单词或词组' };
    return chineseDictionary.lookup(value, { manual: true });
  });
  ipcMain.handle('dictionary:suggest', (event, value) => {
    if (!fromMain(event) || typeof value !== 'string' || value.length > 96) return { words: [] };
    try { return { words: chineseDictionary.suggest(value) }; }
    catch { return { words: [], error: '词库暂时不可用，请重启应用' }; }
  });
  ipcMain.on('overlay:lookup', (event, selectedWord) => {
    if (!fromOverlay(event) || typeof selectedWord !== 'string') return;
    const word = normalizeWord(selectedWord);
    if (!isValidLookupTerm(word)) return;
    const definition = chineseDictionary.lookup(word);
    overlayWindow?.webContents.send('overlay:definition', definition);
  });
  ipcMain.on('overlay:set-editing', (event, editing) => {
    if (!overlayWindow || event.sender.id !== overlayWindow.webContents.id) return;
    setOverlayEditing(Boolean(editing));
  });
  ipcMain.on('overlay:cancel', (event) => { if (fromOverlay(event)) cancelPicking(); });
  ipcMain.on('overlay:words-ready', (event, requestId, revision, ok) => {
    if (fromOverlay(event) && wordsAck?.requestId === requestId && wordsAck.revision === revision) wordsAck.finish(ok === true);
  });
}

function startApplication() {
  initializeServices();
  registerIpc();
  createMainWindow();
  // Always start paused, regardless of the previous session's binding.
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.screenword.standalone');
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.whenReady().then(startApplication);
}

app.on('before-quit', () => {
  isQuitting = true;
  scanGeneration += 1;
  runtime.monitoring = false;
  clearTimeout(captureTimer);
  hotkeys?.stop();
  globalShortcut.unregisterAll();
  if (ocrPipeline) void ocrPipeline.terminate();
  chineseDictionary?.close();
});

app.on('window-all-closed', () => app.quit());
