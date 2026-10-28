import {
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { UnlistenFn } from "@tauri-apps/api/event";
import { MetricsService } from "../metrics.service";
import { HostMetrics } from "../metrics.model";
import { Host } from "../host.model";

type Status = "pending" | "ok" | "error";

/**
 * A dashboard card for one host. Starts the backend poller on init, listens for
 * `metrics-<id>` snapshots, and stops the poller on destroy. All formatting of
 * nullable values into "n/a" happens here.
 */
@Component({
  selector: "app-metrics-card",
  templateUrl: "./metrics-card.component.html",
  styleUrl: "./metrics-card.component.css",
})
export class MetricsCardComponent implements OnDestroy {
  readonly host = input.required<Host>();
  /** Whether this host is connected this session (so it can be polled). */
  readonly monitored = input<boolean>(false);
  readonly connect = output<Host>();
  readonly openTerminal = output<Host>();
  /** Emits this host's id to open the note form scoped to it. */
  readonly addNote = output<string>();
  readonly edit = output<Host>();
  readonly remove = output<Host>();

  private readonly metricsService = inject(MetricsService);
  readonly metrics = signal<HostMetrics | null>(null);

  private unlisten?: UnlistenFn;
  private started = false;

  readonly status = computed<Status>(() => {
    const m = this.metrics();
    if (!m) return "pending";
    return m.error ? "error" : "ok";
  });

  constructor() {
    // Start polling once the host becomes monitored (now, or after the user
    // clicks Connect). Guarded so it only starts once.
    effect(() => {
      if (this.monitored() && !this.started) {
        this.started = true;
        void this.begin();
      }
    });
  }

  private async begin(): Promise<void> {
    const id = this.host().id;
    // Subscribe first so the immediate first snapshot isn't missed.
    this.unlisten = await this.metricsService.onMetrics(id, (m) =>
      this.metrics.set(m),
    );
    await this.metricsService.startMetrics(id);
  }

  ngOnDestroy(): void {
    this.unlisten?.();
    if (this.started) {
      void this.metricsService.stopMetrics(this.host().id);
    }
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
