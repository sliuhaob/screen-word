'use strict';

// Conservative separable constructions, not arbitrary verb/preposition pairs.
const SEPARABLE = new Set(['tip off', 'give up', 'take off', 'turn on', 'turn off',
  'put on', 'put off', 'put away', 'put down', 'pick up', 'bring up', 'bring back',
  'hand in', 'hand out', 'call off', 'call back', 'let down', 'leave out', 'set up',
  'work out', 'find out', 'figure out', 'point out', 'throw away', 'throw out',
  'fill in', 'fill out', 'take back', 'cut off', 'cut out', 'break up', 'break down', 'saw off']);
const OBJECT_PRONOUNS = new Set(['me', 'you', 'him', 'her', 'it', 'us', 'them', 'someone', 'somebody', 'something']);
function isSimpleObject(segment, lookup) {
  const tokens = segment.map((word) => word.text.toLowerCase());
  if (tokens.length === 1) return OBJECT_PRONOUNS.has(tokens[0]);
  if (tokens.length > 3 || !/^(the|a|an|my|your|his|her|its|our|their|this|that|these|those)$/.test(tokens[0])) return false;
  const hasPos = (word, pattern) => {
    const result = lookup(word);
    return (result.entries || [result]).some((entry) => entry.translations?.some((text) => pattern.test(text)));
  };
  return hasPos(tokens.at(-1), /^n\./i) && (tokens.length === 2 || hasPos(tokens[1], /^(adj|a)\./i));
}

function wordsAreAdjacent(left, right) {
  if (!left || !right || left.lineId !== right.lineId || left.breakAfter) return false;
  if (Number.isInteger(left.tokenIndex) && Number.isInteger(right.tokenIndex)
      && right.tokenIndex !== left.tokenIndex + 1) return false;
  const horizontalGap = right.x - (left.x + left.width);
  const maximumGap = Math.max(34, Math.max(left.height, right.height) * 2.2);
  const verticalDifference = Math.abs(
    (left.y + left.height / 2) - (right.y + right.height / 2),
  );
  return horizontalGap >= -Math.min(left.width, right.width) * 0.2
    && horizontalGap <= maximumGap
    && verticalDifference <= Math.max(left.height, right.height) * 0.65;
}

function mergeSegment(segment, text) {
  const x0 = Math.min(...segment.map((word) => word.x));
  const y0 = Math.min(...segment.map((word) => word.y));
  const x1 = Math.max(...segment.map((word) => word.x + word.width));
  const y1 = Math.max(...segment.map((word) => word.y + word.height));
  return {
    text,
    surfaceText: segment.map((word) => word.text).join(' '),
    confidence: Math.min(...segment.map((word) => word.confidence)),
    x: x0,
    y: y0,
    width: x1 - x0,
    height: y1 - y0,
    lineId: segment[0].lineId,
    tokenIndex: segment[0].tokenIndex,
    breakAfter: segment.at(-1).breakAfter,
    isPhrase: true,
    wordCount: segment.length,
  };
}

function detectDictionaryPhrases(words, lookup, maximumWords = 5, options = {}) {
  if (!Array.isArray(words) || typeof lookup !== 'function') return [];
  const preserveWords = Boolean(options.preserveWords);
  const lines = new Map();
  for (const word of words) {
    const key = word.lineId || `fallback:${Math.round(word.y / Math.max(1, word.height))}`;
    if (!lines.has(key)) lines.set(key, []);
    lines.get(key).push(word);
  }

  const output = [];
  for (const lineWords of lines.values()) {
    lineWords.sort((a, b) => a.tokenIndex - b.tokenIndex || a.x - b.x);
    for (let start = 0; start < lineWords.length - 2; start += 1) {
      for (let end = start + 2; end <= Math.min(start + 4, lineWords.length - 1); end += 1) {
        const segment = lineWords.slice(start, end + 1);
        if (!segment.slice(1).every((word, offset) => wordsAreAdjacent(segment[offset], word))) continue;
        if (!isSimpleObject(segment.slice(1, -1), lookup)) continue;
        const verb = lookup(segment[0].text);
        const candidates = new Set([segment[0].text, ...(verb.entries || [verb]).map((entry) => entry.headword)]);
        const definition = [...candidates].filter(Boolean)
          .map((headword) => `${headword} ${segment.at(-1).text}`)
          .filter((phrase) => SEPARABLE.has(phrase))
          .map(lookup).find((entry) => entry?.found);
        if (!definition) continue;
        output.push({ ...mergeSegment(segment, definition.headword), isSeparable: true });
      }
    }
    for (let index = 0; index < lineWords.length;) {
      let best = null;
      const longest = Math.min(maximumWords, lineWords.length - index);
      for (let length = longest; length >= 2; length -= 1) {
        const segment = lineWords.slice(index, index + length);
        if (!segment.slice(1).every((word, offset) => wordsAreAdjacent(segment[offset], word))) continue;
        const phrase = segment.map((word) => word.text).join(' ');
        const definition = lookup(phrase);
        if (definition?.found) {
          best = mergeSegment(segment, definition.isInflection ? definition.headword : phrase);
          break;
        }
      }
      if (best) {
        if (preserveWords) output.push(...lineWords.slice(index, index + best.wordCount));
        output.push(best);
        index += best.wordCount;
      } else {
        output.push(lineWords[index]);
        index += 1;
      }
    }
  }

  return output.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, 900);
}

module.exports = { detectDictionaryPhrases, wordsAreAdjacent };
