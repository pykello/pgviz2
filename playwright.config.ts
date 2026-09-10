import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', testMatch: ['**/browser.spec.ts', '**/commands.spec.ts'],
  use: { baseURL: 'http://127.0.0.1:5437', viewport: { width: 1440, height: 1000 } },
  webServer: [
    { command: 'npm run dev -- --demo', url: 'http://127.0.0.1:5437', env: { PORT: '5437' }, reuseExistingServer: !process.env.CI },
    ...(process.env.TEST_DATABASE_URL ? [{ command: 'npm start', url: 'http://127.0.0.1:5438', env: { PORT: '5438', DATABASE_URL: process.env.TEST_DATABASE_URL }, reuseExistingServer: false }] : []),
  ],
});
