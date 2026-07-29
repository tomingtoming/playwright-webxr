import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  retries: 0,
  use: {
    headless: true,
    locale: 'ja-JP',
    viewport: { width: 960, height: 540 },
    launchOptions: {
      // Software WebGL path proven by IWER's own CI, Babylon.js and VTK
      args: [
        '--use-gl=angle',
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--no-sandbox',
      ],
    },
  },
  reporter: [['line']],
});
