import { relatedChanges, type LogicalRecord, type PhysicalRecord, type WalBatch, type WalCapture, type WalStatus } from '../shared/wal';
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
interface Options { canvas: HTMLElement; controls: HTMLElement; details: (html: string) => void; snapshot: (data: unknown) => void }
export class WalView {
  private physical: PhysicalRecord[] = [];
  private logical: LogicalRecord[] = [];
  private omitted = 0;
  private capture?: WalCapture;
  private timer?: ReturnType<typeof setTimeout>;
  private mounted = false;
  private generation = 0;
  private busy = false;
  constructor(private options: Options) {}
  private get<T extends HTMLElement = HTMLElement>(id: string) { return document.getElementById(id) as T; }
  private async request<T>(action: string, token?: string): Promise<T> {
    const r = await fetch('/api/wal', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pgviz-Command': '1' }, body: JSON.stringify({ action, token }), keepalive: action === 'stop' });
    const data = await r.json() as T & { error?: string };
    if (!r.ok) throw new Error(data.error ?? 'WAL request failed.'); return data;
  }
  async activate() {
    if (this.mounted) return;
    this.mounted = true; const generation = ++this.generation;
    this.options.canvas.className = 'wal-canvas';
    this.options.controls.innerHTML = '<button id="wal-start">Start capture</button><button id="wal-stop" disabled>Stop</button><button id="wal-clear">Clear</button>';
    this.options.canvas.innerHTML = `<div class="wal-toolbar"><input id="wal-filter" placeholder="Filter relation, transaction or value…" aria-label="Filter WAL"><label>Show <select id="wal-mode"><option value="physical">Physical records</option><option value="logical">Logical changes</option></select></label><label><input id="wal-follow" type="checkbox" checked> Follow</label><span id="wal-count"></span></div><p id="wal-status" role="status">Checking WAL configuration…</p><div class="wal-scroll" id="wal-scroll"><table class="wal-table"><thead id="wal-head"></thead><tbody id="wal-rows"></tbody></table></div>`;
    this.get('wal-start').onclick = () => { void this.start(); };
    this.get('wal-stop').onclick = () => { void this.stop(); };
    this.get('wal-clear').onclick = () => { this.physical = []; this.logical = []; this.omitted = 0; this.render(); };
    this.get('wal-filter').oninput = () => this.render(); this.get('wal-mode').onchange = () => this.render();
    this.render();
    try { const status = await this.request<WalStatus>('status'); if (generation !== this.generation) return; this.get('wal-status').textContent = status.reason; this.get<HTMLButtonElement>('wal-start').disabled = !status.physical; }
    catch (e) { if (generation === this.generation) { this.message(e); this.get<HTMLButtonElement>('wal-start').disabled = true; } }
  }
  deactivate() { this.mounted = false; this.generation++; clearTimeout(this.timer); const capture = this.capture; this.capture = undefined; if (capture) void this.request('stop', capture.token).catch(() => {}); }
  private message(e: unknown) { if (this.mounted) this.get('wal-status').textContent = e instanceof Error ? e.message : String(e); }
  private async start() {
    if (this.busy || this.capture) return;
    this.busy = true; const generation = this.generation;
    this.get<HTMLButtonElement>('wal-start').disabled = true; this.message('Starting capture…');
    try {
      const capture = await this.request<WalCapture>('start');
      if (generation !== this.generation) { await this.request('stop', capture.token); return; }
      this.capture = capture; this.physical = []; this.logical = []; this.omitted = 0;
      this.get<HTMLButtonElement>('wal-stop').disabled = false;
      this.message(capture.note || 'Capturing physical WAL and committed row changes. LSN matches are direct; other matches are by transaction.');
      this.render(); this.timer = setTimeout(() => { void this.poll(); }, 250);
    } catch (e) { this.message(e); }
    finally { this.busy = false; if (this.mounted) this.get<HTMLButtonElement>('wal-start').disabled = !!this.capture; }
  }
  async stop() {
    const capture = this.capture; this.capture = undefined; clearTimeout(this.timer);
    if (capture) { await this.request('stop', capture.token).catch(e => this.message(e)); }
    if (this.mounted) { this.get<HTMLButtonElement>('wal-start').disabled = false; this.get<HTMLButtonElement>('wal-stop').disabled = true; this.message('Stopped. Captured records remain visible.'); }
  }
  private async poll() {
    const capture = this.capture; if (!capture || !this.mounted) return;
    try {
      const batch = await this.request<WalBatch>('poll', capture.token);
      if (this.capture !== capture || !this.mounted) return;
      this.physical.push(...batch.physical); this.logical.push(...batch.logical);
      this.omitted += batch.omittedPhysical + batch.omittedLogical + Math.max(0, this.physical.length - 1000) + Math.max(0, this.logical.length - 1000);
      this.physical = this.physical.slice(-1000); this.logical = this.logical.slice(-1000); this.render();
      this.timer = setTimeout(() => { void this.poll(); }, 1000);
    } catch (e) { await this.stop(); this.message(e); }
  }
  private render() {
    if (!this.mounted) return;
    const filter = this.get<HTMLInputElement>('wal-filter').value.toLowerCase();
    const logicalMode = this.get<HTMLSelectElement>('wal-mode').value === 'logical';
    this.get('wal-head').innerHTML = `<tr><th>LSN / XID</th><th>${logicalMode ? 'Logical change' : 'Physical operation'}</th><th>${logicalMode ? 'Related physical records' : 'Logical changes'}</th></tr>`;
    const body = this.get('wal-rows'); body.replaceChildren();
    const add = (lsn: string, xid: string, physical: string, logical: string, inspect: () => void) => {
      const row = document.createElement('tr'); row.tabIndex = 0; row.setAttribute('role', 'button');
      row.innerHTML = `<td><code>${esc(lsn)}</code><small>XID ${esc(xid)}</small></td><td>${physical}</td><td>${logical}</td>`;
      row.onclick = inspect; row.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); inspect(); } }; body.append(row);
    };
    if (!logicalMode) for (const record of this.physical) {
      const related = relatedChanges(record, this.logical);
      if (filter && !`${JSON.stringify(record)} ${related.changes.map(c => c.data).join(' ')}`.toLowerCase().includes(filter)) continue;
      const logical = related.match === 'lsn' ? `<span class="wal-match">LSN match</span><code>${esc(related.changes[0]!.data)}</code>${related.changes.length > 1 ? `<small>+ ${related.changes.length - 1} changes</small>` : ''}` : related.match === 'transaction' ? `<span class="wal-match">Same transaction · ${related.changes.length} row changes</span><small>Select to inspect; no one-to-one mapping.</small>` : '<span class="hint">No decoded row change in this capture</span>';
      add(record.start_lsn, record.xid, `<strong>${esc(record.summary)}</strong><small>${esc(record.relations.join('; ') || record.resource_manager + ' · ' + record.record_type)}</small>`, logical, () => this.inspect(record, related.changes, related.match));
    }
    else for (const change of this.logical) {
      if (filter && !JSON.stringify(change).toLowerCase().includes(filter)) continue;
      const same = this.physical.filter(p => p.xid !== '0' && p.xid === change.xid);
      add(change.lsn, change.xid, `<code>${esc(change.data)}</code>${change.truncated ? '<small>Text truncated at 4096 characters</small>' : ''}`, `<span class="wal-match">${same.length} physical records in this transaction</span>`, () => this.options.details(`<h3>Logical change</h3><pre>${esc(change.data)}</pre><p>${esc(change.lsn)} · XID ${esc(change.xid)}</p><h4>Same transaction (${same.length})</h4>${same.map(p => `<p><code>${esc(p.start_lsn)}</code><br>${esc(p.summary)}<br><small>${esc(p.relations.join('; '))}</small></p>`).join('')}`));
    }
    if (!body.children.length) body.innerHTML = `<tr><td colspan="3" class="blank">${this.capture ? 'Waiting for matching WAL records. Use Commands or your SQL client to make changes.' : 'Start capture to watch new WAL records.'}</td></tr>`;
    this.get('wal-count').textContent = `${this.physical.length} physical · ${this.logical.length} logical${this.omitted ? ` · ${this.omitted} older records omitted` : ''}`;
    this.options.snapshot({ capture: this.capture, physical: this.physical, logical: this.logical, omitted: this.omitted });
    if (this.get<HTMLInputElement>('wal-follow').checked) { const scroll = this.get('wal-scroll'); scroll.scrollTop = scroll.scrollHeight; }
  }
  private inspect(record: PhysicalRecord, changes: LogicalRecord[], match: string) {
    this.options.details(`<h3>${esc(record.summary)}</h3><p>${esc(record.relations.join('; '))}</p><pre>${esc(JSON.stringify(record, null, 2))}</pre><h4>Logical changes · ${esc(match === 'lsn' ? 'LSN match' : 'same transaction')}</h4>${changes.length ? changes.map(c => `<pre>${esc(c.data)}</pre>`).join('') : '<p>No decoded row changes captured. Index maintenance, vacuum and system records often have none; transactions may also still be uncommitted.</p>'}`);
  }
}
