import { test, expect } from '@playwright/test';
import pg from 'pg';
import type { CommandResult } from '../src/shared/commands';

test('live commands grow pages, refresh, repeat, stop and reopen the playground', async ({ page }) => {
  test.skip(!process.env.TEST_DATABASE_URL, 'A scratch PostgreSQL database is required.');
  let schema: string | undefined;
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  try {
    await page.goto('http://127.0.0.1:5438');
    await expect(page.locator('#mode')).toHaveText('Live');
    await page.locator('#commands > summary').click();
    const createdResponse = page.waitForResponse(r => r.url().endsWith('/api/command') && r.request().method() === 'POST');
    await page.locator('#run-command').click();
    const created = await (await createdResponse).json() as CommandResult; schema = created.schema;
    await expect(page.locator('#command-result')).toContainText('100 rows total');
    await expect(page.locator('.node[data-block]')).toHaveCount(1);
    await expect(page.locator('.node[data-block] text.key')).toHaveText(['1', '2', '100']);
    await page.selectOption('#command-template', 'append');
    await page.locator('#command-count').fill('3000');
    await page.locator('#run-command').click();
    await expect(page.locator('#command-result')).toContainText('3,100 rows total');
    await expect(page.locator('.node[data-block]')).toHaveCount(4);
    await expect(page.locator('.node.changed').first()).toBeVisible();
    await page.selectOption('#command-template', 'random');
    await page.locator('#command-count').fill('30');
    await page.locator('#repeat-command').click();
    await expect(page.locator('#command-result')).toContainText('3,130 rows total');
    await page.getByRole('button', { name: '■ Stop', exact: true }).click();
    await expect(page.locator('#repeat-command')).toHaveText('▶ Repeat');
    await page.selectOption('#command-template', 'delete');
    await page.locator('#command-count').fill('100');
    await page.locator('#run-command').click();
    await expect(page.locator('#command-result')).toContainText('3,030 rows total');
    await page.selectOption('#command-template', 'vacuum');
    await page.locator('#run-command').click();
    await expect(page.locator('#command-result')).toContainText('0 affected');
    await page.reload();
    await page.locator('#commands > summary').click();
    await page.locator('#run-command').click();
    await expect(page.locator('#command-result')).toContainText('3,030 rows total');
    // Start WAL capture, then execute a template without leaving the stream view.
    await page.getByRole('button', { name: 'WAL', exact: true }).click();
    await expect(page.locator('#wal-start')).toBeEnabled();
    const captureResponse = page.waitForResponse(r => r.url().endsWith('/api/wal') && r.request().postDataJSON()?.action === 'start');
    await page.locator('#wal-start').click();
    const capture = await (await captureResponse).json() as { slot: string | null; logical: boolean };
    await expect(page.locator('#wal-stop')).toBeEnabled();
    await page.locator('#commands > summary').click();
    await page.selectOption('#command-template', 'append');
    await page.locator('#command-count').fill('3');
    await page.locator('#run-command').click();
    await expect(page.locator('#command-result')).toContainText('3,033 rows total');
    await expect(page.locator('#wal-rows')).toContainText('Insert an index entry');
    await page.locator('#commands > summary').click();
    await page.locator('#wal-filter').fill(schema!);
    await expect(page.locator('#wal-rows')).toContainText('keys');
    if (capture.logical) {
      await expect(page.locator('#wal-rows')).toContainText('LSN match');
      await page.selectOption('#wal-mode', 'logical');
      await expect(page.locator('#wal-rows')).toContainText('INSERT:');
    }
    await page.locator('#wal-stop').click();
    await expect(page.locator('#wal-status')).toContainText('Stopped');
    const inspect = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await inspect.connect();
    try { expect((await inspect.query('SELECT slot_name FROM pg_replication_slots WHERE slot_name=$1', [capture.slot])).rows).toHaveLength(0); } finally { await inspect.end(); }
    expect(errors).toEqual([]);
    expect((await page.request.post('http://127.0.0.1:5438/api/command', { data: { command: 'delete', count: 1 } })).status()).toBe(405);
    expect((await page.request.post('http://127.0.0.1:5438/api/command', { headers: { 'X-Pgviz-Command': '1', Origin: 'https://example.com' }, data: { command: 'delete', count: 1 } })).status()).toBe(403);
  } finally {
    if (schema && /^pgviz_play_[0-9a-f]+$/.test(schema)) {
      const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL }); await c.connect();
      try { await c.query(`DROP SCHEMA "${schema}" CASCADE`); } finally { await c.end(); }
    }
  }
});
