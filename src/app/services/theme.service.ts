import { Injectable, computed, effect, signal } from "@angular/core";

/** The theme actually applied to the DOM. */
export type Theme = "light" | "dark";
/** The user's choice: a fixed theme, or "system" to follow the OS. */
export type ThemeMode = "light" | "dark" | "system";

const STORAGE_KEY = "ssh-manager-theme";

/**
 * Tracks the chosen theme mode in a signal, resolves it to an effective
 * light/dark theme (following the OS when the mode is "system"), mirrors that
 * onto `<html data-theme>` so the CSS tokens switch, and persists the mode to
 * localStorage. "system" reacts live to OS appearance changes.
 */
@Injectable({ providedIn: "root" })
export class ThemeService {
  /** The user's chosen mode. Persisted. */
  readonly mode = signal<ThemeMode>(ThemeService.initialMode());
  /** Live OS color-scheme preference; updated when the OS theme changes. */
  private readonly systemDark = signal<boolean>(
    ThemeService.systemPrefersDark(),
  );
  /** The theme actually applied — resolves "system" against the OS. */
  readonly theme = computed<Theme>(() => {
    const mode = this.mode();
    if (mode === "system") return this.systemDark() ? "dark" : "light";
    return mode;
  });

  constructor() {
    // Keep the OS-preference signal live so "System" mode switches instantly
    // when the user changes their OS appearance.
    const mql = window.matchMedia?.("(prefers-color-scheme: dark)");
    mql?.addEventListener?.("change", (e) => this.systemDark.set(e.matches));

    // Re-run whenever the resolved theme or mode changes: apply + persist.
    effect(() => {
      document.documentElement.dataset["theme"] = this.theme();
      try {
        localStorage.setItem(STORAGE_KEY, this.mode());
      } catch {
        // localStorage can be unavailable; the theme still applies in-memory.
      }
    });
  }

  /** Quick toggle (topbar): flip to the opposite of what's showing now, as a
   * fixed choice (so toggling out of "system" lands on a concrete theme). */
  toggle(): void {
    this.mode.set(this.theme() === "dark" ? "light" : "dark");
  }

  /** Set the mode explicitly (the Settings page theme picker). */
  setMode(mode: ThemeMode): void {
    this.mode.set(mode);
  }

  private static initialMode(): ThemeMode {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark" || stored === "system") {
        return stored;
      }
    } catch {
      // ignore and fall back below
    }
    // No stored choice: follow the OS by default.
    return "system";
  }

  private static systemPrefersDark(): boolean {
    return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  }
}
