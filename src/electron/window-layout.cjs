'use strict';
// Renderer measurements are CSS pixels; Electron bounds use matching DIP units.
function fitWindowToContent(window, screen, contentHeight) {
  if (!window || window.isDestroyed() || typeof contentHeight !== 'number' ||
      !Number.isFinite(contentHeight) || contentHeight <= 0 || contentHeight > 100000) return;
  if (window.isMaximized() || window.isFullScreen() || window.isMinimized()) return;
  const bounds = window.getBounds(), content = window.getContentBounds();
  const area = screen.getDisplayMatching(bounds).workArea;
  const maximum = Math.max(1, area.height - 24);
  const height = Math.min(maximum, Math.max(Math.min(280, maximum), Math.ceil(contentHeight + bounds.height - content.height)));
  const y = Math.max(area.y + 12, Math.min(bounds.y, area.y + area.height - height - 12));
  if (Math.abs(bounds.height - height) > 1 || Math.abs(bounds.y - y) > 1) window.setBounds({ ...bounds, y, height });
}
module.exports = { fitWindowToContent };
