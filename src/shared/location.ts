import { integer } from './tree';
export type View = 'home' | 'tree' | 'heap' | 'map' | 'wal';
export interface ViewLocation {
  view: View; oid?: number; block: number; start: number; root?: number;
  depth: number; keys: 'auto' | 'raw';
  walMode: 'physical' | 'logical'; filter: string;
}
export function readLocation(search: string): ViewLocation {
  const p = new URLSearchParams(search);
  const view = p.get('view') ?? (p.has('oid') ? 'tree' : 'home');
  if (!['home', 'tree', 'heap', 'map', 'wal'].includes(view)) throw new Error('Unknown visualization in URL.');
  const number = (key: string, fallback: number, min = 0, max = 4294967295) => integer(p.get(key) ?? fallback, key, min, max);
  const oid = p.has('oid') ? number('oid', 0, 1) : undefined;
  if (view !== 'home' && view !== 'wal' && !oid) throw new Error('The visualization URL needs a relation OID.');
  return { view: view as View, oid, block: number('block', 0), start: number('start', 0),
    root: p.has('root') ? number('root', 1, 1) : undefined, depth: number('depth', 2, 1, 4),
    keys: p.get('keys') === 'raw' ? 'raw' : 'auto',
    walMode: p.get('show') === 'logical' ? 'logical' : 'physical', filter: p.get('filter') ?? '' };
}
export function locationSearch(s: ViewLocation): string {
  const p = new URLSearchParams();
  if (s.view === 'home') { if (s.filter) p.set('filter', s.filter); }
  else {
    p.set('view', s.view);
    if (s.oid) p.set('oid', String(s.oid));
    if (s.view === 'tree') {
      if (s.root !== undefined) p.set('root', String(s.root));
      if (s.depth !== 2) p.set('depth', String(s.depth));
      if (s.keys !== 'auto') p.set('keys', s.keys);
    }
    if (s.view === 'heap' && s.block) p.set('block', String(s.block));
    if (s.view === 'map' && s.start) p.set('start', String(s.start));
    if (s.view === 'wal') {
      if (s.walMode !== 'physical') p.set('show', s.walMode);
      if (s.filter) p.set('filter', s.filter);
    }
  }
  return p.size ? '?' + p.toString() : '';
}
