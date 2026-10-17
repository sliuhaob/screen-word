'use strict';
const fs = require('node:fs');
const path = require('node:path');
const DEFAULT_BINDING = Object.freeze({ type: 'mouse', button: 'XBUTTON1' });
const MOUSE_LABELS = { XBUTTON1: '鼠标后退侧键', XBUTTON2: '鼠标前进侧键', MIDDLE: '鼠标中键' };
function normalizeBinding(value) {
  if (value?.type === 'mouse' && Object.hasOwn(MOUSE_LABELS, value.button)) return { type: 'mouse', button: value.button };
  if (value?.type !== 'keyboard' || typeof value.accelerator !== 'string') throw new Error('请选择鼠标键或录入键盘快捷键');
  const parts = value.accelerator.split('+');
  const key = parts.pop();
  const modifiers = ['Control', 'Alt', 'Shift', 'Super'];
  if (new Set(parts).size !== parts.length || parts.some((p) => !modifiers.includes(p))) throw new Error('快捷键格式不正确');
  if (!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Enter|Tab|Backspace|Delete|Insert|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/.test(key || '')) throw new Error('不支持这个键，请使用功能键或组合键');
  if (!/^F\d+$/.test(key) && !parts.some((p) => ['Control', 'Alt', 'Super'].includes(p))) throw new Error('字母或普通按键请搭配 Ctrl 或 Alt；F1–F24 可单独使用');
  if (key === 'F4' && parts.includes('Alt')) throw new Error('Alt+F4 用于关闭窗口，请换一个快捷键');
  return { type: 'keyboard', accelerator: [...modifiers.filter((p) => parts.includes(p)), key].join('+') };
}
function bindingLabel(binding) {
  return binding.type === 'mouse' ? MOUSE_LABELS[binding.button] : binding.accelerator.replace('Control', 'Ctrl').replace('Super', 'Win');
}
function readBinding(file) {
  try { return normalizeBinding(JSON.parse(fs.readFileSync(file, 'utf8')).binding); }
  catch { return { ...DEFAULT_BINDING }; }
}
function writeBinding(file, binding) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ version: 1, binding: normalizeBinding(binding) }, null, 2) + '\n');
  fs.renameSync(temp, file);
}
class HotkeyManager {
  constructor({ keyboard, mouse, binding, persist, onTrigger }) {
    Object.assign(this, { keyboard, mouse, persist, onTrigger });
    this.binding = normalizeBinding(binding); this.live = false; this.suspended = false; this.registered = null;
  }
  uninstall() {
    if (this.registered) this.keyboard.unregister(this.registered);
    this.registered = null; this.mouse.stop();
  }
  async install(binding) {
    this.uninstall();
    if (binding.type === 'mouse') { await this.mouse.start(binding.button); return; }
    if (!this.keyboard.register(binding.accelerator, () => { if (this.live && !this.suspended) this.onTrigger(); })) throw new Error('这个快捷键已被占用或被系统保留，请换一个');
    this.registered = binding.accelerator;
  }
  async start() {
    try { if (!this.suspended) await this.install(this.binding); this.live = true; }
    catch (error) { this.uninstall(); this.live = false; throw error; }
  }
  stop() { this.live = false; this.uninstall(); }
  suspend() { this.suspended = true; this.uninstall(); }
  async resume() { this.suspended = false; if (this.live) await this.install(this.binding); }
  async setBinding(raw) {
    const next = normalizeBinding(raw), previous = this.binding;
    try {
      await this.install(next);
      this.persist(next);
      this.binding = next;
      if (!this.live || this.suspended) this.uninstall();
    } catch (error) {
      this.uninstall(); this.binding = previous;
      if (this.live && !this.suspended) {
        try { await this.install(previous); } catch { this.live = false; }
      }
      throw error;
    }
    return this.binding;
  }
}
module.exports = { DEFAULT_BINDING, normalizeBinding, bindingLabel, readBinding, writeBinding, HotkeyManager };
