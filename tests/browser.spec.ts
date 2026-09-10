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
    await page.getByRole('button', { name: 'public.orders_customer_idx', exact: true }).click();
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
  await page.getByRole('button', { name: 'public.orders_customer_idx', exact: true }).click();
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
  await page.goto('/');
  await page.getByRole('button', { name: 'public.orders_customer_idx', exact: true }).click(); await expect(page.locator('.node[data-block]')).toHaveCount(4);
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

test('home lists tables and indexes before loading a visualization', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#home')).toBeVisible();
  await expect(page.locator('#workarea')).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Heap tables' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'B-tree indexes' })).toBeVisible();
  await page.getByRole('button', { name: 'public.orders', exact: true }).click();
  await expect(page.locator('.byte-cell')).toHaveCount(512);
  await page.locator('.brand').click();
  await expect(page.locator('#home')).toBeVisible();
  await page.locator('#home-search').fill('no_such_relation');
  await expect(page.locator('#home-relations button')).toHaveCount(0);
});

test('URLs restore subtrees, display options, pages and browser history', async ({ page }) => {
  await page.goto('/?view=tree&oid=1&root=42&depth=1&keys=raw');
  await expect(page.locator('.node[data-block]')).toHaveCount(1);
  await expect(page.locator('.node[data-block="42"]')).toBeVisible();
  await expect(page.locator('#depth')).toHaveValue('1');
  await page.locator('#key-options > summary').click();
  await expect(page.locator('#endian')).toHaveValue('raw');
  await page.locator('#key-options > summary').click();
  await page.reload();
  await expect(page.locator('.node[data-block="42"]')).toBeVisible();
  await page.getByRole('button', { name: '↑ Entire tree' }).click();
  await expect(page).not.toHaveURL(/root=/);
  await page.goBack();
  await expect(page.locator('.node[data-block="42"]')).toBeVisible();
  await page.goForward();
  await expect(page.locator('.node[data-block="48"]')).toBeVisible();
  await page.goto('/?view=heap&oid=2&block=18');
  await expect(page.locator('#block')).toHaveValue('18');
  await page.getByRole('button', { name: 'Next page', exact: true }).click();
  await expect(page).toHaveURL(/block=19/);
  await page.reload();
  await expect(page.locator('#breadcrumbs')).toContainText('block 19');
  await page.getByRole('button', { name: 'Page map', exact: true }).click();
  await page.getByRole('button', { name: 'Next range', exact: true }).click();
  await expect(page).toHaveURL(/view=map&oid=2&start=128/);
  await page.reload();
  await expect(page.locator('.page-cell')).toHaveCount(32);
  await page.locator('.brand').click();
  await expect(page.locator('#home')).toBeVisible();
  await page.goBack();
  await expect(page.locator('.page-cell')).toHaveCount(32);
});

test('WAL URLs restore display settings without starting capture', async ({ page }) => {
  await page.goto('/?view=wal&show=logical&filter=orders');
  await expect(page.locator('#wal-mode')).toHaveValue('logical');
  await expect(page.locator('#wal-filter')).toHaveValue('orders');
  await expect(page.locator('#wal-stop')).toBeDisabled();
  await page.selectOption('#wal-mode', 'physical');
  await page.reload();
  await expect(page.locator('#wal-mode')).toHaveValue('physical');
  await expect(page.locator('#wal-filter')).toHaveValue('orders');
  await expect(page.locator('#wal-stop')).toBeDisabled();
});

test('invalid and missing relations show a recoverable URL error', async ({ page }) => {
  for (const search of ['?view=heap&oid=2&block=-1', '?view=tree&oid=9999', '?view=tree&oid=2']) {
    await page.goto('/' + search);
    await expect(page.locator('#error')).toBeVisible();
    await expect(page.locator('#home')).toBeVisible();
    await page.getByRole('button', { name: 'public.orders_customer_idx', exact: true }).click();
    await expect(page.locator('.node[data-block]')).toHaveCount(4);
    await expect(page.locator('#error')).toBeHidden();
  }
});

test('heap values fit the byte cells and remain readable in the inspector', async ({ page }) => {
  await page.goto('/?view=heap&oid=2');
  const label = page.locator('.heap-value[data-lp="1"]');
  await expect(label).toContainText('Customer 1');
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await expect.poll(() => label.evaluate(el => {
      const r = el.getBoundingClientRect(), grid = el.parentElement!.getBoundingClientRect();
      return r.left >= grid.left && r.right <= grid.right && r.top >= grid.top && r.bottom <= grid.bottom;
    })).toBe(true);
    await expect(label).toHaveCSS('text-overflow', 'ellipsis');
    await expect.poll(() => label.evaluate(el => el.isConnected && el.scrollWidth > el.clientWidth)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  // Labels pass clicks through to byte cells. Wait for ResizeObserver to
  // align the label with its tuple before reading raw mouse coordinates.
  await expect.poll(() => page.evaluate(() => {
    const el = document.querySelector('.heap-value[data-lp="1"]');
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const target = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return target?.classList.contains('byte-cell') && target.getAttribute('title')?.startsWith('Tuple 1 ');
  })).toBe(true);
  const box = await label.boundingBox();
  await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await expect(page.locator('#details')).toContainText('Customer 1 · example order');
  await expect(page.locator('#details')).toContainText('NULL');
});

test('line pointers outline their tuple across grid rows and clear selection', async ({ page }) => {
  await page.goto('/?view=heap&oid=2');
  await page.getByRole('button', { name: 'Line pointer 9', exact: true }).click();
  await expect(page.locator('.tuple-outline')).toHaveCount(2);
  await expect(page.locator('.tuple-outline').first()).toHaveAttribute('data-lp', '9');
  await expect(page.locator('#details h3')).toHaveText('(0,9)');
  await page.locator('#line-pointers > summary').click();
  await page.getByRole('button', { name: '1 · normal', exact: true }).click();
  await expect(page.locator('.tuple-outline')).toHaveCount(1);
  await expect(page.locator('.tuple-outline')).toHaveAttribute('data-lp', '1');
  await page.setViewportSize({ width: 390, height: 1000 });
  await expect.poll(() => page.locator('.tuple-outline').evaluate(el => {
    const r = el.getBoundingClientRect(), grid = el.parentElement!.getBoundingClientRect();
    return r.left >= grid.left && r.right <= grid.right && r.top >= grid.top && r.bottom <= grid.bottom;
  })).toBe(true);
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click();
  await expect(page.locator('.tuple-outline')).toHaveCount(0);
  await expect(page.locator('[data-pointer][aria-pressed=true]')).toHaveCount(0);
});

test('redirect line pointers highlight the target and dead pointers clear it', async ({ page }) => {
  await page.route('**/api/heap?*', async route => {
    const response = await route.fetch(); const data = await response.json();
    Object.assign(data.items[0], { lp_flags: 2, lp_off: 2, lp_len: 0 });
    Object.assign(data.items[2], { lp_flags: 3, lp_off: 0, lp_len: 0 });
    await route.fulfill({ response, json: data });
  });
  await page.goto('/?view=heap&oid=2');
  await page.getByRole('button', { name: 'Line pointer 1', exact: true }).click();
  await expect(page.locator('.tuple-outline')).toHaveAttribute('data-lp', '2');
  await page.getByRole('button', { name: 'Line pointer 3', exact: true }).click();
  await expect(page.locator('.tuple-outline')).toHaveCount(0);
  await expect(page.locator('#details')).toContainText('Dead');
});
