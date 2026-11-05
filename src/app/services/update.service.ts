import { Injectable, signal } from "@angular/core";
import { getVersion } from "@tauri-apps/api/app";
import { openUrl } from "@tauri-apps/plugin-opener";
import { check as checkForUpdate, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

/** GitHub repo the releases are published under. */
const REPO = "devstudio-us/SSHStudio";
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`;

const ENABLED_KEY = "ssh-manager-auto-update";
const AUTO_INSTALL_KEY = "ssh-manager-auto-install";
const LAST_CHECK_KEY = "ssh-manager-update-last-check";
// --- TESTING cadence (temporary) ---
// Shortened so update checks happen often while testing the update flow.
// Restore to DAY_MS = 24 * 60 * 60 * 1000 and TIMER_MS = 6 * 60 * 60 * 1000
// once testing is done.
const MINUTE_MS = 60 * 1000;
/** How often the automatic check is allowed to actually call out. */
const DAY_MS = 15 * MINUTE_MS; // TESTING — was 24 * 60 * 60 * 1000
/** How often the running app re-evaluates whether a check is due (so a
 * long-running window still re-checks on this cadence, not only at startup). */
const TIMER_MS = 15 * MINUTE_MS; // TESTING — was 6 * 60 * 60 * 1000

/** Where an update check currently stands. */
export type UpdateState =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "installing"
  | "error";

export interface UpdateStatus {
  state: UpdateState;
  /** Running version (e.g. "0.3.0"). */
  current?: string;
  /** Latest published version, when known. */
  latest?: string;
  /** Release notes (markdown) for an available update. */
  notes?: string;
  /** The release page to open (release notes / manual download fallback). */
  url?: string;
  error?: string;
}

/**
 * Updater. Uses Tauri's signed updater as the primary path: it checks a
 * signed manifest, and (when the user asks, or auto-install is on) downloads,
 * installs and relaunches in-app. If the updater is unavailable — in `ng serve`,
 * or against a release that predates updater artifacts — it falls back to a
 * GitHub Releases API check so the user is still notified and can download
 * manually.
 *
 * Preferences (enabled / auto-install / last-checked) live in localStorage.
 */
@Injectable({ providedIn: "root" })
export class UpdateService {
  /** In-app silent install is available (signed updater is configured). */
  readonly installSupported = true;

  /** The running app version, loaded once from Tauri. */
  readonly version = signal<string>("");
  /** Whether the daily background check is enabled. */
  readonly autoCheck = signal<boolean>(UpdateService.loadEnabled());
  /** Whether the user wants updates installed automatically. */
  readonly autoInstall = signal<boolean>(UpdateService.loadAutoInstall());
  readonly status = signal<UpdateStatus>({ state: "idle" });
  /** Epoch ms of the last completed check, or null if never. */
  readonly lastChecked = signal<number | null>(UpdateService.loadLastCheck());
  /** True when an in-app installable update is ready (drives the button label;
   * false when we only know of an update via the GitHub fallback). */
  readonly canInstall = signal(false);

  /** The pending updater handle to install, when one is available. */
  private pendingUpdate: Update | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Guards against overlapping checks (e.g. focus + visibility firing together,
   * or a manual check while an automatic one is mid-flight). */
  private checking = false;
  /** Ensures the focus/visibility listeners are only wired once. */
  private focusWired = false;

  constructor() {
    // Resolve the current version up front (fails silently in a plain browser
    // where the Tauri API isn't present, e.g. `ng serve`).
    void getVersion()
      .then((v) => this.version.set(v))
      .catch(() => {});
  }

  /** Keep the daily check running even if the window stays open for days. */
  startAutoTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => void this.maybeAutoCheck(), TIMER_MS);
  }

  /** Also check whenever the window regains focus or becomes visible.
   *
   * Desktop webviews (WebView2 / WebKit) throttle or suspend background timers
   * when the window is minimized or unfocused, so the interval alone can miss a
   * release until the window is next focused. Re-checking on focus/visibility
   * closes that gap; `maybeAutoCheck` still enforces the cadence, so returning
   * to the app repeatedly won't spam the server. Call once (idempotent). */
  startFocusChecks(): void {
    if (this.focusWired) return;
    this.focusWired = true;
    const onActive = (): void => {
      if (document.visibilityState === "visible") void this.maybeAutoCheck();
    };
    document.addEventListener("visibilitychange", onActive);
    window.addEventListener("focus", onActive);
  }

  setAutoCheck(on: boolean): void {
    this.autoCheck.set(on);
    try {
      localStorage.setItem(ENABLED_KEY, on ? "1" : "0");
    } catch {
      // localStorage may be unavailable; the choice still applies in-memory.
    }
  }

  setAutoInstall(on: boolean): void {
    this.autoInstall.set(on);
    try {
      localStorage.setItem(AUTO_INSTALL_KEY, on ? "1" : "0");
    } catch {
      // ignore — preference still applies in-memory for this session.
    }
    // Installing requires checking, so turning auto-install on enables the
    // daily check too.
    if (on && !this.autoCheck()) this.setAutoCheck(true);
  }

  /** Run the automatic check: only if enabled and the last check was more than
   * a day ago (or never). */
  async maybeAutoCheck(): Promise<void> {
    if (!this.autoCheck()) return;
    const last = this.lastChecked();
    if (last !== null && Date.now() - last < DAY_MS) return;
    await this.check();
  }

  /** Check for a newer release. Prefers the signed updater; falls back to the
   * GitHub API so the user is still notified when the updater can't run. */
  async check(): Promise<void> {
    // Skip if a check is already running (focus + visibility can fire together,
    // or a manual check may overlap an automatic one).
    if (this.checking) return;
    this.checking = true;
    this.status.set({ state: "checking" });
    const current = this.version() || (await getVersion().catch(() => ""));
    if (current) this.version.set(current);

    try {
      const upd = await checkForUpdate();
      this.markChecked();
      if (upd) {
        this.pendingUpdate = upd;
        this.canInstall.set(true);
        this.status.set({
          state: "available",
          current: upd.currentVersion || current,
          latest: upd.version,
          notes: upd.body ?? "",
          url: RELEASES_PAGE,
        });
        // Auto-install if the user opted in.
        if (this.autoInstall()) await this.installUpdate();
      } else {
        this.pendingUpdate = null;
        this.canInstall.set(false);
        this.status.set({ state: "current", current });
      }
    } catch (e) {
      // Updater unavailable (dev, or a release without a manifest yet): still
      // notify via the GitHub API. Manual install then opens the download page.
      const ok = await this.checkViaGithub(current);
      if (!ok) {
        this.status.set({ state: "error", current, error: String(e) });
      }
    } finally {
      this.checking = false;
    }
  }

  /** Fallback: ask the GitHub Releases API whether a newer version exists. */
  private async checkViaGithub(current: string): Promise<boolean> {
    try {
      const res = await fetch(LATEST_API, {
        headers: { Accept: "application/vnd.github+json" },
      });
      if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
      const data = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        body?: string;
      };
      const latest = (data.tag_name ?? "").replace(/^v/i, "");
      this.markChecked();
      this.pendingUpdate = null;
      this.canInstall.set(false);
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
      return true;
    } catch {
      return false;
    }
  }

  /** Install the pending update in-app and relaunch; falls back to opening the
   * download page if in-app install isn't possible. */
  async installUpdate(): Promise<void> {
    const upd = this.pendingUpdate;
    if (!this.installSupported || !upd) {
      await this.openDownloadPage();
      return;
    }
    this.status.update((s) => ({ ...s, state: "installing" }));
    try {
      await upd.downloadAndInstall();
      await relaunch();
    } catch (e) {
      this.status.set({
        state: "error",
        current: this.version(),
        error: String(e),
      });
    }
  }

  /** The banner's primary action: install in-app when possible, else download. */
  async installOrDownload(): Promise<void> {
    if (this.installSupported && this.pendingUpdate) {
      await this.installUpdate();
    } else {
      await this.openDownloadPage();
    }
  }

  /** Open the release/download page in the user's browser. */
  async openDownloadPage(): Promise<void> {
    await openUrl(this.status().url || RELEASES_PAGE);
  }

  /** Open an arbitrary external link (About section). */
  async openExternal(url: string): Promise<void> {
    await openUrl(url);
  }

  private markChecked(): void {
    const now = Date.now();
    this.lastChecked.set(now);
    try {
      localStorage.setItem(LAST_CHECK_KEY, String(now));
    } catch {
      // ignore
    }
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
      // Default ON: the daily check is unobtrusive and opt-out.
      return localStorage.getItem(ENABLED_KEY) !== "0";
    } catch {
      return true;
    }
  }

  private static loadAutoInstall(): boolean {
    try {
      // Default OFF: installing is opt-in.
      return localStorage.getItem(AUTO_INSTALL_KEY) === "1";
    } catch {
      return false;
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
