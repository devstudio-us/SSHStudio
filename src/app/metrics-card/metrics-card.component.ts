import {
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from "@angular/core";
import { UnlistenFn } from "@tauri-apps/api/event";
import { MetricsService } from "../services/metrics.service";
import { HostMetrics } from "../models/metrics.model";
import { Host } from "../models/host.model";

type Status = "pending" | "ok" | "error";

/** A connection failure turned into a short chip label, a title and a one-line
 *  explanation. `raw` is the original text, kept for the hover tooltip. */
interface ConnectErrorInfo {
  chip: string;
  title: string;
  detail: string;
  raw: string;
}

/** Map a raw connection error into something a person can read. */
function humanizeConnectError(raw: string | undefined): ConnectErrorInfo | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  const info = (chip: string, title: string, detail: string): ConnectErrorInfo => ({ chip, title, detail, raw });

  if (s.includes("timed out") || s.includes("timeout") || s.includes("os error 60") || s.includes("os error 10060"))
    return info("Timed out", "Connection timed out", "The server didn’t respond.");
  if (s.includes("refused") || s.includes("os error 61") || s.includes("os error 10061"))
    return info("Refused", "Connection refused", "Nothing is listening on that port.");
  if (s.includes("unreachable") || s.includes("no route") || s.includes("os error 65") || s.includes("os error 51") || s.includes("os error 101") || s.includes("os error 10065"))
    return info("Unreachable", "Host unreachable", "Check the address and your network.");
  if (s.includes("not known") || s.includes("failed to lookup") || s.includes("nodename") || s.includes("resolve") || s.includes("dns"))
    return info("Unknown host", "Host not found", "Check the hostname.");
  if (s.includes("host key mismatch") || s.includes("known_hosts"))
    return info("Key changed", "Host key changed", "Review it before reconnecting.");
  if (s.includes("authentication") || s.includes("auth failed"))
    return info("Auth failed", "Authentication failed", "Check the username, key or password.");
  return info("Can’t connect", "Couldn’t connect", "The server didn’t respond.");
}

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
  /** Last connection failure for this host, if any (shown in the idle state). */
  readonly connectError = input<string | undefined>(undefined);
  /** Whether a connection attempt is in flight for this host. */
  readonly connecting = input<boolean>(false);
  readonly connect = output<Host>();
  readonly openTerminal = output<Host>();
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

  /** The connection failure (if any), humanized for display. */
  readonly errorInfo = computed(() => humanizeConnectError(this.connectError()));

  /** Whether this card is in a failed state (red border). */
  readonly hasError = computed(
    () =>
      (!this.monitored() && !!this.errorInfo()) ||
      (this.monitored() && this.status() === "error"),
  );

  /** The status pill shown next to the host name. */
  readonly chip = computed<{ cls: string; label: string }>(() => {
    if (this.connecting()) return { cls: "amber", label: "Connecting…" };
    if (this.monitored()) {
      const s = this.status();
      if (s === "ok") return { cls: "green", label: "Connected" };
      if (s === "pending") return { cls: "amber", label: "Connecting…" };
      return { cls: "red", label: "Lost connection" };
    }
    const err = this.errorInfo();
    if (err) return { cls: "red", label: err.chip };
    return { cls: "gray", label: "Not connected" };
  });

  constructor() {
    // Poll while the host is monitored; stop and clear when it is disconnected,
    // so the card reverts to its idle "Connect" state (and reconnects cleanly
    // if the user connects again).
    effect(() => {
      const on = this.monitored();
      untracked(() => (on ? void this.start() : this.stop()));
    });
  }

  private async start(): Promise<void> {
    if (this.unlisten) return; // already polling
    const id = this.host().id;
    // Subscribe first so the immediate first snapshot isn't missed.
    const unlisten = await this.metricsService.onMetrics(id, (m) =>
      this.metrics.set(m),
    );
    // Guard against being disconnected again while we were subscribing.
    if (!this.monitored()) {
      unlisten();
      void this.metricsService.stopMetrics(id);
      return;
    }
    this.unlisten = unlisten;
    await this.metricsService.startMetrics(id);
  }

  private stop(): void {
    if (!this.unlisten) return;
    this.unlisten();
    this.unlisten = undefined;
    this.metrics.set(null); // drop stale readings so a reconnect starts fresh
    void this.metricsService.stopMetrics(this.host().id);
  }

  ngOnDestroy(): void {
    this.stop();
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

  ramPctText(): string {
    const m = this.metrics();
    if (!m || m.mem_used == null || m.mem_total == null) return "n/a";
    return `${Math.round(this.ramPct())}%`;
  }

  diskPctText(): string {
    const m = this.metrics();
    if (!m || m.disk_used == null || m.disk_total == null) return "n/a";
    return `${Math.round(this.diskPct())}%`;
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
