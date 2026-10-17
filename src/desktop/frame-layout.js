'use strict';
function frameLayout(frameWidth, frameHeight, viewWidth, viewHeight) {
  // The capture covers one full monitor. Map its pixel axes back to the
  // monitor's DIP viewport; there is no displayed image to letterbox.
  return { scaleX: viewWidth / Math.max(1, frameWidth), scaleY: viewHeight / Math.max(1, frameHeight),
    left: 0, top: 0, width: viewWidth, height: viewHeight };
}
if (typeof module !== 'undefined') module.exports = { frameLayout };
