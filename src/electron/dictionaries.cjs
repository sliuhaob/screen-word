'use strict';

function normalizeWord(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFKC')
    .replace(/[’‘]/g, "'")
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isValidWord(value) {
  const word = normalizeWord(value);
  return word.length >= 1
    && word.length <= 64
    && /^[a-z]+(?:['-][a-z]+)*$/.test(word);
}

function isValidLookupTerm(value) {
  const term = normalizeWord(value);
  return term.length >= 1
    && term.length <= 96
    && /^[a-z]+(?:['-][a-z]+)*(?: [a-z]+(?:['-][a-z]+)*){0,5}$/.test(term);
}

module.exports = { isValidLookupTerm, isValidWord, normalizeWord };
