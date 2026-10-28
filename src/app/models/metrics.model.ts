/** Mirrors the Rust `HostMetrics` struct. Every field is nullable; `null`
 * renders as "n/a". Byte fields are absolute bytes; load/cpu are already scaled. */
export interface HostMetrics {
  cpu_percent: number | null;
  mem_used: number | null;
  mem_total: number | null;
  disk_used: number | null;
  disk_total: number | null;
  load1: number | null;
  load5: number | null;
  load15: number | null;
  uptime_secs: number | null;
  error: string | null;
}
