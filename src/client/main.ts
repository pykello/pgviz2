import './style.css';
import { readLocation, locationSearch, type View } from '../shared/location';
import { WalView } from './wal-view';
import { templates, commandSql, type Command, type CommandResult } from '../shared/commands';
import type { Api, Args, BtreeNode, HeapItem, HeapPage, IndexItem, PageMap, RelationSummary, Route, Tree } from '../shared/types';
import { keyLabel, sample, tidBlock } from '../shared/tree';
const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const esc = (v: unknown): string => String(v ?? '—').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const fmt = (v: number) => v.toLocaleString();
const display = (v: unknown): string => typeof v === 'object' ? JSON.stringify(v) : String(v ?? '—');
const fields = (v: object) => `<dl class="fields">${Object.entries(v).map(([k, value]) => `<div class="field"><dt>${esc(k)}</dt><dd>${esc(display(value))}</dd></div>`).join('')}</dl>`;
const button = (label: string, action: () => void, parent: HTMLElement): void => { const b = document.createElement('button'); b.textContent = label; b.onclick = action; parent.append(b); };
let relations: RelationSummary[] = [], current: RelationSummary | undefined;
let view: View = 'home';
let walSettings = { mode: 'physical' as 'physical' | 'logical', filter: '' };
let tree: Tree | undefined, heap: HeapPage | undefined, map: PageMap | undefined;
let depth = 2, block = 0, mapStart = 0, focusRoot: number | undefined;
let endian: 'auto' | 'raw' | 'little' | 'big' = 'auto', selected: number | undefined;
let selectedHeap: number | undefined;
let requestId = 0, detailId = 0, searchId = 0, filterTimer: ReturnType<typeof setTimeout>;
let snapshot: unknown, baseline: Tree | undefined, changed = new Set<number>();
const walView = new WalView({ canvas: $('canvas'), controls: $('view-controls'), details: setDetails, snapshot: data => { snapshot = data; }, settings: settings => { const replace = walSettings.mode === settings.mode; walSettings = settings; writeLocation(replace); } });
async function api<K extends Route>(route: K, args: Record<string, string | number | undefined> = {}): Promise<Api[K]> {
  const params: Args = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const response = await fetch(`/api/${route}?${new URLSearchParams(params)}`);
  const data: unknown = await response.json();
  if (!response.ok) throw new Error((data as { error: string }).error ?? 'Request failed');
  return data as Api[K];
}
function fail(e: unknown) { $('error').hidden = false; $('error').textContent = e instanceof Error ? e.message : String(e); }
function run(action: () => Promise<void>) { void action().catch(fail); }
function emptyInspector() { selectedHeap = undefined; document.querySelectorAll('.tuple-outline').forEach(el => el.remove()); document.querySelectorAll('[data-pointer]').forEach(el => el.setAttribute('aria-pressed', 'false')); selected = undefined; detailId++; $('details').replaceChildren(); $('inspector').hidden = true; $('workarea').classList.remove('has-selection'); document.querySelectorAll('.node.selected').forEach(n => n.classList.remove('selected')); }
function setDetails(html: string) { $('inspector').hidden = false; $('workarea').classList.add('has-selection'); $('details').innerHTML = html; }
function renderRelations() {
  if (view === 'home') {
    $('home-relations').replaceChildren();
    for (const method of ['heap', 'btree'] as const) {
      const section = document.createElement('section');
      section.innerHTML = `<h2>${method === 'heap' ? 'Heap tables' : 'B-tree indexes'}</h2>`;
      for (const rel of relations.filter(r => r.method === method)) {
        button(`${rel.schema}.${rel.name}`, () => chooseRelation(rel), section);
      }
      if (!section.querySelector('button')) section.insertAdjacentHTML('beforeend', '<p class="hint">No matching relations.</p>');
      $('home-relations').append(section);
    }
  }
  $('relation-count').textContent = String(relations.length);
  $('relations').replaceChildren();
  for (const rel of relations) {
    const b = document.createElement('button'); b.className = 'relation' + (rel.oid === current?.oid ? ' active' : '');
    b.innerHTML = `<span class="icon">${rel.method === 'btree' ? '⑂' : '▤'}</span><span>${esc(rel.name)}<small>${esc(rel.schema)} · ${rel.method === 'btree' ? 'B-tree index' : 'heap table'}</small></span>`;
    b.onclick = () => chooseRelation(rel);
    $('relations').append(b);
  }
  if (!relations.length) $('relations').innerHTML = '<p class="hint">No matching relations. Try a schema or relation name.</p>';
}
function chooseRelation(rel: RelationSummary) {
  stopRepeating(); current = rel; view = rel.method === 'btree' ? 'tree' : 'heap';
  focusRoot = undefined; block = 0; mapStart = 0; baseline = undefined;
  $<HTMLDetailsElement>('relation-picker').open = false; renderRelations(); run(load);
}
function renderControls() {
  document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => { b.classList.toggle('active', b.dataset.view === view); b.disabled = b.dataset.view === 'tree' ? current?.method !== 'btree' : b.dataset.view === 'heap' ? current?.method !== 'heap' : b.dataset.view === 'map' ? !current : false; });
  if (view === 'wal') return;
  const controls = $('view-controls');
  if (view === 'tree') {
    controls.innerHTML = `<label>Levels <select id="depth">${[1, 2, 3, 4].map(d => `<option ${d === depth ? 'selected' : ''}>${d}</option>`).join('')}</select></label><details class="popover" id="key-options"><summary>Keys</summary><div class="menu"><label title="Readable values when the stored type is supported; otherwise raw bytes.">Keys <select id="endian"><option value="auto">Values</option><option value="raw">Raw bytes</option></select></label></div></details>`;
    $<HTMLSelectElement>('endian').value = endian;
    $('depth').onchange = () => { depth = Number($<HTMLSelectElement>('depth').value); run(load); };
    $('endian').onchange = () => { endian = $<HTMLSelectElement>('endian').value as typeof endian; writeLocation(); renderTree(); if (selected !== undefined) { const n = tree?.nodes.find(n => n.block === selected); if (n) inspectNode(n); } };
  } else {
    controls.innerHTML = `<button id="prev" aria-label="Previous ${view === 'heap' ? 'page' : 'range'}">←</button><label>${view === 'heap' ? 'Block' : 'From block'} <input id="block" type="number" min="0" step="1" value="${view === 'heap' ? block : mapStart}"></label><button id="go">Go</button><button id="next" aria-label="Next ${view === 'heap' ? 'page' : 'range'}">→</button>`;
    $('go').onclick = () => { const v = Number($<HTMLInputElement>('block').value); if (!Number.isSafeInteger(v) || v < 0) { fail(new Error('Enter a non-negative block number.')); return; } if (view === 'heap') block = v; else mapStart = v; run(load); };
    $('block').onkeydown = e => { if (e.key === 'Enter') $('go').click(); };
    $('prev').onclick = () => { if (view === 'heap') block = Math.max(0, block - 1); else mapStart = Math.max(0, mapStart - 128); run(load); };
    $('next').onclick = () => { if (view === 'heap') block++; else mapStart += 128; run(load); };
    $<HTMLButtonElement>('prev').disabled = (view === 'heap' ? block : mapStart) === 0;
    const pages = view === 'heap' ? heap?.relation.pages : map?.relation.pages;
    $<HTMLButtonElement>('next').disabled = pages !== undefined && (view === 'heap' ? block + 1 : mapStart + 128) >= pages;
  }
}
function metrics(values: [string, string, string?][]) { $('metrics').innerHTML = values.map(([label, value, unit]) => `<div class="metric"><small>${esc(label)}</small><strong>${esc(value)}</strong><em>${esc(unit ?? '')}</em></div>`).join(''); }
function writeLocation(replace = false) {
  const search = locationSearch({ view, oid: current?.oid, block, start: mapStart,
    root: focusRoot, depth, keys: endian === 'raw' ? 'raw' : 'auto',
    walMode: walSettings.mode, filter: view === 'home' ? $<HTMLInputElement>('home-search').value : walSettings.filter });
  if (location.search !== search) history[replace ? 'replaceState' : 'pushState'](null, '', '/' + search);
}
async function restoreLocation() {
  const id = ++requestId; searchId++; clearTimeout(filterTimer); stopRepeating(); walView.deactivate();
  try {
    const state = readLocation(location.search);
    const rel = state.oid ? (await api('relations', { oid: state.oid }))[0] : undefined;
    if (id !== requestId) return;
    if (state.oid && !rel) throw new Error('The relation in this URL no longer exists or is not inspectable.');
    if (state.view === 'tree' && rel?.method !== 'btree') throw new Error('This URL requires a B-tree index.');
    if (state.view === 'heap' && rel?.method !== 'heap') throw new Error('This URL requires a heap table.');
    current = rel; view = state.view; block = state.block; mapStart = state.start;
    focusRoot = state.root; depth = state.depth; endian = state.keys; baseline = undefined;
    walSettings = { mode: state.walMode, filter: state.filter };
    $<HTMLInputElement>('home-search').value = view === 'home' ? state.filter : '';
    renderRelations(); writeLocation(true); await load(false);
  } catch (e) {
    if (id !== requestId) return;
    current = undefined; view = 'home'; await load(false); fail(e);
  }
}
window.addEventListener('popstate', () => run(restoreLocation));
async function load(updateLocation = true) {
  if (updateLocation) writeLocation();
  searchId++; clearTimeout(filterTimer);
  document.querySelector('main')!.classList.toggle('home', view === 'home');
  $('home').hidden = view !== 'home'; $('workarea').hidden = view === 'home';
  $('title').textContent = current ? `${current.schema}.${current.name}` : 'Choose relation';
  if (view === 'home') {
    const id = ++requestId; walView.deactivate(); emptyInspector(); snapshot = undefined;
    $('error').hidden = true; $('view-controls').replaceChildren();
    const result = await api('relations', { q: $<HTMLInputElement>('home-search').value });
    if (id !== requestId) return; relations = result; renderRelations(); return;
  }
  if (view === 'wal') { requestId++; $('error').hidden = true; renderControls(); emptyInspector(); scene = undefined; $('canvas-controls').hidden = true; $('breadcrumbs').textContent = 'Physical WAL · current cluster timeline'; $('legend').textContent = ''; $('metrics').replaceChildren(); $('footnote').textContent = 'Physical WAL is cluster-wide. Logical changes belong to the connected database and appear after commit.'; await walView.activate(walSettings); return; }
  walView.deactivate();
  if (!current) return;
  const id = ++requestId; detailId++; $('error').hidden = true; $('canvas').classList.add('loading');
  $('title').textContent = `${current.schema}.${current.name}`;
  renderControls(); emptyInspector();
  try {
    if (view === 'tree') {
      const next = await api('tree', { oid: current.oid, depth, root: focusRoot }); if (id !== requestId) return;
      changed = new Set();
      if (baseline?.relation.oid === next.relation.oid) {
        for (const n of next.nodes) { const before = baseline.nodes.find(p => p.block === n.block); if (!before || JSON.stringify(before) !== JSON.stringify(n)) changed.add(n.block); }
      }
      tree = next; initialNodes = new Set(next.nodes.map(n => n.block)); expanded.clear(); snapshot = next; renderTree();
      const used = next.nodes.reduce((sum, n) => sum + 1 - n.stats.free_size / n.stats.page_size, 0) / (next.nodes.length || 1);
      metrics([['TREE HEIGHT', String(next.meta.level + 1), 'levels'], ['INDEX SIZE', (next.relation.bytes / 1024).toFixed(0), 'KiB'], ['PAGES IN VIEW', String(next.nodes.length), `/ ${next.relation.pages}`], ['SHOWN PAGE USAGE', Math.round(used * 100) + '%']]);
      $('footnote').textContent = `Read ${new Date(next.capturedAt).toLocaleTimeString()} · ${baseline ? `${changed.size} shown pages changed · ` : ''}Physical reads may span concurrent changes`;
    } else if (view === 'heap') {
      const next = await api('heap', { oid: current.oid, block }); if (id !== requestId) return;
      heap = next; snapshot = next; renderHeap();
      metrics([['BLOCK', String(block), `/ ${next.relation.pages}`], ['PAGE SIZE', String(next.header.pagesize), 'bytes'], ['LINE POINTERS', String(next.items.length)], ['FREE SPACE', fmt(next.header.upper - next.header.lower), 'bytes']]);
      $('footnote').textContent = 'A single page image · Tuple presence does not imply MVCC visibility';
    } else {
      const next = await api('map', { oid: current.oid, start: mapStart }); if (id !== requestId) return;
      map = next; snapshot = next; renderMap();
      metrics([['RELATION PAGES', fmt(next.relation.pages)], ['PAGES SHOWN', String(next.pages.length)], ['RELATION SIZE', (next.relation.bytes / 1024).toFixed(0), 'KiB']]);
      $('footnote').textContent = 'Bounded to 128 pages per range · Occupancy is physical space, not bloat';
    }
    renderControls();
  } catch (e) { if (id === requestId) { snapshot = undefined; $('canvas').innerHTML = '<div class="blank">This view could not be loaded. Check the message above, then refresh.</div>'; fail(e); } }
  finally { if (id === requestId) $('canvas').classList.remove('loading'); }
}
const NS = 'http://www.w3.org/2000/svg';
function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const el = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v)); if (text !== undefined) el.textContent = text; return el;
}
interface Layout { node: BtreeNode; x: number; y: number; children: Layout[]; width: number; boxWidth: number }
let scene: SVGGElement | undefined, scale = 1, tx = 0, ty = 0, naturalWidth = 0, naturalHeight = 0;
const nodeHeight = 52;
const expanded = new Map<number, number>();
let initialNodes = new Set<number>();
let expanding = false;
function transform() { scene?.setAttribute('transform', `translate(${tx},${ty}) scale(${scale})`); $('zoom-label').textContent = Math.round(scale * 100) + '%'; }
function fit() {
  if (!scene) return;
  const r = $('canvas').getBoundingClientRect(); scale = Math.min(1.25, (r.width - 48) / Math.max(1, naturalWidth), (r.height - 40) / Math.max(1, naturalHeight));
  tx = (r.width - naturalWidth * scale) / 2; ty = Math.max(20, (r.height - naturalHeight * scale) / 2); transform();
}
function zoom(factor: number, x = $('canvas').clientWidth / 2, y = $('canvas').clientHeight / 2) { const next = Math.min(2.5, Math.max(.15, scale * factor)); tx = x - (x - tx) * next / scale; ty = y - (y - ty) * next / scale; scale = next; transform(); }
function label(item: IndexItem) { return keyLabel(item, tree?.columns.length === 1 ? tree.columns[0]?.type : undefined, endian); }
interface KeySlot { item?: IndexItem; x: number; width: number }
function keySlots(n: BtreeNode): { slots: KeySlot[]; width: number } {
  const entries = n.items.filter(i => !i.highKey), count = expanded.get(n.block) ?? 3;
  const shown = sample(entries, count), high = n.items.find(i => i.highKey);
  const parts: (IndexItem | undefined)[] = high ? [high, ...shown] : [...shown];
  if (entries.length > shown.length) parts.splice(parts.length - 1, 0, undefined);
  let x = 10;
  const slots = parts.map(item => { const slot = { item, x, width: item ? Math.max(66, Math.min(142, label(item).length * 7.3 + 16)) : 24 }; x += slot.width + 6; return slot; });
  return { slots, width: Math.max(110, x + 4) };
}
async function expandNode(n: BtreeNode) {
  if (!tree || expanding) return;
  const captured = tree, id = requestId;
  const total = n.items.filter(i => !i.highKey).length;
  const count = Math.min(total, (expanded.get(n.block) ?? 3) + 12);
  const children = sample(n.children, Math.max(3, count));
  const missing = children.filter(block => !captured.nodes.some(n => n.block === block));
  if (captured.nodes.length + missing.length > 200) { fail(new Error('200 pages loaded. Collapse or explore a subtree to continue.')); return; }
  expanding = true;
  try {
    // Fetch in small batches, keeping the database pool responsive.
    const fetched: BtreeNode[] = [];
    for (let i = 0; i < missing.length; i += 4) fetched.push(...await Promise.all(missing.slice(i, i + 4).map(block => api('node', { oid: captured.relation.oid, block }))));
    if (tree !== captured || id !== requestId) return;
    captured.nodes.push(...fetched); expanded.set(n.block, Math.max(3, count)); renderTree();
  } finally { expanding = false; }
}
function renderTree() {
  if (!tree) return;
  const data = tree, canvas = $('canvas'); canvas.className = 'tree'; canvas.replaceChildren();
  $('canvas-controls').hidden = false;
  $('legend').textContent = '⋯ expand · click a page for attributes';
  $('breadcrumbs').replaceChildren();
  if (focusRoot !== undefined) button('↑ Entire tree', () => { focusRoot = undefined; run(load); }, $('breadcrumbs'));
  if (!data.root) { canvas.innerHTML = '<div class="blank">An empty B-tree.<br><br>The metapage has no root yet.</div>'; button('Metapage', () => setDetails('<h3>Metapage</h3>' + fields(data.meta)), canvas); scene = undefined; return; }
  const nodes = new Map(data.nodes.map(n => [n.block, n])), seen = new Set<number>();
  function layout(n: BtreeNode, d: number): Layout {
    seen.add(n.block);
    const children = sample(n.children, expanded.get(n.block) ?? 3).flatMap(id => {
      const child = nodes.get(id);
      return child && (expanded.has(n.block) || initialNodes.has(id)) && !seen.has(id) ? [layout(child, d + 1)] : [];
    });
    const boxWidth = keySlots(n).width;
    const width = Math.max(boxWidth, children.reduce((sum, child) => sum + child.width, 0) + Math.max(0, children.length - 1) * 50);
    return { node: n, x: 0, y: 72 + d * 170, children, width, boxWidth };
  }
  const rootNode = nodes.get(data.root); if (!rootNode) return;
  const root = layout(rootNode, 0);
  function place(l: Layout, start: number) { l.x = start + l.width / 2 - l.boxWidth / 2; let left = start; for (const child of l.children) { place(child, left); left += child.width + 50; } }
  place(root, 0);
  const positions = new Map<number, Layout>();
  function collect(l: Layout) { positions.set(l.node.block, l); l.children.forEach(collect); } collect(root);
  naturalWidth = root.width; naturalHeight = Math.max(...[...positions.values()].map(l => l.y + nodeHeight + (l.node.leaf ? 78 : 40)));
  const svg = svgEl('svg', { role: 'img', 'aria-label': `B-tree overview, ${positions.size} pages shown` });
  const defs = svgEl('defs');
  const marker = svgEl('marker', { id: 'arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' });
  marker.append(svgEl('path', { d: 'M1,1 L7,4 L1,7', fill: 'none', stroke: '#111' })); defs.append(marker); svg.append(defs);
  scene = svgEl('g'); svg.append(scene); canvas.append(svg);
  const edgeLayer = svgEl('g'); scene.append(edgeLayer);
  for (const l of positions.values()) {
    for (const child of l.children) {
      const slot = keySlots(l.node).slots.find(s => s.item?.child === child.node.block);
      const x1 = l.x + (slot ? slot.x + slot.width / 2 : l.boxWidth / 2), y1 = l.y + nodeHeight;
      const x2 = child.x + child.boxWidth / 2, y2 = child.y - 2;
      edgeLayer.append(svgEl('path', { class: 'edge', 'marker-end': 'url(#arrow)', d: `M${x1},${y1} C${x1},${y1 + 38} ${x2},${y2 - 38} ${x2},${y2}` }));
    }
    const next = positions.get(l.node.stats.btpo_next);
    if (next && next.y === l.y && next.x > l.x) edgeLayer.append(svgEl('path', { class: 'sibling', 'marker-start': 'url(#arrow)', 'marker-end': 'url(#arrow)', d: `M${l.x + l.boxWidth + 2},${l.y + 26} L${next.x - 2},${next.y + 26}` }));
  }
  const center = root.x + root.boxWidth / 2;
  const meta = svgEl('g', { class: 'meta node', tabindex: 0, role: 'button', 'aria-label': 'Inspect metapage' });
  meta.append(svgEl('rect', { x: center - 55, y: 0, width: 110, height: 30 }), svgEl('text', { x: center, y: 20, 'text-anchor': 'middle' }, focusRoot === undefined ? 'Metapage' : `Subtree ${focusRoot}`));
  const inspectMeta = () => setDetails('<h3>Metapage</h3>' + fields(data.meta));
  meta.onclick = inspectMeta; meta.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspectMeta(); } }; scene.append(meta);
  scene.append(svgEl('path', { class: 'edge', 'marker-end': 'url(#arrow)', d: `M${center},30 V70` }));
  for (const l of positions.values()) drawNode(l);
  function control(text: string, x: number, y: number, name: string, activate: () => void) {
    const g = svgEl('g', { class: 'gap node', tabindex: 0, role: 'button', 'aria-label': name });
    g.append(svgEl('rect', { x: x - 65, y: y - 13, width: 130, height: 20, fill: 'white' }), svgEl('text', { x, y, 'text-anchor': 'middle' }, text));
    g.onclick = () => { if (!dragMoved) activate(); }; g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activate(); } }; scene!.append(g);
  }
  function drawNode(l: Layout) {
    const n = l.node, g = svgEl('g', { class: `node${selected === n.block ? ' selected' : ''}${changed.has(n.block) ? ' changed' : ''}`, transform: `translate(${l.x},${l.y})`, tabindex: 0, role: 'button', 'aria-label': `Inspect ${n.leaf ? 'leaf' : 'internal'} block ${n.block}`, 'data-block': n.block });
    g.append(svgEl('rect', { class: 'card', width: l.boxWidth, height: nodeHeight }));
    g.append(svgEl('text', { x: 0, y: -9, class: 'sub' }, `${n.block === data.meta.root ? 'Root' : n.leaf ? 'Leaf' : 'Internal'} ${n.block}`));
    const slots = keySlots(n).slots;
    for (const slot of slots) {
      if (!slot.item) {
        const more = svgEl('g', { tabindex: 0, role: 'button', 'aria-label': `Expand entries of block ${n.block}` });
        more.append(svgEl('rect', { x: slot.x, y: 10, width: slot.width, height: 32, fill: 'transparent' }), svgEl('text', { x: slot.x + slot.width / 2, y: 30, 'text-anchor': 'middle' }, '⋯'));
        more.onclick = e => { e.stopPropagation(); run(() => expandNode(n)); }; more.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); run(() => expandNode(n)); } }; g.append(more); continue;
      }
      const item = slot.item, fullLabel = label(item), limit = Math.floor((slot.width - 12) / 7.3), short = fullLabel.length > limit ? fullLabel.slice(0, limit - 1) + '…' : fullLabel;
      g.append(svgEl('rect', { class: `key-box${item.highKey ? ' high-key' : ''}`, x: slot.x, y: 10, width: slot.width, height: 32, rx: 5 }));
      const t = svgEl('text', { class: 'key', x: slot.x + slot.width / 2, y: 30, 'text-anchor': 'middle' }, short);
      g.append(t, svgEl('title', {}, `Block ${n.block}${item.highKey ? ' high key' : ''}: ${fullLabel}`));
      if (n.leaf && !item.highKey && item.heapTids.length) {
        const x = l.x + slot.x + slot.width / 2, y = l.y + 95;
        scene!.append(svgEl('path', { class: 'edge', 'marker-end': 'url(#arrow)', d: `M${x},${l.y + nodeHeight} V${y - 2}` }));
        const tid = svgEl('g', { class: 'tid node', tabindex: 0, role: 'button', 'aria-label': `Heap pointers for block ${n.block} entry ${item.itemoffset}` });
        tid.append(svgEl('rect', { x: x - 34, y, width: 68, height: 26, rx: 5 }), svgEl('text', { x, y: y + 17, 'text-anchor': 'middle' }, item.heapTids.length > 1 ? `${item.heapTids.length} TIDs` : item.heapTids[0]!));
        const follow = () => item.heapTids.length > 1 ? inspectNode(n) : run(() => followTid(item.heapTids[0]!));
        tid.onclick = follow; tid.onkeydown = e => { if (e.key === 'Enter') follow(); }; scene!.append(tid);
      }
    }
    g.onclick = () => { if (!dragMoved) inspectNode(n); }; g.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspectNode(n); } }; scene!.append(g);
    const missing = n.children.length - l.children.length;
    if (expanded.has(n.block)) control('Collapse', l.x + l.boxWidth / 2, l.y + 77, `Collapse block ${n.block}`, () => { expanded.delete(n.block); renderTree(); });
    if (missing > 0) control(`+ ${missing} more…`, l.x + l.boxWidth / 2 + (expanded.has(n.block) ? 130 : 0), l.y + 77, `Expand ${missing} branches of block ${n.block}`, () => run(() => expandNode(n)));
  }
  fit();
}
function inspectNode(n: BtreeNode) {
  selected = n.block; detailId++;
  document.querySelectorAll<SVGGElement>('.node[data-block]').forEach(el => el.classList.toggle('selected', Number(el.dataset.block) === n.block));
  setDetails(`<span class="pill">${n.leaf ? 'LEAF PAGE' : 'INTERNAL PAGE'} · LEVEL ${n.level}</span><h3>Block ${n.block}</h3><div class="actions" id="node-actions"></div>${fields({ 'Space used': Math.round((1 - n.stats.free_size / n.stats.page_size) * 100) + '%', 'Free bytes': n.stats.free_size, 'Live items': n.stats.live_items, 'Dead items': n.stats.dead_items, 'Left sibling': n.stats.btpo_prev || 'none', 'Right sibling': n.stats.btpo_next || 'none' })}<details><summary>All page statistics</summary>${fields(n.stats)}</details><h4>ENTRIES <span class="hint">${n.items.length} total</span></h4><input id="item-search" placeholder="Filter bytes, TID or child…" aria-label="Filter page entries" style="width:100%"><div id="items"></div>`);
  const actions = $('node-actions');
  if (!n.leaf) button('Explore subtree ↗', () => { stopRepeating(); focusRoot = n.block; run(load); }, actions);
  for (const [label, target] of [['← Left', n.stats.btpo_prev], ['Right →', n.stats.btpo_next]] as const) if (target) button(label, () => run(() => inspectBlock(target)), actions);
  let shown = 30;
  const renderItems = () => {
    const filter = $<HTMLInputElement>('item-search').value.toLowerCase();
    const items = n.items.filter(i => `${i.data} ${i.ctid} ${i.child ?? ''} ${label(i)} ${i.heapTids.join(' ')}`.toLowerCase().includes(filter));
    $('items').replaceChildren();
    for (const item of items.slice(0, shown)) {
      const div = document.createElement('div'); div.className = 'item';
      div.innerHTML = `<span class="hint">#${item.itemoffset} · ${item.highKey ? 'HIGH KEY' : item.minusInfinity ? 'FIRST DOWNLINK' : item.tids ? 'POSTING LIST' : item.dead ? 'DEAD' : 'ENTRY'} · ${item.itemlen} B</span><code>${esc(label(item))}</code>`;
      if (item.child !== null) button(`↳ Block ${item.child}`, () => run(() => inspectBlock(item.child!)), div);
      for (const tid of item.heapTids.slice(0, 3)) button(`Heap ${tid} ↗`, () => run(() => followTid(tid)), div);
      const full = document.createElement('details'); full.innerHTML = `<summary>Raw entry${item.heapTids.length > 3 ? ` · ${item.heapTids.length} TIDs` : ''}</summary><pre>${esc(JSON.stringify(item, null, 2))}</pre>`; div.append(full);
      $('items').append(div);
    }
    if (items.length > shown) button(`Show next 30 (${items.length - shown} remaining)`, () => { shown += 30; renderItems(); }, $('items'));
    if (shown > 30) button('Show fewer entries', () => { shown = 30; renderItems(); }, $('items'));
    if (!items.length) $('items').innerHTML = '<p>No matching entries.</p>';
  };
  $('item-search').oninput = () => { shown = 30; renderItems(); }; renderItems();
}
async function inspectBlock(target: number) { const id = ++detailId; const oid = current?.oid; if (!oid) return; const n = await api('node', { oid, block: target }); if (id === detailId && oid === current?.oid && view === 'tree') inspectNode(n); }
async function followTid(tid: string) {
  const tableOid = tree?.relation.table_oid, targetBlock = tidBlock(tid); if (!tableOid || targetBlock === null) return;
  // A filtered relation list may omit the heap; fetch the catalog again if necessary.
  let rel = relations.find(r => r.oid === tableOid);
  if (!rel) rel = (await api('relations')).find(r => r.oid === tableOid);
  if (!rel) { fail(new Error('Heap relation is outside the catalog result. Search for its table name.')); return; }
  current = rel; view = 'heap'; block = targetBlock; baseline = undefined; renderRelations(); await load();
  const lp = Number(tid.split(',')[1]?.replace(')', '')); const item = heap?.items.find(i => i.lp === lp); if (item) inspectTuple(item);
}
function renderHeap() {
  if (!heap) return; const h = heap;
  scene = undefined; $('canvas-controls').hidden = true; $('canvas').className = ''; $('breadcrumbs').textContent = `${h.relation.qualified} / main / block ${h.block}`;
  $('legend').innerHTML = '<span><i class="dot header"></i>Header</span><span><i class="dot internal"></i>Pointers</span><span><i class="dot tuple"></i>Tuples</span><span><i class="dot free"></i>Free</span>';
  $('canvas').innerHTML = `<div class="heap-wrap"><p>16 bytes per cell</p><div class="heap-strip"><span class="pointers" style="width:${h.header.lower / h.header.pagesize * 100}%"></span><span class="free" style="width:${(h.header.upper - h.header.lower) / h.header.pagesize * 100}%">${fmt(h.header.upper - h.header.lower)} bytes free</span><span class="used" style="width:${(h.header.pagesize - h.header.upper) / h.header.pagesize * 100}%">Tuple storage</span></div><div class="byte-grid" id="bytes"></div><details id="line-pointers"><summary>Line pointers (${h.items.length})</summary><div class="actions" id="tuple-buttons"></div></details></div>`;
  for (let offset = 0; offset < h.header.pagesize; offset += 16) {
    const b = document.createElement('button'); b.className = 'byte-cell';
    const tuple = h.items.find(i => i.lp_flags === 1 && i.lp_len > 0 && offset < i.lp_off + i.lp_len && offset + 16 > i.lp_off);
    let kind = 'Free / unallocated';
    if (offset < 24) { b.classList.add('header'); kind = 'Page header'; }
    else if (offset < h.header.lower) { b.classList.add(Math.floor((offset - 24) / 16) % 2 ? 'pointer-alt' : 'pointer'); kind = 'Line pointers'; }
    else if (tuple) { const relative = offset - tuple.lp_off; const isHeader = relative < 23; const isBitmap = !isHeader && relative < (tuple.t_hoff ?? 24) && tuple.t_bits !== null; b.classList.add(isHeader ? 'tuple-header' : isBitmap ? 'bitmap' : 'tuple'); kind = `Tuple ${tuple.lp}${isHeader ? ' header' : isBitmap ? ' bitmap / padding' : ' data'}`; }
    b.title = `${kind} · bytes ${offset}–${offset + 15}${tuple?.values?.length ? '\n' + tuple.values.map(v => `${v.name}: ${v.value ?? (v.state === 'absent' ? 'not stored' : 'raw')}`).join(' · ') : ''}`; b.setAttribute('aria-label', b.title);
    b.onclick = () => { document.querySelectorAll('.byte-cell.selected').forEach(c => c.classList.remove('selected')); b.classList.add('selected');
      if (tuple && offset >= h.header.lower) inspectTuple(tuple);
      else { setDetails(`<h3>${esc(kind)}</h3>${offset < 24 ? fields(h.header) : `<p>Byte offset ${offset}.</p>`}<h4>BYTES ${offset}–${offset + 15}</h4><pre>${esc(h.raw.slice(offset * 2, (offset + 16) * 2).match(/../g)?.join(' '))}</pre>`); }
    }; $('bytes').append(b);
  }
  renderHeapOverlays();
  for (const i of h.items) {
    const b = document.createElement('button'); b.textContent = `${i.lp} · ${['unused', 'normal', 'redirect', 'dead'][i.lp_flags] ?? 'unknown'}`;
    b.dataset.pointer = String(i.lp); b.setAttribute('aria-pressed', 'false'); b.onclick = () => inspectTuple(i); $('tuple-buttons').append(b);
  }
}
function heapValueLabel(item: HeapItem) {
  return item.values?.map(v => v.value ?? (v.state === 'absent' ? 'not stored' : 'raw')).join(', ') ?? '';
}
function renderHeapOverlays() {
  const grid = document.getElementById('bytes');
  if (view !== 'heap' || !heap || !grid) return;
  grid.querySelectorAll('.heap-value, .heap-pointer, .tuple-outline').forEach(label => label.remove());
  const cells = [...grid.querySelectorAll<HTMLElement>('.byte-cell')];
  const rectangles = (start: number, end: number) => {
    const rows: { left: number; top: number; right: number; height: number }[] = [];
    if (start < 0 || end > heap!.header.pagesize || end <= start) return rows;
    for (let i = Math.floor(start / 16); i < Math.ceil(end / 16); i++) {
      const cell = cells[i]; if (!cell) continue;
      const left = cell.offsetLeft + Math.max(0, start - i * 16) / 16 * cell.offsetWidth;
      const right = cell.offsetLeft + Math.min(16, end - i * 16) / 16 * cell.offsetWidth;
      const row = rows.at(-1);
      if (row?.top === cell.offsetTop) row.right = right;
      else rows.push({ left, right, top: cell.offsetTop, height: cell.offsetHeight });
    }
    return rows;
  };
  const position = (el: HTMLElement, r: ReturnType<typeof rectangles>[number]) => {
    Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.right - r.left}px`, height: `${r.height}px` });
  };
  for (const item of heap.items) {
    const pointerStart = 24 + (item.lp - 1) * 4;
    for (const rect of rectangles(pointerStart, pointerStart + 4)) {
      const pointer = document.createElement('button'); pointer.className = 'heap-pointer';
      pointer.dataset.pointer = String(item.lp); pointer.setAttribute('aria-label', `Line pointer ${item.lp}`);
      pointer.title = `Line pointer ${item.lp} · ${['unused', 'normal', 'redirect', 'dead'][item.lp_flags] ?? 'unknown'}`;
      pointer.setAttribute('aria-pressed', String(selectedHeap === item.lp));
      pointer.onclick = () => inspectTuple(item); position(pointer, rect); grid.append(pointer);
    }
    const text = heapValueLabel(item);
    if (item.lp_flags !== 1 || !text) continue;
    // Choose the longest row segment in this tuple's data, never span a row
    // boundary or overwrite another tuple. The byte cells remain clickable.
    const start = item.lp_off + (item.t_hoff ?? 0), end = item.lp_off + item.lp_len;
    if (end <= start) continue;
    const first = Math.ceil(start / 16), last = Math.floor(end / 16) - 1;
    let best: HTMLElement[] = [], run: HTMLElement[] = [];
    const candidates = first <= last ? cells.slice(first, last + 1) : cells.slice(Math.floor(start / 16), Math.floor(start / 16) + 1);
    for (const cell of candidates) {
      if (run.length && run[0]!.offsetTop !== cell.offsetTop) run = [];
      run.push(cell); if (run.length > best.length) best = [...run];
    }
    if (!best.length) continue;
    const left = best[0]!, right = best.at(-1)!;
    const label = document.createElement('span'); label.className = 'heap-value'; label.textContent = text;
    label.dataset.lp = String(item.lp); label.setAttribute('aria-hidden', 'true');
    label.style.left = `${left.offsetLeft}px`; label.style.top = `${left.offsetTop}px`;
    label.style.width = `${right.offsetLeft + right.offsetWidth - left.offsetLeft}px`;
    label.style.height = `${left.offsetHeight}px`; grid.append(label);
  }
  document.querySelectorAll<HTMLElement>('[data-pointer]').forEach(el => el.setAttribute('aria-pressed', String(Number(el.dataset.pointer) === selectedHeap)));
  let target = heap.items.find(i => i.lp === selectedHeap);
  const seen = new Set<number>();
  while (target?.lp_flags === 2 && !seen.has(target.lp)) {
    seen.add(target.lp); target = heap.items.find(i => i.lp === target!.lp_off);
  }
  if (target?.lp_flags === 1 && target.lp_len > 0) {
    for (const rect of rectangles(target.lp_off, target.lp_off + target.lp_len)) {
      const outline = document.createElement('span'); outline.className = 'tuple-outline';
      outline.dataset.lp = String(target.lp); outline.setAttribute('aria-hidden', 'true');
      position(outline, rect); grid.append(outline);
    }
  }
}
new ResizeObserver(renderHeapOverlays).observe($('canvas'));
function inspectTuple(item: HeapItem) {
  if (!heap) return; const h = heap; selectedHeap = item.lp; renderHeapOverlays();
  const raw = item.lp_flags === 1 ? h.raw.slice(item.lp_off * 2, (item.lp_off + item.lp_len) * 2) : '';
  setDetails(`<span class="pill">HEAP TUPLE</span><h3>(${h.block},${item.lp})</h3><div class="actions" id="tuple-actions"></div>${item.values?.length ? '<h4>Values</h4>' + fields(Object.fromEntries(item.values.map(v => [v.name, v.value ?? (v.state === 'absent' ? 'Not stored in this tuple' : `Raw (${v.type})`)]))) : ''}${fields({ State: ['Unused', 'Normal', 'HOT redirect', 'Dead'][item.lp_flags], Offset: item.lp_off, Length: item.lp_len, xmin: item.t_xmin, xmax: item.t_xmax, ctid: item.t_ctid, Flags: [...(item.raw_flags ?? []), ...(item.combined_flags ?? [])] })}<details><summary>All tuple fields & attributes</summary>${fields(item)}</details><details><summary>Tuple bytes · ${raw.length / 2} B</summary><pre>${esc(raw.match(/.{1,32}/g)?.map((s, i) => `${(item.lp_off + i * 16).toString(16).padStart(4, '0')}  ${s.match(/../g)?.join(' ')}`).join('\n') ?? '')}</pre></details>`);
  if (item.lp_flags === 2) button(`Follow redirect → ${item.lp_off}`, () => { const next = h.items.find(i => i.lp === item.lp_off); if (next) inspectTuple(next); }, $('tuple-actions'));
  if (item.t_ctid && item.t_ctid !== `(${h.block},${item.lp})`) button('Follow ctid →', () => run(async () => { const nextBlock = tidBlock(item.t_ctid!); if (nextBlock === null) return; block = nextBlock; await load(); const lp = Number(item.t_ctid!.split(',')[1]?.replace(')', '')); const next = heap?.items.find(i => i.lp === lp); if (next) inspectTuple(next); }), $('tuple-actions'));
}
function renderMap() {
  if (!map) return; const m = map; scene = undefined; $('canvas-controls').hidden = true; $('canvas').className = '';
  $('breadcrumbs').textContent = `${m.relation.qualified} / main fork`;
  $('legend').innerHTML = '<span>Space used: white → gray</span>';
  $('canvas').innerHTML = '<div class="map-grid" id="map-grid"></div><p class="map-description">Color shows occupied space. Select a block to open its page.</p>';
  for (const page of m.pages) {
    const b = document.createElement('button'); b.className = 'page-cell'; b.style.setProperty('--fill', `${Math.round((1 - page.free / page.size) * 85) + 10}%`); b.textContent = String(page.block); b.title = `Block ${page.block} · ${page.kind} · ${page.free} bytes free`;
    b.onclick = () => { setDetails(`<h3>Block ${page.block}</h3>${fields(page)}<div class="actions" id="map-actions"></div>`);
      button('Open page ↗', () => { if (m.relation.method === 'heap') { view = 'heap'; block = page.block; } else { view = 'tree'; focusRoot = page.block || undefined; } run(load); }, $('map-actions')); };
    $('map-grid').append(b);
  }
  if (!m.pages.length) $('map-grid').innerHTML = '<p class="hint">No pages in this range. Empty relations have no allocated heap pages.</p>';
}
let drag: { x: number; y: number; tx: number; ty: number } | undefined, dragMoved = false;
$('canvas').addEventListener('pointerdown', e => { if (view !== 'tree' || e.button !== 0) return; dragMoved = false; drag = { x: e.clientX, y: e.clientY, tx, ty }; });
window.addEventListener('pointermove', e => { if (!drag) return; if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 4) dragMoved = true; if (dragMoved) { tx = drag.tx + e.clientX - drag.x; ty = drag.ty + e.clientY - drag.y; transform(); } });
window.addEventListener('pointerup', () => { drag = undefined; });
$('canvas').addEventListener('wheel', e => { if (view !== 'tree') return; e.preventDefault(); const rect = $('canvas').getBoundingClientRect(); zoom(Math.exp(-e.deltaY * .001), e.clientX - rect.left, e.clientY - rect.top); }, { passive: false });
$('zoom-in').onclick = () => zoom(1.2); $('zoom-out').onclick = () => zoom(1 / 1.2); $('fit').onclick = fit;
new ResizeObserver(() => { if (view === 'tree') fit(); }).observe($('canvas'));
$('clear-selection').onclick = emptyInspector;
$('refresh').onclick = () => run(load);
$('pin-baseline').onclick = () => { if (!tree || view !== 'tree') return; baseline = structuredClone(tree); $('notice').hidden = false; $('notice').textContent = 'Baseline pinned. Refresh to compare.'; $<HTMLDetailsElement>('tools').open = false; };
document.addEventListener('click', e => { for (const menu of document.querySelectorAll<HTMLDetailsElement>('.popover[open]')) if (!menu.contains(e.target as Node)) menu.open = false; });
document.addEventListener('keydown', e => { if (e.key === 'Escape') { document.querySelectorAll<HTMLDetailsElement>('.popover[open]').forEach(menu => menu.open = false); emptyInspector(); } });
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach(b => { b.onclick = () => { stopRepeating(); view = b.dataset.view as typeof view; run(load); }; });
function searchRelations(input: HTMLInputElement) { clearTimeout(filterTimer); const id = ++searchId; filterTimer = setTimeout(() => run(async () => { const result = await api('relations', { q: input.value }); if (id === searchId) { relations = result; renderRelations(); if (view === 'home') writeLocation(true); } }), 180); }
$('search').oninput = () => searchRelations($<HTMLInputElement>('search'));
$('home-search').oninput = () => searchRelations($<HTMLInputElement>('home-search'));
$('export').onclick = () => {
  if (!snapshot) { fail(new Error('Load a visualization before exporting.')); return; }
  const blob = new Blob([JSON.stringify({ format: 'pgviz/1', view, exportedAt: new Date().toISOString(), data: snapshot }, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob), a = document.createElement('a'); a.href = url; a.download = `pgviz-${view}-${current?.oid}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
};
let liveCommands = false, commandBusy = false, repeating = false;
let playground: CommandResult | undefined;
let repeatTimer: ReturnType<typeof setTimeout> | undefined;
function stopRepeating() { repeating = false; clearTimeout(repeatTimer); $('repeat-command').textContent = '▶ Repeat'; }
function renderCommands() {
  const select = $<HTMLSelectElement>('command-template');
  const selected = select.value;
  select.replaceChildren();
  for (const t of templates) { const option = document.createElement('option'); option.value = t.id; option.textContent = t.label; option.disabled = !playground ? t.id !== 'create' : t.id === 'create'; select.append(option); }
  select.value = playground ? selected && selected !== 'create' ? selected : 'random' : 'create';
  $('command-scope').textContent = liveCommands ? playground ? `Only ${playground.schema}.keys is modified.` : 'Creates a separate playground table. Your relations are not modified.' : 'Templates need a live PostgreSQL connection (DATABASE_URL).';
  $<HTMLButtonElement>('run-command').disabled = !liveCommands || commandBusy;
  commandPreview();
}
function commandPreview() {
  const command = $<HTMLSelectElement>('command-template').value as Command;
  const template = templates.find(t => t.id === command)!;
  const count = Number($<HTMLInputElement>('command-count').value);
  $<HTMLInputElement>('command-count').disabled = command === 'create' || command === 'vacuum';
  $('command-description').textContent = template.description;
  $('command-sql').textContent = commandSql(command, playground ? `${playground.schema}.keys` : '<playground>.keys', Number.isInteger(count) && count >= 1 && count <= 10000 ? count : template.count);
  $<HTMLButtonElement>('repeat-command').disabled = !liveCommands || command === 'create';
}
async function executeCommand() {
  if (commandBusy) return;
  const command = $<HTMLSelectElement>('command-template').value as Command;
  const count = Number($<HTMLInputElement>('command-count').value);
  if (command !== 'create' && command !== 'vacuum' && (!Number.isInteger(count) || count < 1 || count > 10000)) { stopRepeating(); fail(new Error('Choose 1–10,000 rows.')); return; }
  const viewRequest = requestId;
  commandBusy = true; $<HTMLButtonElement>('run-command').disabled = true;
  $('command-result').textContent = 'Running…';
  try {
    const response = await fetch('/api/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pgviz-Command': '1' }, body: JSON.stringify({ command, count: command === 'create' ? 100 : command === 'vacuum' ? 0 : count }) });
    const result = await response.json() as CommandResult & { error?: string };
    if (!response.ok) throw new Error(result.error ?? 'Command failed.');
    playground = result;
    if (requestId !== viewRequest) { stopRepeating(); $('command-result').textContent = `${result.affected} affected · ${fmt(result.rows)} rows total`; return; }
    const isLab = current?.oid === result.indexOid || current?.oid === result.tableOid;
    if (tree && current?.oid === result.indexOid) baseline = structuredClone(tree);
    if (!isLab) {
      relations = await api('relations', { q: result.schema }); $<HTMLInputElement>('search').value = result.schema;
      current = relations.find(r => r.oid === result.indexOid); view = view === 'wal' ? 'wal' : 'tree'; block = 0; mapStart = 0; focusRoot = undefined; baseline = undefined;
      renderRelations();
    }
    await load();
    $('command-result').textContent = `${result.affected} affected · ${fmt(result.rows)} rows total`;
    $('notice').hidden = false; $('notice').textContent = `${templates.find(t => t.id === command)!.label}: ${result.affected} affected · ${fmt(result.rows)} rows · view refreshed`;
  } catch (e) { stopRepeating(); $('command-result').textContent = 'Command failed.'; fail(e); }
  finally { commandBusy = false; renderCommands(); }
  if (repeating) repeatTimer = setTimeout(() => run(executeCommand), 1000);
}
$('command-template').onchange = () => { stopRepeating(); const t = templates.find(t => t.id === $<HTMLSelectElement>('command-template').value)!; $<HTMLInputElement>('command-count').value = String(t.count || 1000); commandPreview(); };
$('command-count').oninput = commandPreview;
$('commands').addEventListener('toggle', () => { if (!$<HTMLDetailsElement>('commands').open) stopRepeating(); });
$('run-command').onclick = () => { stopRepeating(); run(executeCommand); };
$('repeat-command').onclick = () => { if (repeating) stopRepeating(); else { repeating = true; $('repeat-command').textContent = '■ Stop'; run(executeCommand); } };
// Stop automatic mutations as soon as this tab is hidden or navigates away.
document.addEventListener('visibilitychange', () => { if (document.hidden) { stopRepeating(); void walView.stop(); } });
window.addEventListener('pagehide', () => { stopRepeating(); walView.deactivate(); });
run(async () => {
  const [status, catalog] = await Promise.all([api('status'), api('relations')]); relations = catalog;
  liveCommands = status.mode === 'live'; renderCommands(); $('database').textContent = status.database; $('connection').textContent = `PostgreSQL ${status.version}`; $('mode').textContent = status.mode === 'demo' ? 'Demo' : 'Live';
  if (status.mode !== 'demo' && (!status.pageinspect || !status.superuser)) { $('notice').hidden = false; $('notice').textContent = !status.pageinspect ? 'pageinspect is not installed. Run CREATE EXTENSION pageinspect; in this database as a superuser.' : 'Physical page inspection requires a PostgreSQL superuser connection.'; }
  await restoreLocation();
});
