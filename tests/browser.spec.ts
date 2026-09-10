import { test, expect } from '@playwright/test';
import { createServer, createConnection, type Socket } from 'node:net';
import { once } from 'node:events';

test('browser works through a TCP tunnel using a different local port', async ({ page, baseURL }) => {
  const upstream = new URL(baseURL!);
  const sockets = new Set<Socket>();
  const tunnel = createServer(socket => {
    const target = createConnection({ host: upstream.hostname, port: Number(upstream.port) });
    for (const s of [socket, target]) {
      sockets.add(s);
      s.on('close', () => sockets.delete(s));
      s.on('error', () => { socket.destroy(); target.destroy(); });
    }
    socket.pipe(target).pipe(socket);
  });
  tunnel.listen(0, '127.0.0.1');
  await once(tunnel, 'listening');
  const address = tunnel.address();
  if (!address || typeof address === 'string') throw new Error('Tunnel did not open');
  try {
    const origin = `http://127.0.0.1:${address.port}`;
    await page.goto(origin);
    await expect(page.locator('.node[data-block]')).toHaveCount(4);
    const response = await page.request.get(`${origin}/api/status`, { headers: { Origin: origin } });
    expect(response.status()).toBe(200);
    await page.getByRole('button', { name: 'Page map', exact: true }).click();
    await expect(page.locator('.page-cell')).toHaveCount(49);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => tunnel.close(error => error ? reject(error) : resolve()));
  }
});
test('compact tree, drilldown, heap, map, and export', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  await page.goto('/');
  await expect(page.locator('#mode')).toHaveText('Demo');
  await expect(page.locator('.node[data-block]')).toHaveCount(4);
  await page.locator('#key-options > summary').click();
  await page.selectOption('#endian', 'raw');
  await page.selectOption('#endian', 'auto');
  await page.locator('#key-options > summary').click();
  await page.locator('.node[data-block="48"]').click();
  await expect(page.locator('#details h3')).toHaveText('Block 48');
  await page.getByRole('button', { name: '↳ Block 42', exact: true }).click();
  await expect(page.locator('#details h3')).toHaveText('Block 42');
  await page.getByRole('button', { name: 'Explore subtree ↗' }).click();
  await expect(page.locator('.node[data-block="42"]')).toBeVisible();
  await page.locator('.node[data-block="9"]').click();
  await expect(page.locator('#details')).toContainText('POSTING LIST');
  await page.getByRole('button', { name: 'Heap (18,1) ↗', exact: true }).click();
  await expect(page.locator('#details h3')).toHaveText('(18,1)');
  await expect(page.locator('.byte-cell')).toHaveCount(512);
  await page.locator('#line-pointers > summary').click();
  await page.getByRole('button', { name: '4 · normal', exact: true }).click();
  await page.getByRole('button', { name: 'Follow ctid →' }).click();
  await expect(page.locator('#details h3')).toHaveText('(18,20)');
  await page.getByRole('button', { name: 'Page map', exact: true }).click();
  await expect(page.locator('.page-cell')).toHaveCount(128);
  await page.getByRole('button', { name: 'Next range', exact: true }).click();
  await expect(page.locator('.page-cell')).toHaveCount(32);
  const download = page.waitForEvent('download');
  await page.locator('#tools > summary').click();
  await page.getByRole('button', { name: '↓ Export snapshot' }).click();
  expect((await download).suggestedFilename()).toBe('pgviz-map-2.json');
  expect(errors).toEqual([]);
});
test('zoom, keyboard selection, filters and mobile layout', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('.node[data-block]')).toHaveCount(4);
  await expect(page.locator('#inspector')).toBeHidden();
  await page.getByRole('button', { name: 'Expand 5 branches of block 48', exact: true }).click();
  await expect(page.locator('.node[data-block]')).toHaveCount(9);
  await page.getByRole('button', { name: 'Collapse block 48', exact: true }).click();
  await expect(page.locator('.node[data-block]')).toHaveCount(4);
  const before = await page.locator('#zoom-label').textContent();
  await page.getByRole('button', { name: 'Zoom in', exact: true }).click();
  expect(await page.locator('#zoom-label').textContent()).not.toBe(before);
  await page.getByRole('button', { name: 'Fit view', exact: true }).click();
  await page.locator('.node[data-block="48"]').focus(); await page.keyboard.press('Enter');
  await expect(page.locator('#details h3')).toHaveText('Block 48');
  await page.locator('#item-search').fill('999999'); await expect(page.locator('#items')).toContainText('No matching entries.');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.locator('#relation-picker > summary').click();
  await page.locator('#search').fill('no_such_relation'); await expect(page.locator('#relations')).toContainText('No matching relations');
});
test('local API denies foreign origins and invalid inputs', async ({ request }) => {
  expect((await request.get('/api/status', { headers: { Origin: 'https://example.com' } })).status()).toBe(403);
  expect((await request.get('/api/status', { headers: { Host: 'example.com' } })).status()).toBe(403);
  expect((await request.get('/api/status', { headers: { Host: '127.0.0.1:8000', Origin: 'http://127.0.0.1:8001' } })).status()).toBe(403);
  expect((await request.get('/api/status', { headers: { Host: 'localhost.evil.example:8000' } })).status()).toBe(403);
  expect((await request.post('/api/status')).status()).toBe(405);
  expect((await request.get('/api/tree?oid=1&depth=9')).status()).toBe(400);
});
