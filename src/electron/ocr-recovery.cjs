'use strict';
const { overlap } = require('./ocr-merge.cjs');
const MAX_RETRIES = 6;
const sameRegion = (a, b) => overlap(a, b).coverage >= .8
  && Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < Math.max(a.height, b.height) * .3;
const valid = w => w && /^[a-z]{3,32}$/i.test(w.text)
  && ['x', 'y', 'width', 'height', 'confidence'].every(k => Number.isFinite(w[k]))
  && w.width > 0 && w.height >= 12;

function planRecovery(primary, supplement, merged, isKnownWord) {
  if (!isKnownWord) return [];
  const planned = [];
  for (const [lane, other] of [[primary, supplement], [supplement, primary]]) {
    for (const word of lane) {
      if (!valid(word) || merged.some(w => w.text === word.text && sameRegion(w, word))) continue;
      if (planned.some(w => w.text === word.text && sameRegion(w, word))) continue;
      // Only retry low-confidence letters when the independent full-frame pass
      // read the same word. Dictionary membership alone is not visual evidence.
      const agreement = word.confidence < 60 && other.some(w => valid(w) && w.text === word.text && sameRegion(w, word));
      const conflicts = merged.filter(w => overlap(w, word).coverage >= .75);
      // A complete, confident word may lose to one surviving suffix fragment.
      // Re-read the actual pixels before overriding the old merge decision.
      const fragmentConflict = word.confidence >= 80 && conflicts.length > 0 && conflicts.length <= 4
        && conflicts.every(w => sameRegion(w, word) && w.text.length < word.text.length
          && word.text.includes(w.text) && w.width < word.width * .9)
        && !(conflicts.length > 1 && conflicts.every(w => isKnownWord(w.text)));
      if ((!agreement && !fragmentConflict) || !isKnownWord(word.text)) continue;
      planned.push({ ...word, recoveryKind: agreement ? 'low-confidence-agreement' : 'fragment-conflict' });
    }
  }
  return planned.sort((a, b) => (a.recoveryKind === 'fragment-conflict') - (b.recoveryKind === 'fragment-conflict')
    || a.y - b.y || a.x - b.x).slice(0, MAX_RETRIES);
}

function acceptRecovery(candidate, crop, result) {
  // Require an exact, high-confidence re-read. Never silently spell-correct or
  // join two words such as "in side" just because "inside" exists in the lexicon.
  const tokens = result.candidates || result.words || [];
  if (tokens.length !== 1 || tokens[0].text !== candidate.text || tokens[0].confidence < 70) return null;
  const word = tokens[0], box = word.textBox || word;
  if (![box.x, box.y, box.width, box.height].every(Number.isFinite) || box.width <= 0 || box.height <= 0
    || box.x < 0 || box.y < 0 || box.x + box.width > crop.width + 1 || box.y + box.height > crop.height + 1) return null;
  const restored = { ...candidate, x: crop.x + box.x, y: crop.y + box.y, width: box.width, height: box.height,
    confidence: word.confidence, textBox: null, components: [], breakAfter: candidate.breakAfter || word.breakAfter };
  delete restored.recoveryKind;
  return sameRegion(restored, candidate) ? restored : null;
}
module.exports = { planRecovery, acceptRecovery, MAX_RETRIES };
