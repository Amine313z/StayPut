import react from '@vitejs/plugin-react';
import { defineProject } from 'vitest/config';

export default defineProject({
  plugins: [react()],
  test: {
    environment: 'happy-dom',
    setupFiles: ['./test/setup.ts'],
    // A frame's page (the preview of a card's public page) is the Worker's: never loaded here.
    environmentOptions: {
      happyDOM: { settings: { navigation: { disableChildFrameNavigation: true } } },
    },
  },
});
