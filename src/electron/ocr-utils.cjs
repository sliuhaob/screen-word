'use strict';

function cleanDetectedWord(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.normalize('NFKC').replace(/[’‘]/g, "'");
  const match = normalized.match(/[A-Za-z0-9]+(?:['-][A-Za-z0-9]+)*/);
  return match && !/\d/.test(match[0]) ? match[0].toLowerCase() : '';
}

function compoundComponents(item, text, confidence) {
  if (!text.includes('-') || !Array.isArray(item.symbols)) return [];
  const groups = [[]];
  for (const symbol of item.symbols) {
    if (symbol.text === '-') groups.push([]);
    else groups.at(-1).push(symbol);
  }
  const parts = groups.map(group => {
    const name = group.map(s => s.text).join('').replace(/^[^A-Za-z]+|[^A-Za-z]+$/g, '').toLowerCase();
    const boxes = group.map(s => normalizeBox(s.bbox)).filter(Boolean);
    if (!/^[a-z]+(?:'[a-z]+)*$/.test(name) || !boxes.length) return null;
    const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
    return { text: name, confidence, x, y,
      width: Math.max(...boxes.map(b => b.x + b.width)) - x,
      height: Math.max(...boxes.map(b => b.y + b.height)) - y };
  });
  return parts.every(Boolean) && parts.map(p => p.text).join('-') === text ? parts : [];
}

function expandCompoundWords(words, lookup) {
  return words.flatMap(word => {
    const { components, ...plain } = word;
    if (!components?.length || lookup(word.text)?.found) return [plain];
    return components.filter(p => p.text.length > 1 || p.text === 'a' || p.text === 'i')
      .map((part, index) => ({ ...part, lineId: `${word.lineId}:compound:${word.tokenIndex}:${index}`, tokenIndex: 0,
        breakAfter: true }));
  });
}

function normalizeBox(box) {
  if (!box || typeof box !== 'object') return null;
  const x0 = Number(box.x0);
  const y0 = Number(box.y0);
  const x1 = Number(box.x1);
  const y1 = Number(box.y1);
  if (![x0, y0, x1, y1].every(Number.isFinite) || x1 <= x0 || y1 <= y0) return null;
  return {
    x: Math.max(0, Math.round(x0)),
    y: Math.max(0, Math.round(y0)),
    width: Math.max(1, Math.round(x1 - x0)),
    height: Math.max(1, Math.round(y1 - y0)),
  };
}

// A punctuation mark can have a much larger box than the letters (outlined
// game captions in particular). Keep letter geometry for a targeted retry;
// symbol confidence is not used to bypass the word confidence threshold.
function letterBox(item, text) {
  if (!/^[a-z]+$/i.test(text) || !Array.isArray(item.symbols)) return null;
  const letters = item.symbols.filter(s => /^[a-z]$/i.test(s.text));
  if (letters.map(s => s.text).join('').toLowerCase() !== text) return null;
  const boxes = letters.map(s => normalizeBox(s.bbox));
  if (!boxes.length || boxes.some(b => !b)) return null;
  const x = Math.min(...boxes.map(b => b.x)), y = Math.min(...boxes.map(b => b.y));
  return { x, y, width: Math.max(...boxes.map(b => b.x + b.width)) - x,
    height: Math.max(...boxes.map(b => b.y + b.height)) - y };
}

function extractWordsFromBlocks(blocks, minimumConfidence = 45) {
  const results = [];
  if (!Array.isArray(blocks)) return results;

  for (const [blockIndex, block] of blocks.entries()) {
    for (const [paragraphIndex, paragraph] of (block?.paragraphs || []).entries()) {
      for (const [lineIndex, line] of (paragraph?.lines || []).entries()) {
        for (const [tokenIndex, item] of (line?.words || []).entries()) {
          const text = cleanDetectedWord(item?.text);
          const confidence = Number(item?.confidence ?? item?.conf ?? 0);
          const box = normalizeBox(item?.bbox);
          const validSingleLetter = text === 'a' || text === 'i';
          if (!text || (text.length < 2 && !validSingleLetter) || !box || confidence < minimumConfidence) continue;
          results.push({
            text,
            confidence: Math.round(confidence),
            ...box,
            textBox: letterBox(item, text),
            lineId: `${blockIndex}:${paragraphIndex}:${lineIndex}`,
            tokenIndex,
            breakAfter: /[.,;:!?][”"')\]]*$/.test(String(item?.text || '').trim()),
            components: compoundComponents(item, text, Math.round(confidence)),
          });
        }
      }
    }
  }

  return results.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 900);
}

module.exports = { cleanDetectedWord, extractWordsFromBlocks, normalizeBox, expandCompoundWords, compoundComponents };
