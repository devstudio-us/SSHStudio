import {
  Component,
  OnDestroy,
  OnInit,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { UnlistenFn } from "@tauri-apps/api/event";
import { MetricsService } from "./metrics.service";
import { HostMetrics } from "./metrics.model";
import { Host } from "./host.model";

type Status = "pending" | "ok" | "error";

/**
 * A dashboard card for one host. Starts the backend poller on init, listens for
 * `metrics-<id>` snapshots, and stops the poller on destroy. All formatting of
 * nullable values into "n/a" happens here.
 */
@Component({
  selector: "app-metrics-card",
  template: `
    <div class="card" [class.offline]="status() === 'error'">
      <header>
        <span class="dot" [class]="status()"></span>
        <span class="name">{{ host().name || host().hostname }}</span>
        <div class="card-actions">
          <button class="icon" type="button" (click)="edit.emit(host())" title="Edit server" aria-label="Edit server">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 20h9" />
              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
            </svg>
          </button>
          <button class="icon danger" type="button" (click)="remove.emit(host())" title="Delete server" aria-label="Delete server">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
              <path d="M10 11v6M14 11v6" />
            </svg>
          </button>
          <button class="add-note" type="button" (click)="addNote.emit(host().id)" title="Add a note for this host">
            + note
          </button>
        </div>
      </header>

      <div class="addr-line">{{ host().user ? host().user + "@" : "" }}{{ host().hostname }}:{{ host().port }}</div>

      @if (host().tags.length > 0 || host().notes) {
        <div class="meta">
          @if (host().tags.length > 0) {
            <div class="tags">
              @for (tag of host().tags; track tag) {
                <span class="tag">{{ tag }}</span>
              }
            </div>
          }
          @if (host().notes) {
            <p class="host-notes">{{ host().notes }}</p>
          }
        </div>
      }

      @if (status() === "error") {
        <p class="msg">{{ metrics()?.error || "Disconnected" }}</p>
      } @else if (status() === "pending") {
        <p class="msg">Connecting…</p>
      }

      <div class="bars" [class.dim]="status() !== 'ok'">
        <div class="bar-row">
          <span class="bar-label">CPU</span>
          <div class="track">
            <div class="fill" [class]="level(cpuPct())" [style.width.%]="cpuPct()"></div>
          </div>
          <span class="bar-val">{{ fmtPct(metrics()?.cpu_percent ?? null) }}</span>
        </div>

        <div class="bar-row">
          <span class="bar-label">RAM</span>
          <div class="track">
            <div class="fill" [class]="level(ramPct())" [style.width.%]="ramPct()"></div>
          </div>
          <span class="bar-val">{{ ramText() }}</span>
        </div>

        <div class="bar-row">
          <span class="bar-label">DISK</span>
          <div class="track">
            <div class="fill" [class]="level(diskPct())" [style.width.%]="diskPct()"></div>
          </div>
          <span class="bar-val">{{ diskText() }}</span>
        </div>
      </div>

      <footer>
        <div>
          <span class="foot-label">Load</span>
          <span class="foot-val">{{ loadText() }}</span>
        </div>
        <div>
          <span class="foot-label">Uptime</span>
          <span class="foot-val">{{ uptimeText() }}</span>
        </div>
      </footer>
    </div>
  `,
  styles: [
    `
      .card {
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 1rem 1.1rem;
        display: flex;
        flex-direction: column;
        gap: 0.8rem;
      }
      .card.offline {
        opacity: 0.85;
      }
      header {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .dot {
        width: 9px;
        height: 9px;
        border-radius: 50%;
        flex-shrink: 0;
        background-color: var(--text-faint);
      }
      .dot.ok {
        background-color: #22c55e;
      }
      .dot.error {
        background-color: var(--danger);
      }
      .dot.pending {
        background-color: #eab308;
      }
      .name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .card-actions {
        margin-left: auto;
        display: flex;
        align-items: center;
        gap: 0.3rem;
        flex-shrink: 0;
      }
      .icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        background: transparent;
        border: none;
        color: var(--text-faint);
      }
      .icon:hover {
        color: var(--text);
        background-color: var(--surface-hover);
      }
      .icon.danger:hover {
        color: var(--danger);
        background-color: var(--danger-soft);
      }
      .add-note {
        padding: 0.2rem 0.5rem;
        font-size: 0.74rem;
        background-color: var(--surface-2);
        border: 1px solid var(--border);
        color: var(--text-muted);
      }
      .add-note:hover {
        color: var(--accent);
        border-color: var(--accent);
      }
      .addr-line {
        margin-top: -0.3rem;
        font-size: 0.8rem;
        color: var(--text-muted);
        font-variant-numeric: tabular-nums;
      }
      .meta {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
      }
      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
      }
      .tag {
        font-size: 0.68rem;
        padding: 0.05rem 0.45rem;
        border-radius: 999px;
        background-color: var(--surface-2);
        color: var(--text-muted);
      }
      .host-notes {
        margin: 0;
        font-size: 0.8rem;
        color: var(--text-muted);
        white-space: pre-wrap;
        padding: 0.4rem 0.55rem;
        background-color: var(--surface-2);
        border-radius: var(--radius-sm);
      }
      .msg {
        margin: 0;
        font-size: 0.82rem;
        color: var(--text-muted);
      }
      .bars {
        display: flex;
        flex-direction: column;
        gap: 0.55rem;
      }
      .bars.dim {
        opacity: 0.4;
      }
      .bar-row {
        display: flex;
        align-items: center;
        gap: 0.6rem;
      }
      .bar-label {
        width: 38px;
        font-size: 0.72rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: var(--text-muted);
      }
      .track {
        flex: 1;
        height: 8px;
        border-radius: 999px;
        background-color: var(--surface-2);
        overflow: hidden;
      }
      .fill {
        height: 100%;
        border-radius: 999px;
        background-color: var(--accent);
        transition: width 0.4s ease;
      }
      .fill.caution {
        background-color: #eab308;
      }
      .fill.high {
        background-color: var(--danger);
      }
      .bar-val {
        width: 112px;
        text-align: right;
        font-size: 0.78rem;
        font-variant-numeric: tabular-nums;
        color: var(--text);
      }
      footer {
        display: flex;
        gap: 1.5rem;
        border-top: 1px solid var(--border);
        padding-top: 0.7rem;
      }
      .foot-label {
        font-size: 0.68rem;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-faint);
        margin-right: 0.4rem;
      }
      .foot-val {
        font-size: 0.82rem;
        font-variant-numeric: tabular-nums;
      }
    `,
  ],
})
export class MetricsCardComponent implements OnInit, OnDestroy {
  readonly host = input.required<Host>();
  /** Emits this host's id to open the note form scoped to it. */
  readonly addNote = output<string>();
  readonly edit = output<Host>();
  readonly remove = output<Host>();

  private readonly metricsService = inject(MetricsService);
  readonly metrics = signal<HostMetrics | null>(null);

  private unlisten?: UnlistenFn;

  readonly status = computed<Status>(() => {
    const m = this.metrics();
    if (!m) return "pending";
    return m.error ? "error" : "ok";
  });

  async ngOnInit(): Promise<void> {
    const id = this.host().id;
    // Subscribe first so the immediate first snapshot isn't missed.
    this.unlisten = await this.metricsService.onMetrics(id, (m) =>
      this.metrics.set(m),
    );
    await this.metricsService.startMetrics(id);
  }

  ngOnDestroy(): void {
    this.unlisten?.();
    void this.metricsService.stopMetrics(this.host().id);
  }

  // --- derived values ---

  cpuPct(): number {
    return this.metrics()?.cpu_percent ?? 0;
  }

  ramPct(): number {
    const m = this.metrics();
    return m && m.mem_total && m.mem_used != null
      ? (m.mem_used / m.mem_total) * 100
      : 0;
  }

  diskPct(): number {
    const m = this.metrics();
    return m && m.disk_total && m.disk_used != null
      ? (m.disk_used / m.disk_total) * 100
      : 0;
  }

  ramText(): string {
    const m = this.metrics();
    if (!m || m.mem_used == null || m.mem_total == null) return "n/a";
    return `${this.fmtBytes(m.mem_used)} / ${this.fmtBytes(m.mem_total)}`;
  }

  diskText(): string {
    const m = this.metrics();
    if (!m || m.disk_used == null || m.disk_total == null) return "n/a";
    return `${this.fmtBytes(m.disk_used)} / ${this.fmtBytes(m.disk_total)}`;
  }

  loadText(): string {
    const m = this.metrics();
    if (!m || m.load1 == null) return "n/a";
    return [m.load1, m.load5, m.load15]
      .map((v) => (v == null ? "–" : v.toFixed(2)))
      .join("  ");
  }

  uptimeText(): string {
    const secs = this.metrics()?.uptime_secs ?? null;
    if (secs == null) return "n/a";
    const d = Math.floor(secs / 86400);
    const h = Math.floor((secs % 86400) / 3600);
    const min = Math.floor((secs % 3600) / 60);
    if (d > 0) return `${d}d ${h}h`;
    if (h > 0) return `${h}h ${min}m`;
    return `${min}m`;
  }

  level(pct: number): string {
    if (pct >= 90) return "high";
    if (pct >= 70) return "caution";
    return "";
  }

  fmtPct(value: number | null): string {
    return value == null ? "n/a" : `${value.toFixed(0)}%`;
  }

  private fmtBytes(bytes: number): string {
    const gib = bytes / 1024 ** 3;
    if (gib >= 1) return `${gib.toFixed(1)} GiB`;
    const mib = bytes / 1024 ** 2;
    return `${mib.toFixed(0)} MiB`;
  }
}
