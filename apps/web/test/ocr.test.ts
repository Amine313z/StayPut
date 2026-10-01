import { createHash } from 'node:crypto';
import { createWorker } from 'tesseract.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readScreenshot } from '../src/ocr';
import { OCR_DIR } from '../src/ocr-files';

/**
 * Reading a screenshot (SPEC Phase 5, point 3) around Tesseract, which only a real browser runs
 * (checked there by hand, see DECISIONS.md): what leaves the device, and that a reading which
 * never ends, or breaks, lets the member go on.
 */

vi.mock('tesseract.js', () => ({ createWorker: vi.fn() }));

const image = new Blob(['a dashboard'], { type: 'image/png' });
const sha256 = createHash('sha256').update('a dashboard').digest('hex');

afterEach(() => {
  vi.mocked(createWorker).mockReset();
});

describe('readScreenshot', () => {
  it('sends only the fingerprint and the numbers read, from StayPut’s own files', async () => {
    const terminate = vi.fn(() => Promise.resolve({ jobId: 't', data: null }));
    vi.mocked(createWorker).mockImplementation((_langs, _oem, options) => {
      options?.logger?.({ status: 'recognizing text', progress: 0.5 } as never);
      return Promise.resolve({
        recognize: () =>
          Promise.resolve({ data: { text: 'Revenue 3,250.00 $\n01/10/2026 Sales 12' } }),
        terminate,
      } as never);
    });
    const progress: [string, number][] = [];
    expect(await readScreenshot(image, (stage, ratio) => progress.push([stage, ratio]))).toEqual({
      sha256,
      numbers: [3250, 12],
    });
    expect(progress).toEqual([
      ['loading', 0],
      ['reading', 0.5],
    ]);
    const options = vi.mocked(createWorker).mock.calls[0]?.[2];
    expect(options).toMatchObject({
      workerPath: expect.stringMatching(new RegExp(`/${OCR_DIR}/worker\\.min\\.js$`)) as unknown,
      workerBlobURL: false,
    });
    expect(options?.corePath).toMatch(new RegExp(`/${OCR_DIR}$`));
    expect(options?.langPath).toMatch(new RegExp(`/${OCR_DIR}$`));
    expect(terminate).toHaveBeenCalled();
  });

  it('gives up on a reading that never ends', async () => {
    vi.mocked(createWorker).mockImplementation(() => new Promise(() => {}));
    await expect(readScreenshot(image, () => {}, 50)).rejects.toThrow('reading timed out');
  });

  it('gives up when the reader breaks', async () => {
    vi.mocked(createWorker).mockImplementation((_langs, _oem, options) => {
      setTimeout(() => options?.errorHandler?.(new Error('wasm refused')), 10);
      return new Promise(() => {});
    });
    await expect(readScreenshot(image, () => {}, 5_000)).rejects.toThrow('wasm refused');
  });
});
