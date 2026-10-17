'use strict';
const api = window.screenCapture;
const $ = (id) => document.getElementById(id);
const toggleButton = $('toggleButton'), status = $('status'), bindingType = $('bindingType');
const keyDisplay = $('keyDisplay'), recordKey = $('recordKey'), saveButton = $('saveBinding');
const bindingMessage = $('bindingMessage'), searchInput = $('searchInput'), suggestions = $('suggestions'), resultBox = $('searchResult');
let loaded = false, recording = false, accelerator = '', currentLabel = '', composing = false;
let suggestTimer = null, suggestSerial = 0, searchSerial = 0, options = [], active = -1;
let fitTimer = null;
function fitContent() {
  clearTimeout(fitTimer);
  fitTimer = setTimeout(() => {
    let height = Math.ceil(document.querySelector('main').getBoundingClientRect().height);
    if (!suggestions.hidden) height = Math.max(height, Math.ceil(suggestions.getBoundingClientRect().bottom + scrollY + 18));
    api.fitContent(height);
  }, 50);
}
const layoutObserver = new ResizeObserver(fitContent);
layoutObserver.observe(document.querySelector('main'));
layoutObserver.observe(suggestions);
function render(state) {
  if (!state) return;
  toggleButton.textContent = state.monitoring ? '暂停取词' : '启用取词';
  toggleButton.classList.toggle('active', Boolean(state.monitoring));
  toggleButton.setAttribute('aria-pressed', String(Boolean(state.monitoring)));
  status.textContent = state.message;
  currentLabel = state.bindingLabel || '鼠标后退侧键';
  if (!loaded) {
    const binding = state.binding || { type: 'mouse', button: 'XBUTTON1' };
    bindingType.value = binding.type === 'mouse' ? binding.button : 'keyboard';
    accelerator = binding.accelerator || ''; keyDisplay.value = accelerator.replace('Control', 'Ctrl').replace('Super', 'Win');
    $('keyboardControls').hidden = bindingType.value !== 'keyboard';
    bindingMessage.textContent = `当前：${currentLabel}`; loaded = true;
  }
  if (recording && !state.capturingKey) { stopRecordUi(); hint('录入已结束，可以重新录入或保存已选按键'); }
}
function hint(text, error = false) { bindingMessage.textContent = text; bindingMessage.classList.toggle('error', error); }
function stopRecordUi() {
  recording = false; recordKey.textContent = '录入按键'; toggleButton.disabled = false; saveButton.disabled = false; bindingType.disabled = false;
}
async function endRecording() { stopRecordUi(); await api.endKeyCapture(); }
api.onState(render);
api.getState().then((state) => { render(state); toggleButton.disabled = false; saveButton.disabled = false; }).catch(() => { status.textContent = '服务启动失败，请重启应用'; });
toggleButton.addEventListener('click', async () => {
  toggleButton.disabled = true;
  try { const state = await api.toggle(); render(state); if (!state.ok) status.textContent = state.error || state.message; }
  catch (error) { status.textContent = error.message; }
  finally { toggleButton.disabled = false; }
});
bindingType.addEventListener('change', () => { $('keyboardControls').hidden = bindingType.value !== 'keyboard'; hint(`当前：${currentLabel} · 修改后点击保存绑定`); });
recordKey.addEventListener('click', async () => {
  if (recording) { await endRecording(); hint('已取消录入'); return; }
  recordKey.disabled = true;
  try {
    const response = await api.beginKeyCapture();
    if (!response.ok) throw new Error('无法开始录入');
    recording = true; recordKey.textContent = '取消录入'; recordKey.focus(); toggleButton.disabled = true; saveButton.disabled = true; bindingType.disabled = true;
    hint('请按 F1–F24 或 Ctrl / Alt 组合键；Esc 取消（30 秒内）');
  } catch (error) { hint(error.message, true); }
  finally { recordKey.disabled = false; }
});
window.addEventListener('keydown', async (event) => {
  if (!recording) return;
  event.preventDefault(); event.stopImmediatePropagation();
  if (event.key === 'Escape') { await endRecording(); hint('已取消录入'); return; }
  if (event.repeat || event.isComposing || ['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return;
  let key = event.code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '');
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/.test(key)) { hint('请换成功能键或 Ctrl / Alt 组合键', true); return; }
  if ((!/^F\d+$/.test(key) && !event.ctrlKey && !event.altKey && !event.metaKey) || (key === 'F4' && event.altKey)) { hint('请使用 F1–F24 或 Ctrl / Alt 组合键，避免占用日常打字', true); return; }
  accelerator = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Super', key].filter(Boolean).join('+');
  keyDisplay.value = accelerator.replace('Control', 'Ctrl').replace('Super', 'Win');
  await endRecording(); hint(`已录入 ${keyDisplay.value}，点击保存绑定生效`);
}, true);
saveButton.addEventListener('click', async () => {
  saveButton.disabled = true;
  try {
    const binding = bindingType.value === 'keyboard' ? { type: 'keyboard', accelerator } : { type: 'mouse', button: bindingType.value };
    const response = await api.saveBinding(binding);
    render(response);
    hint(response.ok ? `已保存：${response.bindingLabel} · 下次启动自动沿用` : `${response.error}；当前仍使用 ${response.bindingLabel}`, !response.ok);
  } catch (error) { hint(error.message, true); }
  finally { saveButton.disabled = false; }
});

function hideSuggestions() { suggestions.hidden = true; searchInput.setAttribute('aria-expanded', 'false'); searchInput.removeAttribute('aria-activedescendant'); options = []; active = -1; fitContent(); }
function showSuggestions(words) {
  suggestions.replaceChildren(); options = words; active = -1;
  words.forEach((word, index) => {
    const li = document.createElement('li'); li.textContent = word; li.role = 'option'; li.id = `suggestion-${index}`; li.setAttribute('aria-selected', 'false');
    li.addEventListener('mousedown', (event) => event.preventDefault());
    li.addEventListener('click', () => { searchInput.value = word; void search(word); });
    suggestions.append(li);
  });
  suggestions.hidden = !words.length; searchInput.setAttribute('aria-expanded', String(Boolean(words.length)));
  fitContent();
}
function onInput() {
  clearTimeout(suggestTimer); const serial = ++suggestSerial; ++searchSerial;
  hideSuggestions();
  if (!searchInput.value.trim()) { resultBox.hidden = true; resultBox.replaceChildren(); fitContent(); return; }
  if (composing) return;
  suggestTimer = setTimeout(async () => {
    try { const response = await api.suggest(searchInput.value); if (serial === suggestSerial) { showSuggestions(response.words || []); if (response.error) showMessage(response.error); } }
    catch { if (serial === suggestSerial) showMessage('词库服务暂时不可用，请重启应用'); }
  }, 140);
}
function showMessage(text) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = text; resultBox.replaceChildren(p); resultBox.hidden = false; }
function showDefinition(result) {
  if (!result.found) { showMessage(result.error ? '本地词典暂时不可用，请重启应用。' : '没有查到这个词，请检查拼写或选择匹配词。'); return; }
  const title = document.createElement('h3'), ipa = document.createElement('div'), note = document.createElement('p'), choices = document.createElement('div'), list = document.createElement('ol');
  ipa.className = 'phonetic'; note.className = 'form-note'; choices.className = 'choices'; list.className = 'meanings';
  resultBox.replaceChildren(title, ipa, note, choices, list);
  resultBox.hidden = false;
  const entries = result.entries?.length ? result.entries : [result];
  function choose(entry) {
    title.textContent = entry.headword; ipa.textContent = entry.phonetic ? `/${entry.phonetic}/` : ''; ipa.hidden = !entry.phonetic;
    note.textContent = entry.formNote || (result.word !== entry.headword ? `输入词形：${result.word} → 原形：${entry.headword}` : ''); note.hidden = !note.textContent;
    for (const b of choices.children) b.setAttribute('aria-pressed', String(b.dataset.word === entry.headword));
    list.replaceChildren();
    for (const text of entry.translations || []) { const li = document.createElement('li'); li.textContent = text.replace(/^a\.\s*/i, 'adj. '); list.append(li); }
  }
  choices.hidden = entries.length < 2;
  if (entries.length > 1) for (const entry of entries) {
    const b = document.createElement('button'); b.type = 'button'; b.dataset.word = entry.headword; b.textContent = `${entry.isInflection ? '动词原形' : '原词形'} ${entry.headword}`;
    b.addEventListener('click', () => choose(entry)); choices.append(b);
  }
  choose(result.ambiguous ? entries[0] : entries.find((e) => e.headword === result.headword) || entries[0]);
}
async function search(word) {
  clearTimeout(suggestTimer); ++suggestSerial; hideSuggestions();
  const serial = ++searchSerial;
  if (!word.trim()) { resultBox.hidden = true; resultBox.replaceChildren(); searchInput.focus(); fitContent(); return; }
  showMessage('正在查询…');
  try { const response = await api.search(word); if (serial === searchSerial) showDefinition(response); }
  catch { if (serial === searchSerial) showMessage('查询失败，请重试。'); }
}
searchInput.addEventListener('input', onInput);
searchInput.addEventListener('compositionstart', () => { composing = true; clearTimeout(suggestTimer); ++suggestSerial; hideSuggestions(); });
searchInput.addEventListener('compositionend', () => { composing = false; onInput(); });
searchInput.addEventListener('keydown', (event) => {
  if (event.isComposing || composing || event.keyCode === 229) return;
  if (event.key === 'Escape') { ++suggestSerial; clearTimeout(suggestTimer); hideSuggestions(); }
  if (options.length && ['ArrowDown', 'ArrowUp'].includes(event.key)) {
    event.preventDefault(); active = (active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    [...suggestions.children].forEach((li, i) => li.setAttribute('aria-selected', String(i === active)));
    searchInput.setAttribute('aria-activedescendant', `suggestion-${active}`); suggestions.children[active].scrollIntoView({ block: 'nearest' });
  }
});
$('searchForm').addEventListener('submit', (event) => { event.preventDefault(); if (composing) return; const word = active >= 0 ? options[active] : searchInput.value; searchInput.value = word; void search(word); });
document.addEventListener('click', (event) => { if (!event.target.closest('.search-controls')) { ++suggestSerial; clearTimeout(suggestTimer); hideSuggestions(); } });
