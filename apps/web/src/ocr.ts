import { extractNumbers, type ProofInput } from '@stayput/core';
import type { Worker as Reader } from 'tesseract.js';
import { OCR_DIR } from './ocr-files';

/**
 * A screenshot read in the member's browser (SPEC Phase 5, point 3): its SHA-256 and the numbers
 * Tesseract finds on it. The image itself never leaves the device. Tesseract (a few megabytes,
 * kept by the browser after the first time) loads only when a member picks a screenshot.
 */

export type ReadingStage = 'loading' | 'reading';

/**
 * Past this, the reading has failed: a worker whose WebAssembly cannot start never answers
 * (seen in Chromium when the page forbids it), and the member must not wait forever. The first
 * reading downloads about 7 MB.
 */
export const READING_TIMEOUT_MS = 120_000;

async function sha256Of(file: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function readScreenshot(
  file: Blob,
  onProgress: (stage: ReadingStage, ratio: number) => void,
  timeoutMs = READING_TIMEOUT_MS,
): Promise<ProofInput> {
  onProgress('loading', 0);
  const sha256 = await sha256Of(file);
  // Settled by the worker's own errors, or by the time limit.
  let fail: (error: unknown) => void = () => {};
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  failed.catch(() => {});
  const timer = setTimeout(() => fail(new Error('reading timed out')), timeoutMs);
  let reader: Reader | undefined;
  try {
    const { createWorker } = await import('tesseract.js');
    const base = `${window.location.origin}/${OCR_DIR}`;
    // 1: the LSTM engine only (the model StayPut serves).
    reader = await Promise.race([
      createWorker('eng', 1, {
        workerPath: `${base}/worker.min.js`,
        corePath: base,
        langPath: base,
        workerBlobURL: false,
        logger: (message) => {
          if (message.status === 'recognizing text') onProgress('reading', message.progress);
          else if (message.status.startsWith('loading')) onProgress('loading', message.progress);
        },
        errorHandler: (error: unknown) => fail(error),
      }),
      failed,
    ]);
    const { data } = await Promise.race([reader.recognize(file), failed]);
    return { sha256, numbers: extractNumbers(data.text) };
  } finally {
    clearTimeout(timer);
    reader?.terminate().catch(() => {});
  }
}
