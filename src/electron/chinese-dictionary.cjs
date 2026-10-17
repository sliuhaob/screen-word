'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');
const { normalizeWord, isValidLookupTerm } = require('./dictionaries.cjs');

function normalizePhonetic(value) {
  if (typeof value !== 'string') return '';
  let phonetic = value
    .normalize('NFKC')
    .trim()
    .replace(/^[\s/\[\]]+|[\s/\[\]]+$/g, '')
    .replace(/[әǝ]/g, 'ə')
    .replace(/[εє]/g, 'ɛ')
    .replace(/:/g, 'ː')
    .replace(/'/g, 'ˈ')
    .replace(/[.,]/g, 'ˌ')
    .replace(/\s+/g, ' ')
    .trim();
  if (phonetic.length > 80 || /[�\u0000-\u001f]/.test(phonetic)) phonetic = '';
  return phonetic;
}

function splitTranslations(value) {
  if (typeof value !== 'string') return [];
  return value
    .replace(/\\n/g, '\n')
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .flatMap((line) => line.split(/\s+(?=(?:abbr|pron|prep|conj|adv|adj|vt|vi|num|int|art|pl|n|v|a)\.\s)/gi))
    .map((line) => line.trim())
    .filter(Boolean);
}

const isVerbLine = (line) => /^(?:\[[^\]]+\]\s*)*(?:v|vt|vi)\./i.test(line);
function isVerbEntry(row) { return splitTranslations(row?.translation).some(isVerbLine); }

class ChineseDictionary {
  constructor({ packaged, resourcesPath, appPath, dictionaryPath }) {
    this.databasePath = dictionaryPath || (packaged
      ? path.join(resourcesPath, 'dictionary', 'ecdict.sqlite')
      : path.join(appPath, 'resources', 'ecdict.sqlite'));
    this.database = null;
    this.directStatement = null;
    this.aliasStatement = null;
    this.lookupCache = new Map();
    this.inflectionsPath = path.join(path.dirname(this.databasePath), 'verb-inflections.json');
    this.inflections = {};
  }

  open() {
    if (this.database) return;
    this.database = new DatabaseSync(this.databasePath, { readOnly: true });
    this.database.exec('PRAGMA query_only = ON');
    if (fs.existsSync(this.inflectionsPath)) this.inflections = JSON.parse(fs.readFileSync(this.inflectionsPath, 'utf8')).forms || {};
    this.directStatement = this.database.prepare(`
      SELECT word, phonetic, translation
      FROM entries
      WHERE word = ? COLLATE NOCASE
      LIMIT 1
    `);
    this.aliasStatement = this.database.prepare(`
      SELECT entries.word, entries.phonetic, entries.translation
      FROM aliases
      JOIN entries ON entries.word = aliases.target COLLATE NOCASE
      WHERE aliases.alias = ? COLLATE NOCASE
      LIMIT 1
    `);
  }

  resolveEntry(word) {
    const parts = word.split(' ');
    const exact = this.directStatement.get(word);
    // Keep established phrases such as "saw off" and "fed up" intact.
    // Their first word can also be an inflection of a different verb.
    const explicitlyInflected = /过去式|过去分词|现在分词|第三人称单数/.test(exact?.translation || '');
    if (parts.length > 1 && exact && !explicitlyInflected) return { row: exact, isInflection: false };
    // The offline aliases table contains dictionary-supplied inflections,
    // including doubled consonants and irregular past/participle forms.
    // Only use a mapping as a verb lemma when its target has a verb entry.
    const verb = this.aliasStatement.get(parts[0]);
    if (isVerbEntry(verb) && normalizeWord(verb.word) !== parts[0]) {
      const lemma = [normalizeWord(verb.word), ...parts.slice(1)].join(' ');
      const row = parts.length === 1 ? verb : this.directStatement.get(lemma);
      if (row) return { row, isInflection: true };
    }
    const row = exact || this.aliasStatement.get(word);
    return { row, isInflection: false };
  }

  suggest(value, limit = 12) {
    const prefix = normalizeWord(value);
    if (!prefix || prefix.length > 96 || !/[a-z]/.test(prefix) || /[\u0000-\u001f]/.test(prefix)) return [];
    this.open();
    return this.database.prepare('SELECT word FROM entries WHERE word >= ? COLLATE NOCASE AND word < ? COLLATE NOCASE ORDER BY word COLLATE NOCASE LIMIT ?')
      .all(prefix, prefix + '\uffff', Math.max(1, Math.min(20, Number(limit) || 12))).map((row) => row.word);
  }

  lookup(value, { manual = false } = {}) {
    const word = normalizeWord(value);
    const valid = manual ? word.length <= 200 && /[a-z]/.test(word) && !/[\u0000-\u001f]/.test(word) : isValidLookupTerm(word);
    if (!valid) return { found: false, word };
    if (this.lookupCache.has(word)) return this.lookupCache.get(word);
    try {
      this.open();
      const { row, isInflection } = this.resolveEntry(word);
      const translations = splitTranslations(row?.translation);
      if (!row || translations.length === 0) return this.cacheResult(word, { found: false, word });
      if (isInflection && !word.includes(' ')) {
        translations.sort((a, b) => Number(/^(?:v|vt|vi)\./i.test(b)) - Number(/^(?:v|vt|vi)\./i.test(a)));
      }
      const headword = normalizeWord(row.word || word);
      let phonetic = normalizePhonetic(row.phonetic);
      if (!phonetic && headword.includes(' ')) {
        const parts = headword.split(' ')
          .map((part) => normalizePhonetic(this.directStatement.get(part)?.phonetic));
        if (parts.every(Boolean)) phonetic = parts.join(' ');
      }
      const entries = [{ headword, isInflection, phonetic, translations }];
      const exact = this.directStatement.get(word);
      if (exact && normalizeWord(exact.word) !== headword) {
        entries.unshift({ headword: normalizeWord(exact.word), isInflection: false,
          phonetic: normalizePhonetic(exact.phonetic), translations: splitTranslations(exact.translation) });
      }
      // Always offer the observed form beside its lemma, including alias-only
      // forms. A virtual form reuses verb senses and does not invent an IPA.
      const records = this.inflections[word] || this.inflections[word.split(' ')[0]] || [];
      const formTypes = new Set(records.flatMap((item) => item.types));
      const description = formTypes.has('i') ? '现在分词' : formTypes.has('p') && formTypes.has('d') ? '过去式和过去分词'
        : formTypes.has('d') ? '过去分词' : formTypes.has('p') ? '过去式' : /ing(?: |$)/.test(word) ? '现在分词' : /s$/.test(word) ? '第三人称单数' : '动词变形';
      if (isInflection && !exact && word !== headword) {
        const verbMeanings = translations.filter(isVerbLine);
        entries.unshift({ headword: word, isInflection: false, isVirtual: true, phonetic: '',
          translations: verbMeanings.length ? verbMeanings : translations,
          formNote: `${headword} 的${description}` });
      }
      for (const item of records) {
        const lemma = word.includes(' ') ? [item.lemma, ...word.split(' ').slice(1)].join(' ') : item.lemma;
        if (entries.some((entry) => entry.headword === lemma)) continue;
        const candidate = this.directStatement.get(lemma);
        if (!candidate || !isVerbEntry(candidate)) continue;
        entries.push({ headword: lemma, isInflection: true, phonetic: normalizePhonetic(candidate.phonetic),
          translations: splitTranslations(candidate.translation) });
      }
      // A genuine lexical entry must remain selectable alongside a verb lemma.
      const ambiguous = entries.length > 1 && !entries[0].isVirtual && entries[0].translations.some(
        (line) => /[\u3400-\u9fff]/.test(line) && !/过去式|过去分词|现在分词|第三人称单数/.test(line),
      );
      return this.cacheResult(word, {
        found: true,
        word,
        headword,
        isInflection,
        phonetic,
        translations,
        entries,
        ambiguous,
      });
    } catch (error) {
      return { found: false, word, error: error?.message || '本地中文词典不可用' };
    }
  }

  cacheResult(word, result) {
    if (this.lookupCache.size >= 3000) this.lookupCache.delete(this.lookupCache.keys().next().value);
    this.lookupCache.set(word, result);
    return result;
  }

  close() {
    if (!this.database) return;
    this.directStatement = null;
    this.aliasStatement = null;
    this.lookupCache.clear();
    this.inflections = {};
    this.database.close();
    this.database = null;
  }
}

module.exports = { ChineseDictionary, normalizePhonetic, splitTranslations };
