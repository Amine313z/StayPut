import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { createReadStream, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { OCR_DIR, OCR_FILES, OCR_VERSIONS } from './src/ocr-files';

// In development, the Worker runs next to Vite (`npm run dev:worker`, port 8787): the paths it
// answers are forwarded to it, as in production where both share one origin.
const worker = 'http://localhost:8787';

const require = createRequire(import.meta.url);

/** Where an installed package's file is, after checking the package is at the expected version. */
function packageFile(name: keyof typeof OCR_VERSIONS, file: string): string {
  const manifest = require.resolve(`${name}/package.json`);
  const { version } = JSON.parse(readFileSync(manifest, 'utf8')) as { version: string };
  if (version !== OCR_VERSIONS[name]) {
    throw new Error(`${name} is ${version}, src/ocr-files.ts expects ${OCR_VERSIONS[name]}`);
  }
  return path.join(path.dirname(manifest), file);
}

/**
 * Tesseract's files (src/ocr-files.ts), served from StayPut's own origin: copied into the build,
 * and answered by the development server.
 */
function ocrFiles(): Plugin {
  const files = new Map(OCR_FILES.map(([name, file, served]) => [served, packageFile(name, file)]));
  return {
    name: 'stayput-ocr-files',
    generateBundle() {
      for (const [served, source] of files) {
        this.emitFile({
          type: 'asset',
          fileName: `${OCR_DIR}/${served}`,
          source: readFileSync(source),
        });
      }
    },
    configureServer(server) {
      server.middlewares.use(`/${OCR_DIR}`, (req, res, next) => {
        const source = files.get((req.url ?? '').replace(/^\//, '').split('?')[0] ?? '');
        if (!source) return next();
        res.setHeader(
          'Content-Type',
          source.endsWith('.gz') ? 'application/gzip' : 'text/javascript; charset=utf-8',
        );
        createReadStream(source).pipe(res);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), ocrFiles()],
  server: {
    port: 5173,
    proxy: {
      '/api': worker,
      '/webhooks': worker,
      '/health': worker,
      '^/badge/': worker,
      '^/v/': worker,
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
  },
});
