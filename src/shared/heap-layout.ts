import type { HeapItem, HeapPage } from './types';
export interface HeapRegion { start: number; end: number; kind: string; label: string; tuple?: HeapItem }
/** Half-open byte ranges; a grid cell may contain several distinct regions. */
export function heapRegions(page: HeapPage): HeapRegion[] {
  const regions: HeapRegion[] = [];
  const add = (start: number, end: number, kind: string, label: string, tuple?: HeapItem) => {
    if (start >= 0 && end > start && end <= page.header.pagesize) regions.push({ start, end, kind, label, tuple });
  };
  add(0, 24, 'header', 'Page header');
  for (let start = 24; start < page.header.lower; start += 4) {
    const lp = (start - 24) / 4 + 1;
    add(start, Math.min(start + 4, page.header.lower), lp % 2 ? 'pointer' : 'pointer-alt', `Line pointer ${lp}`);
  }
  for (const item of page.items) {
    if (item.lp_flags !== 1 || item.lp_len <= 0) continue;
    const start = item.lp_off, end = start + item.lp_len, hoff = item.t_hoff;
    if (hoff === null || hoff < 23 || hoff > item.lp_len) {
      add(start, end, 'tuple', `Tuple ${item.lp} (unknown header)`, item); continue;
    }
    const data = start + hoff;
    const bitmapEnd = Math.min(data, start + 23 + ((item.t_infomask ?? 0) & 1 ? Math.ceil(((item.t_infomask2 ?? 0) & 0x7ff) / 8) : 0));
    add(start, start + 23, 'tuple-header', `Tuple ${item.lp} header`, item);
    add(start + 23, bitmapEnd, 'bitmap', `Tuple ${item.lp} null bitmap`, item);
    add(bitmapEnd, data, 'padding', `Tuple ${item.lp} header padding`, item);
    add(data, end, 'tuple', `Tuple ${item.lp} data`, item);
  }
  // Gaps inside the storage area are not part of either neighboring tuple.
  // They may be alignment slack or holes left by page maintenance.
  let end = page.header.upper;
  for (const r of [...regions].filter(r => r.tuple).sort((a, b) => a.start - b.start)) {
    if (r.start > end) add(end, r.start, 'storage-gap', 'Unreferenced tuple storage');
    end = Math.max(end, r.end);
  }
  add(end, page.header.special, 'storage-gap', 'Unreferenced tuple storage');
  return regions.sort((a, b) => a.start - b.start);
}
