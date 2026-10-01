/**
 * Tesseract's files, served by StayPut itself (never a CDN: the pages allow scripts from their
 * own origin only): the worker, the WebAssembly cores (with SIMD, relaxed SIMD, or neither: the
 * worker picks the one the browser runs) and the English model, which reads digits, amounts and
 * percentages whatever the language around them. vite.config.ts copies them into `OCR_DIR` at
 * build, from these packages at these versions (it checks them).
 */
export const OCR_DIR = 'ocr/tesseract-7.0.0';

export const OCR_VERSIONS = {
  'tesseract.js': '7.0.0',
  'tesseract.js-core': '7.0.0',
  '@tesseract.js-data/eng': '1.0.0',
} as const;

/** [package, file in it, name served under OCR_DIR] */
export const OCR_FILES: readonly (readonly [keyof typeof OCR_VERSIONS, string, string])[] = [
  ['tesseract.js', 'dist/worker.min.js', 'worker.min.js'],
  ['tesseract.js-core', 'tesseract-core-lstm.wasm.js', 'tesseract-core-lstm.wasm.js'],
  ['tesseract.js-core', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  [
    'tesseract.js-core',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
    'tesseract-core-relaxedsimd-lstm.wasm.js',
  ],
  ['@tesseract.js-data/eng', '4.0.0_best_int/eng.traineddata.gz', 'eng.traineddata.gz'],
];
