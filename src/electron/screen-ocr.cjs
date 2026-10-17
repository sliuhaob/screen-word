'use strict';
const { createHash } = require('node:crypto');
const { mergeOcrWords, overlap } = require('./ocr-merge.cjs');
const { expandCompoundWords } = require('./ocr-utils.cjs');
const { detectDictionaryPhrases } = require('./phrase-utils.cjs');
const { planRecovery, acceptRecovery } = require('./ocr-recovery.cjs');
function lookupWords(words, lookup) {
  return detectDictionaryPhrases(expandCompoundWords(words, lookup), lookup, 5, { preserveWords: true });
}
function scaleWords(words, scaleX = 1, scaleY = 1) {
  return words.map(w => ({ ...w, x: w.x * scaleX, y: w.y * scaleY,
    width: w.width * scaleX, height: w.height * scaleY,
    ...(w.textBox ? { textBox: { x: w.textBox.x * scaleX, y: w.textBox.y * scaleY,
      width: w.textBox.width * scaleX, height: w.textBox.height * scaleY } } : {}),
    ...(w.components ? { components: scaleWords(w.components, scaleX, scaleY) } : {}),
  }));
}
class ScreenOcrPipeline {
  constructor(recognizer, supplementRecognizer, { lookup } = {}) {
    if (!supplementRecognizer || recognizer === supplementRecognizer) throw new Error('OCR requires two independent workers');
    this.recognizer = recognizer;
    this.supplementRecognizer = supplementRecognizer;
    this.cache = null;
    this.mergeOptions = lookup ? { isKnownWord: word => Boolean(lookup(word)?.found) } : {};
  }
  async prewarm() {
    const results = await Promise.allSettled([this.recognizer.getWorker(), this.supplementRecognizer.getWorker()]);
    const failed = results.find(r => r.status === 'rejected');
    if (failed) throw failed.reason;
  }
  async terminate() {
    await Promise.allSettled([this.recognizer.terminate(), this.supplementRecognizer.terminate()]);
  }
  clear() { this.cache = null; }
  async recognize(capture, { shouldStop = () => false, onPartial } = {}) {
    if (shouldStop()) return { stopped: true };
    const key = createHash('sha256').update(`${capture.width}:${capture.height}:`)
      .update(capture.buffer).digest('hex');
    if (this.cache?.key === key) return { ...this.cache.result, cached: true };
    const enhanced = capture.makeSupplement();
    let settledLanes = 0, publicationError = null;
    let publication = Promise.resolve();
    // Serialise display updates, but never make the other lane or local OCR
    // wait for painting. Final completion drains the bounded publication queue.
    const publish = (getWords, stage, relevant = () => true) => {
      if (!onPartial) return;
      publication = publication.then(async () => {
        if (shouldStop() || publicationError || !relevant()) return;
        const words = getWords();
        if (words.length) await onPartial({ words, stage, mode: enhanced.mode, complete: false, cached: false });
      }).catch(error => { publicationError ||= error; });
    };
    const observe = (job, original) => job.then(result => {
      settledLanes++;
      if (settledLanes === 1) publish(() => {
        const reliable = result.words.filter(w => w.confidence >= 80
          && (!this.mergeOptions.isKnownWord || this.mergeOptions.isKnownWord(w.text)));
        return mergeOcrWords(original ? reliable : [], original ? [] : reliable, this.mergeOptions);
      }, 'first-pass', () => settledLanes < 2);
      return result;
    }, error => { settledLanes++; throw error; });
    // Each lane owns a worker: concurrent setParameters/recognize calls on one
    // Tesseract instance would mix jobs. Always drain both lanes, even on cancel.
    const jobs = [
      observe(Promise.resolve().then(() => this.recognizer.recognize(capture.buffer, { pageSegMode: '11', minimumConfidence: 45 }))
        .then(result => ({ words: result.words, candidates: result.candidates || result.words })), true),
      observe(Promise.resolve().then(() => this.supplementRecognizer.recognize(enhanced.buffer, { pageSegMode: '11', minimumConfidence: 30 }))
        .then(result => ({ words: scaleWords(result.words, enhanced.scaleX, enhanced.scaleY),
          candidates: scaleWords(result.candidates || result.words, enhanced.scaleX, enhanced.scaleY) })), false),
    ];
    const [original, supplement] = await Promise.allSettled(jobs);
    if (shouldStop()) { await publication; return { stopped: true }; }
    if (original.status === 'rejected' && supplement.status === 'rejected') throw original.reason;
    let degraded = original.status === 'rejected' || supplement.status === 'rejected';
    const raw = original.status === 'fulfilled' ? original.value : { words: [], candidates: [] };
    const extra = supplement.status === 'fulfilled' ? supplement.value : { words: [], candidates: [] };
    let words = mergeOcrWords(raw.words, extra.words, this.mergeOptions);
    const planned = !degraded && capture.makeCrop
      ? planRecovery(raw.candidates, extra.candidates, words, this.mergeOptions.isKnownWord) : [];
    if (planned.length) {
      const merged = words;
      // Hold suspect fragments while their complete word is being re-read.
      publish(() => merged.filter(w => !planned.some(c => overlap(c, w).coverage >= .75)), 'merged');
    }
    const verifiedWords = [];
    // Bounded local retries reuse the two idle workers and the SAME frozen
    // frame. No new screenshot, model or additional recognition jobs.
    for (let i = 0; i < planned.length; i += 2) {
      if (shouldStop()) { await publication; return { stopped: true }; }
      const retries = await Promise.allSettled(planned.slice(i, i + 2).map(async (candidate, index) => {
        const crop = capture.makeCrop(candidate);
        const engine = index === 0 ? this.recognizer : this.supplementRecognizer;
        const result = await engine.recognize(crop.buffer, { pageSegMode: '7', minimumConfidence: 70 });
        return acceptRecovery(candidate, crop, result);
      }));
      if (shouldStop()) { await publication; return { stopped: true }; }
      for (const retry of retries) {
        if (retry.status === 'rejected') degraded = true;
        else if (retry.value) verifiedWords.push(retry.value);
      }
    }
    if (verifiedWords.length) words = mergeOcrWords(raw.words, extra.words, { ...this.mergeOptions, verifiedWords });
    await publication;
    if (shouldStop()) return { stopped: true };
    if (publicationError) throw publicationError;
    const result = { words, stage: 'final', mode: enhanced.mode, cached: false, complete: true, degraded,
      recovery: { attempted: planned.length, accepted: verifiedWords.map(w => w.text) } };
    // Retry a failed lane on the next key press, even on an unchanged screen.
    if (!degraded) this.cache = { key, result };
    return result;
  }
}
module.exports = { ScreenOcrPipeline, scaleWords, lookupWords };
