'use strict';

const path = require('node:path');
const { createWorker, PSM } = require('tesseract.js');
const { extractWordsFromBlocks } = require('./ocr-utils.cjs');

class OfflineRecognizer {
  constructor({ packaged, resourcesPath, appPath, onProgress = () => {} }) {
    this.packaged = packaged;
    this.resourcesPath = resourcesPath;
    this.appPath = appPath;
    this.onProgress = onProgress;
    this.workerPromise = null;
    this.terminated = false;
  }

  getLanguagePath() {
    if (this.packaged) return path.join(this.resourcesPath, 'ocr');
    return path.join(this.appPath, 'node_modules', '@tesseract.js-data', 'eng', '4.0.0_best_int');
  }

  async getWorker() {
    if (this.terminated) throw new Error('OCR worker has been terminated');
    if (!this.workerPromise) {
      this.workerPromise = createWorker('eng', 1, {
        langPath: this.getLanguagePath(),
        gzip: true,
        cacheMethod: 'none',
        logger: (message) => this.onProgress(message),
      }).then(async (worker) => {
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: PSM.AUTO,
            preserve_interword_spaces: '1',
          });
        } catch (error) {
          await worker.terminate();
          throw error;
        }
        return worker;
      }).catch((error) => {
        this.workerPromise = null;
        throw error;
      });
    }
    return this.workerPromise;
  }

  async recognize(imageBuffer, { pageSegMode = PSM.AUTO, minimumConfidence = 45 } = {}) {
    const worker = await this.getWorker();
    await worker.setParameters({
      tessedit_pageseg_mode: pageSegMode,
      preserve_interword_spaces: '1',
    });
    const result = await worker.recognize(imageBuffer, {}, { text: true, blocks: true });
    const candidates = extractWordsFromBlocks(result?.data?.blocks, 0);
    return {
      text: result?.data?.text || '',
      // Preserve the original confidence-before-count-cap behavior on dense
      // pages. Rejected tokens must not consume the 900 accepted-word slots.
      words: extractWordsFromBlocks(result?.data?.blocks, minimumConfidence),
      candidates,
    };
  }

  recognizeGameCaptions(imageBuffer) {
    return this.recognize(imageBuffer, {
      pageSegMode: PSM.SPARSE_TEXT,
      minimumConfidence: 30,
    });
  }

  async terminate() {
    this.terminated = true;
    if (!this.workerPromise) return;
    try {
      const worker = await this.workerPromise;
      await worker.terminate();
    } finally {
      this.workerPromise = null;
    }
  }
}

module.exports = { OfflineRecognizer };
