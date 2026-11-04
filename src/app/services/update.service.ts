import { Injectable, signal } from "@angular/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";

/** GitHub repo the releases are published under. */
const REPO = "devstudio-us/SSHStudio";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

const ENABLED_KEY = "ssh-manager-auto-update";
const LAST_CHECK_KEY = "ssh-manager-update-last-check";
/** How often the automatic check is allowed to actually call out. */
const DAY_MS = 24 * 60 * 60 * 1000;
/** How often the running app re-evaluates whether a daily check is due (so a
 * long-running window still checks ~daily, not only at startup). */
const TIMER_MS = 6 * 60 * 60 * 1000;

/** Where an update check currently stands. */
export type UpdateState =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** Running version (e.g. "0.3.0"). */
  current?: string;
  /** Latest published version, when known. */
  latest?: string;
  /** Release notes (markdown) for an available update. */
  notes?: string;
  /** The release page to open for a download. */
  url?: string;
  error?: string;
}

/**
 * "Check & notify" updater: there's no in-app install (the app isn't signed/
 * notarized yet). It asks the GitHub Releases API for the latest version and,
 * if it's newer than the running build, surfaces it so the user can open the
 * download page. The weekly auto-check runs at startup when enabled.
 *
 * State is kept in localStorage (per machine) — no backend or config file.
 */
@Injectable({ providedIn: "root" })
export class UpdateService {
  /** The running app version, loaded once from Tauri. */
  readonly version = signal<string>("");
  /** Whether the weekly background check is enabled. */
  readonly autoCheck = signal<boolean>(UpdateService.loadEnabled());
  readonly status = signal<UpdateStatus>({ state: "idle" });
  /** Epoch ms of the last completed check, or null if never. */
  readonly lastChecked = signal<number | null>(UpdateService.loadLastCheck());

  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Resolve the current version up front (fails silently in a plain browser
    // where the Tauri API isn't present, e.g. `ng serve`).
    void getVersion()
      .then((v) => this.version.set(v))
      .catch(() => {});
  }

  /** Start a background timer that keeps the daily check running even if the
   * app window is left open for days. Idempotent. maybeAutoCheck() itself
   * throttles, so re-evaluating often is cheap. */
  startAutoTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.maybeAutoCheck(), TIMER_MS);
  }

  setAutoCheck(on: boolean): void {
    this.autoCheck.set(on);
    try {
      localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    } catch {
      // localStorage may be unavailable; the choice still applies in-memory.
    }
  }

  /** Run the automatic check: only if enabled and the last check was more than
   * a day ago (or never). */
  async maybeAutoCheck(): Promise<void> {
    if (!this.autoCheck()) return;
    const last = this.lastChecked();
    if (last !== null && Date.now() - last < DAY_MS) return;
    await this.check();
  }

  /** Query GitHub for the latest release and compare to the running version. */
  async check(): Promise<void> {
    this.status.set({ state: "checking" });
    try {
      const current = this.version() || (await getVersion());
      this.version.set(current);

      const res = await fetch(LATEST_API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) {
        throw new Error(`GitHub returned ${res.status} ${res.statusText}`);
      }
      const data = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
      };
      const latest = (data.tag_name ?? "").replace(/^v/i, "");

      const now = Date.now();
      this.lastChecked.set(now);
      try {
        localStorage.setItem(LAST_CHECK_KEY, String(now));
      } catch {
        // ignore
      }

      if (latest && UpdateService.isNewer(latest, current)) {
        this.status.set({
          state: "available",
          current,
          latest,
          notes: data.body ?? "",
          url: data.html_url || RELEASES_PAGE,
        });
      } else {
        this.status.set({ state: "current", current, latest });
      }
    } catch (e) {
      this.status.set({
        state: "error",
        current: this.version(),
        error: String(e),
      });
    }
  }

  /** Open the release/download page in the user's browser. */
  async openDownloadPage(): Promise<void> {
    const url = this.status().url || RELEASES_PAGE;
    await openUrl(url);
  }

  /** Open an arbitrary external link (About section). */
  async openExternal(url: string): Promise<void> {
    await openUrl(url);
  }

  /** Is version `a` newer than version `b`? Lenient dotted-number compare. */
  private static isNewer(a: string, b: string): boolean {
    const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
    const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff > 0;
    }
    return false;
  }

  private static loadEnabled(): boolean {
    try {
      // Default ON: the weekly check is unobtrusive and opt-out.
      return localStorage.getItem(ENABLED_KEY) !== "0";
    } catch {
      return true;
    }
  }

  private static loadLastCheck(): number | null {
    try {
      const raw = localStorage.getItem(LAST_CHECK_KEY);
      const n = raw ? parseInt(raw, 10) : NaN;
      return Number.isFinite(n) ? n : null;
    } catch {
      return null;
    }
  }
}
