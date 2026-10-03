import { defineConfig } from '@playwright/test';

/**
 * The browser tests (fix prompt v4.1): the built app in a real Chromium, in demo mode (answered
 * in the browser, nothing private). Locally and in CI, `npm run build` first: the tests start
 * `vite preview` on the build. `STAYPUT_URL` points them at a deployed StayPut instead.
 * `CHROME_PATH` names the browser to drive; else the machine's Chrome.
 */
const url = process.env.STAYPUT_URL;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  timeout: 180_000,
  expect: { timeout: 10_000 },
  workers: 2,
  reporter: [['list']],
  use: {
    baseURL: url ?? 'http://localhost:4173',
    locale: 'en-US',
    // With the scrollbars a desktop shows (Chrome hides them when headless): the page's
    // room is then what a creator on Windows gets.
    launchOptions: {
      ignoreDefaultArgs: ['--hide-scrollbars'],
      ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}),
    },
    ...(process.env.CHROME_PATH ? {} : { channel: 'chrome' }),
  },
  projects: [
    { name: '1280x720', use: { viewport: { width: 1280, height: 720 } } },
    { name: '1024x768', use: { viewport: { width: 1024, height: 768 } } },
  ],
  ...(url
    ? {}
    : {
        webServer: {
          command: 'npx vite preview --port 4173 --strictPort',
          cwd: '..',
          port: 4173,
          reuseExistingServer: true,
        },
      }),
});
