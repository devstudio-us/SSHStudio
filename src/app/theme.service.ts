import { Injectable, effect, signal } from "@angular/core";

export type Theme = "light" | "dark";

const STORAGE_KEY = "ssh-manager-theme";

/**
 * Tracks the active theme in a signal, mirrors it onto `<html data-theme>` so
 * the CSS tokens switch, and persists the choice to localStorage. The initial
 * value comes from localStorage, falling back to the OS color-scheme.
 */
@Injectable({ providedIn: "root" })
export class ThemeService {
  readonly theme = signal<Theme>(ThemeService.initial());

  constructor() {
    // Re-run whenever the signal changes: apply to the DOM + persist.
    effect(() => {
      const theme = this.theme();
      document.documentElement.dataset["theme"] = theme;
      try {
        localStorage.setItem(STORAGE_KEY, theme);
      } catch {
        // localStorage can be unavailable; the theme still applies in-memory.
      }
    });
  }

  toggle(): void {
    this.theme.update((t) => (t === "dark" ? "light" : "dark"));
  }

  private static initial(): Theme {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored === "light" || stored === "dark") {
        return stored;
      }
    } catch {
      // ignore and fall back to the system preference
    }
    const prefersDark = window.matchMedia?.(
      "(prefers-color-scheme: dark)",
    ).matches;
    return prefersDark ? "dark" : "light";
  }
}
