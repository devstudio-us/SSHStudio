import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { HostMetrics } from "../models/metrics.model";

/** Wraps the metrics Tauri commands and the per-host `metrics-<id>` event. */
@Injectable({ providedIn: "root" })
export class MetricsService {
  /** Begin polling a host (must have been connected this session). */
  startMetrics(hostId: string): Promise<void> {
    return invoke("start_metrics", { hostId });
  }

  stopMetrics(hostId: string): Promise<void> {
    return invoke("stop_metrics", { hostId });
  }

  onMetrics(
    hostId: string,
    cb: (metrics: HostMetrics) => void,
  ): Promise<UnlistenFn> {
    return listen<HostMetrics>(`metrics-${hostId}`, (event) => cb(event.payload));
  }
}
