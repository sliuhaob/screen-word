'use strict';
function overlap(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const area = width * height, aa = a.width * a.height, bb = b.width * b.height;
  return { iou: area / Math.max(1, aa + bb - area), coverage: area / Math.max(1, Math.min(aa, bb)) };
}
function validWord(w) {
  return w && typeof w.text === 'string' && w.text.length > 0
    && ['x', 'y', 'width', 'height', 'confidence'].every(k => Number.isFinite(w[k]))
    && w.width > 0 && w.height > 0;
}
// Independent OCR passes use unrelated line IDs. Rebuild spatial lines without
// allowing distant UI columns or rejected original tokens to form phrases.
function rebuildLines(words) {
  const lines = [];
  for (const word of words.slice().sort((a, b) => a.y + a.height / 2 - b.y - b.height / 2 || a.x - b.x)) {
    const center = word.y + word.height / 2;
    let best = null, distance = Infinity;
    for (const line of lines) {
      const delta = Math.abs(center - line.center);
      if (delta <= Math.min(line.height, word.height) * 0.5 && delta < distance) { best = line; distance = delta; }
    }
    if (!best) { best = { words: [], center, height: word.height }; lines.push(best); }
    best.words.push(word);
    best.center = best.words.reduce((n, w) => n + w.y + w.height / 2, 0) / best.words.length;
    best.height = Math.min(best.height, word.height);
  }
  const output = [];
  let id = 0;
  for (const line of lines) {
    let previous = null, index = 0;
    id++;
    for (const word of line.words.sort((a, b) => a.x - b.x)) {
      const missingToken = previous && previous.pass === word.pass && previous.lineId === word.lineId
        && word.tokenIndex > previous.tokenIndex + 1;
      const gap = previous ? word.x - previous.x - previous.width : 0;
      if (previous && (missingToken || gap > Math.max(34, Math.max(previous.height, word.height) * 2.2))) { id++; index = 0; }
      const { pass, ...clean } = word;
      output.push({ ...clean, lineId: `merged:${id}`, tokenIndex: index++ });
      previous = word;
    }
  }
  return output.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 900);
}
function supportedWhole(whole, candidates, isKnownWord) {
  if (!isKnownWord || whole.confidence < 70 || !/^[a-z]+$/i.test(whole.text)) return false;
  const parts = candidates.filter(w => w.pass !== whole.pass && w.text.length < whole.text.length
    && overlap(w, whole).coverage >= 0.85 && w.width < whole.width * 0.95
    && Math.abs(w.y + w.height / 2 - whole.y - whole.height / 2) < whole.height * 0.25)
    .sort((a, b) => a.x - b.x);
  if (parts.length < 2 || parts.length > 5 || parts.map(w => w.text).join('').toLowerCase() !== whole.text.toLowerCase()) return false;
  if (!isKnownWord(whole.text)) return false;
  // Do not turn real adjacent words (e.g. in side / a very) into a compound.
  if (parts.every(w => isKnownWord(w.text))) return false;
  const charWidth = whole.width / whole.text.length;
  if (Math.abs(parts[0].x - whole.x) > charWidth || Math.abs(parts.at(-1).x + parts.at(-1).width - whole.x - whole.width) > charWidth) return false;
  return parts.every((part, i) => !i || (part.x - parts[i - 1].x - parts[i - 1].width >= -charWidth * 0.25
    && part.x - parts[i - 1].x - parts[i - 1].width <= Math.max(3, charWidth * 0.5)));
}
function mergeOcrWords(primary, supplement, { isKnownWord, verifiedWords = [] } = {}) {
  const candidates = [
    ...(primary || []).filter(validWord).map(w => ({ ...w, pass: 'original', score: w.confidence + 8 })),
    ...(supplement || []).filter(w => validWord(w) && w.confidence >= (w.height >= 28 ? 35 : 60))
      .map(w => ({ ...w, pass: 'enhanced', score: w.confidence })),
    ...verifiedWords.filter(w => validWord(w) && w.confidence >= 70)
      .map(w => ({ ...w, pass: 'verified', score: w.confidence })),
  ];
  for (const word of candidates) word.wholeEvidence = supportedWhole(word, candidates, isKnownWord);
  candidates.sort((a, b) => Number(b.pass === 'verified') - Number(a.pass === 'verified')
    || Number(b.wholeEvidence) - Number(a.wholeEvidence) || b.score - a.score || b.width * b.height - a.width * a.height);
  const kept = [];
  for (const candidate of candidates) {
    if (kept.some(existing => {
      const { iou, coverage } = overlap(existing, candidate);
      return iou >= 0.35 || coverage >= 0.75;
    })) continue;
    const { score, wholeEvidence, ...word } = candidate;
    kept.push(word);
  }
  return rebuildLines(kept);
}
module.exports = { mergeOcrWords, rebuildLines, overlap };
