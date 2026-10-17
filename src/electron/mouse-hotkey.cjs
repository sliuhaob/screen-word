'use strict';
const path = require('node:path');
const { spawn } = require('node:child_process');
class MouseSideHotkey {
  constructor({ packaged, resourcesPath, appPath, onTrigger, onStatus = () => {} }) {
    this.executablePath = path.join(packaged ? resourcesPath : appPath, 'native/MouseSideHotkey.exe');
    this.onTrigger = onTrigger; this.onStatus = onStatus; this.child = null; this.buffer = ''; this.pending = null;
  }
  start(button = 'XBUTTON1') {
    this.stop();
    if (process.platform !== 'win32') return Promise.reject(new Error('仅支持 Windows'));
    if (!['XBUTTON1', 'XBUTTON2', 'MIDDLE'].includes(button)) return Promise.reject(new Error('不支持的鼠标键'));
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true; clearTimeout(timeout); this.pending = null;
        if (error) reject(error); else resolve(true);
      };
      const timeout = setTimeout(() => { finish(new Error('鼠标助手启动超时')); this.stop(); }, 4000);
      this.pending = finish;
      const child = spawn(this.executablePath, [String(process.pid), button], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      this.child = child; this.buffer = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (this.child === child) this.consume(chunk); });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (s) => { if (this.child === child && s.trim()) finish(new Error(s.trim())); });
      child.once('error', (error) => { if (this.child === child) finish(error); });
      child.once('exit', () => {
        if (this.child !== child) return;
        this.child = null; finish(new Error('鼠标助手已停止'));
        this.onStatus({ ready: false, message: '鼠标助手已停止，请重新启用取词' });
      });
    });
  }
  consume(chunk) {
    const lines = (this.buffer + chunk).split(/\r?\n/); this.buffer = lines.pop() || '';
    for (const line of lines) {
      if (line.trim() === 'READY') { this.pending?.(); this.onStatus({ ready: true }); }
      if (line.trim() === 'TRIGGER') this.onTrigger();
    }
  }
  stop() {
    const child = this.child; this.child = null;
    this.pending?.(new Error('鼠标助手启动已取消'));
    if (child && !child.killed) child.kill();
    this.buffer = ''; this.onStatus({ ready: false });
  }
}
module.exports = { MouseSideHotkey };
