import { Component, inject } from "@angular/core";
import { ThemeService, ThemeMode } from "../services/theme.service";
import { UpdateService } from "../services/update.service";

/**
 * Settings page (opened from the bottom of the sidebar). Three sections:
 * Auto-update (weekly check + manual check, opens the download page), Theme
 * (Light / Dark / System), and About (version + project links). All state
 * lives in the ThemeService / UpdateService singletons.
 */
@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
})
export class SettingsComponent {
  private readonly themeService = inject(ThemeService);
  readonly update = inject(UpdateService);

  /** Current theme mode (drives the picker's active state). */
  readonly mode = this.themeService.mode;

  readonly themeOptions: { value: ThemeMode; label: string }[] = [
    { value: "system", label: "System" },
    { value: "light", label: "Light" },
    { value: "dark", label: "Dark" },
  ];

  /** Project links for the About section. */
  readonly links = {
    repo: "https://github.com/devstudio-us/SSHStudio",
    releases: "https://github.com/devstudio-us/SSHStudio/releases",
    issues: "https://github.com/devstudio-us/SSHStudio/issues",
    license: "https://github.com/devstudio-us/SSHStudio/blob/main/LICENSE",
  };

  setMode(mode: ThemeMode): void {
    this.themeService.setMode(mode);
  }

  toggleAuto(): void {
    this.update.setAutoCheck(!this.update.autoCheck());
    // Turning it on should check right away if one is due.
    if (this.update.autoCheck()) void this.update.maybeAutoCheck();
  }

  checkNow(): void {
    void this.update.check();
  }

  download(): void {
    void this.update.openDownloadPage();
  }

  open(url: string): void {
    void this.update.openExternal(url);
  }

  /** Human-friendly "last checked" label. */
  lastCheckedLabel(): string {
    const t = this.update.lastChecked();
    if (t === null) return "never";
    return new Date(t).toLocaleString();
  }
}
