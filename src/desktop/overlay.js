'use strict';
const layer = document.getElementById('wordLayer');
const card = document.getElementById('definitionCard');
const lookupWord = document.getElementById('lookupWord');
const phonetic = document.getElementById('phonetic');
const formNote = document.getElementById('formNote');
const body = document.getElementById('definitionBody');
let payload = null;
let latestRequestId = 0;
let renderEpoch = 0;
let latestWords = null;
const surface = document.getElementById('surface');
let selected = null;
let selectedWord = '';
let surfaceText = '';
let timer = null;
let composing = false;
let edited = false;
const normalize = (word) => String(word || '').normalize('NFKC').replace(/[’‘]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

function positionCard() {
  if (card.hidden || !selected) return;
  const a = selected.getBoundingClientRect();
  const r = card.getBoundingClientRect();
  let left = a.right + 12;
  if (left + r.width > innerWidth - 12) left = a.left - r.width - 12;
  card.style.left = `${Math.max(12, Math.min(left, innerWidth - r.width - 12))}px`;
  card.style.top = `${Math.max(72, Math.min(a.top, innerHeight - r.height - 12))}px`;
}
function message(text) {
  const p = document.createElement('p');
  p.className = 'message';
  p.textContent = text;
  body.replaceChildren(p);
}
function hideCard() {
  clearTimeout(timer);
  composing = false;
  if (!card.hidden) window.wordOverlay.setEditing(false);
  card.hidden = true;
  selected?.classList.remove('selected');
  selected = null;
  selectedWord = '';
  if (latestWords) reconcileWords(latestWords);
}
function selectWord(button, word) {
  clearTimeout(timer);
  selected?.classList.remove('selected');
  selected = button;
  selected.classList.add('selected');
  selectedWord = normalize(word.isPhrase && !word.isSeparable ? (word.surfaceText || word.text) : word.text);
  surfaceText = normalize(word.surfaceText || word.text);
  edited = false;
  lookupWord.value = selectedWord;
  phonetic.textContent = '';
  formNote.hidden = true;
  message('正在查询本地词典…');
  if (card.hidden) window.wordOverlay.setEditing(true);
  card.hidden = false;
  requestAnimationFrame(positionCard);
  window.wordOverlay.lookup(selectedWord);
  // Switching away releases any deferred correction at the previous anchor.
  if (latestWords) reconcileWords(latestWords);
}
function renderDefinition(result) {
  if (card.hidden || result?.word !== selectedWord) return;
  const entries = result.entries?.length ? result.entries : [{
    headword: selectedWord, phonetic: result.phonetic, translations: result.translations || [],
  }];
  const choices = document.createElement('div');
  choices.className = 'entry-choices';
  const content = document.createElement('div');
  body.replaceChildren(choices, content);
  function choose(entry, explicit = false) {
    if (!edited || explicit) lookupWord.value = entry.headword;
    phonetic.textContent = entry.phonetic ? `/${entry.phonetic}/` : '';
    formNote.hidden = !entry.formNote && (edited || (surfaceText === entry.headword && !result.ambiguous));
    formNote.textContent = entry.formNote || (result.ambiguous
      ? `画面词形：${surfaceText} · 可切换原词与还原词`
      : `画面词形：${surfaceText} → 原形：${entry.headword}`);
    for (const b of choices.children) b.setAttribute('aria-pressed', String(b.dataset.headword === entry.headword));
    content.replaceChildren();
    if (!entry.translations.length) {
      const p = document.createElement('p');
      p.className = 'message';
      p.textContent = result.error ? '本地词典暂时不可用，请重启应用。' : '词库暂未收录。可以修改上方识别文字后重试。';
      content.append(p);
    } else {
      const list = document.createElement('ol');
      list.className = 'meanings';
      for (const meaning of entry.translations) {
        const li = document.createElement('li');
        li.textContent = meaning.replace(/^a\.\s*/i, 'adj. ');
        list.append(li);
      }
      content.append(list);
    }
    requestAnimationFrame(positionCard);
  }
  if (entries.length > 1) {
    for (const entry of entries) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.headword = entry.headword;
      b.textContent = `${entry.isInflection ? '动词原形' : '原词形'} ${entry.headword}`;
      b.addEventListener('click', () => choose(entry, true));
      choices.append(b);
    }
  }
  choose(result.ambiguous ? entries[0] : entries.find((e) => e.headword === result.headword) || entries[0]);
}
function positionButton(button) {
  const w = button.ocrWord;
  const { scaleX, scaleY } = frameLayout(payload.captureWidth, payload.captureHeight, innerWidth, innerHeight);
  button.style.left = `${Math.max(0, w.x * scaleX - (w.isPhrase ? 0 : 4))}px`;
  button.style.top = `${Math.max(2, w.y * scaleY - (w.isPhrase ? 24 : 4))}px`;
  button.style.width = w.isPhrase ? '42px' : `${Math.max(16, w.width * scaleX + 8)}px`;
  button.style.height = w.isPhrase ? '20px' : `${Math.max(16, w.height * scaleY + 8)}px`;
}
function positionToolbar() {
  const toolbar = document.querySelector('.toolbar');
  const { width, height } = toolbar.getBoundingClientRect();
  const centered = Math.max(8, (innerWidth - width) / 2);
  const bottom = Math.max(8, innerHeight - height - 16);
  const choices = [[centered, 16], [centered, bottom], [16, 16], [16, bottom], [Math.max(8, innerWidth - width - 16), bottom]];
  const boxes = [...layer.children].map(b => b.getBoundingClientRect());
  const score = ([left, top]) => boxes.reduce((sum, r) => sum + Math.max(0, Math.min(left + width, r.right) - Math.max(left, r.left))
    * Math.max(0, Math.min(top + height, r.bottom) - Math.max(top, r.top)), 0);
  choices.sort((a, b) => score(a) - score(b));
  toolbar.style.transform = 'none'; toolbar.style.left = `${choices[0][0]}px`; toolbar.style.top = `${choices[0][1]}px`;
}
function clearWords() {
  renderEpoch++;
  surface.hidden = true;
  latestWords = null;
  hideCard(); payload = null; layer.replaceChildren();
  document.getElementById('frameStatus').textContent = '正在识别…';
}
const wordKey = w => JSON.stringify([w.text, Boolean(w.isPhrase), w.surfaceText || '', w.x, w.y, w.width, w.height]);
function overlapsAnchor(word, anchor) {
  const area = Math.max(0, Math.min(word.x + word.width, anchor.x + anchor.width) - Math.max(word.x, anchor.x))
    * Math.max(0, Math.min(word.y + word.height, anchor.y + anchor.height) - Math.max(word.y, anchor.y));
  return area / Math.max(1, Math.min(word.width * word.height, anchor.width * anchor.height)) >= .35;
}
function reconcileWords(words) {
  const protectedAnchor = !card.hidden && selected?.isConnected ? selected : null;
  const wanted = new Set(words.map(wordKey));
  const existing = new Map([...layer.children].map(b => [b.wordKey, b]));
  for (const [key, b] of existing) if (!wanted.has(key) && b !== protectedAnchor) b.remove();
  for (const word of words) {
    const key = wordKey(word);
    if (existing.has(key)) continue;
    // Keep the active word/card stable. Apply a conflicting correction when
    // that card closes or the user selects another word, never during IME.
    if (protectedAnchor && overlapsAnchor(word, protectedAnchor.ocrWord)) continue;
    const b = document.createElement('button');
    b.type = 'button'; b.wordKey = key; b.ocrWord = word;
    b.className = `word-box${word.isPhrase ? ' phrase-box' : ''}`;
    b.dataset.word = word.text;
    b.title = word.surfaceText && word.surfaceText !== word.text ? `${word.surfaceText} → ${word.text}` : word.text;
    b.setAttribute('aria-label', `查询 ${b.title}`);
    if (word.isPhrase) b.textContent = '词组';
    positionButton(b);
    b.addEventListener('click', () => selectWord(b, b.ocrWord));
    layer.append(b);
  }
}
async function renderWords(value) {
  if (!Number.isInteger(value?.requestId) || value.requestId < latestRequestId
    || !Number.isInteger(value.revision) || value.revision < 1 || typeof value.complete !== 'boolean') return;
  const newRequest = value.requestId > latestRequestId;
  if (!newRequest && (!payload || payload.complete || value.revision <= payload.revision)) return;
  if (![value.captureWidth, value.captureHeight].every(n => Number.isFinite(n) && n > 0) || !Array.isArray(value.words)
    || (!newRequest && (value.captureWidth !== payload.captureWidth || value.captureHeight !== payload.captureHeight))) {
    window.wordOverlay.wordsReady(value.requestId, value.revision, false);
    return;
  }
  if (newRequest) { latestRequestId = value.requestId; clearWords(); }
  const epoch = ++renderEpoch;
  payload = { requestId: value.requestId, revision: value.revision, captureWidth: value.captureWidth, captureHeight: value.captureHeight, complete: value.complete };
  latestWords = value.words;
  document.getElementById('cancelButton').textContent = value.bindingLabel === 'Esc' ? '退出 · Esc' : `退出 · ${value.bindingLabel || '取词键'} / Esc`;
  document.getElementById('frameStatus').textContent = value.complete
    ? (value.words.length ? '点击单词或词组' : '未识别到英文 · 按 Esc 退出') : '点击单词或词组 · 继续识别中…';
  reconcileWords(latestWords);
  surface.hidden = false;
  if (card.hidden) positionToolbar();
  // Wait through a layout/paint opportunity before exposing the reused window.
  // Hidden renderer throttling is disabled only for this overlay window.
  await new Promise(requestAnimationFrame);
  if (newRequest) await new Promise(requestAnimationFrame);
  if (epoch === renderEpoch && payload?.requestId === value.requestId) window.wordOverlay.wordsReady(value.requestId, value.revision, true);
}
function lookupEdited(event) {
  if (composing || event?.isComposing) return;
  clearTimeout(timer);
  edited = true;
  selectedWord = normalize(lookupWord.value);
  phonetic.textContent = '';
  formNote.hidden = true;
  if (selectedWord.length > 96 || !/^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*){0,5}$/.test(selectedWord)) {
    message('请输入英文单词或词组（最多 6 个单词，不含数字或句末标点）。');
    return;
  }
  message('正在查询本地词典…');
  timer = setTimeout(() => window.wordOverlay.lookup(selectedWord), 250);
}
lookupWord.addEventListener('input', lookupEdited);
lookupWord.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); });
lookupWord.addEventListener('compositionend', () => { composing = false; lookupEdited(); });
window.wordOverlay.onWords(renderWords);
window.wordOverlay.onClear(clearWords);
window.wordOverlay.onDefinition(renderDefinition);
window.addEventListener('resize', () => {
  for (const b of layer.children) positionButton(b);
  positionToolbar();
  positionCard();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !composing && !event.isComposing && event.keyCode !== 229) window.wordOverlay.cancel();
});
document.getElementById('cancelButton').addEventListener('click', () => window.wordOverlay.cancel());
document.getElementById('closeCardButton').addEventListener('click', hideCard);
