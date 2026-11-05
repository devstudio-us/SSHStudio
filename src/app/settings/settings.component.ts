import { Component, inject } from "@angular/core";
import { ThemeService, ThemeMode } from "../services/theme.service";
import { UpdateService } from "../services/update.service";
import { ImportExportService } from "../services/import-export.service";

/**
 * Settings page (opened from the bottom of the sidebar). Sections: Theme,
 * Updates, Backup (opens the shared import/export dialog) and About. State
 * lives in the ThemeService / UpdateService singletons.
 */
@Component({
  selector: "app-settings",
  templateUrl: "./settings.component.html",
  styleUrl: "./settings.component.css",
})
export class SettingsComponent {
  private readonly themeService = inject(ThemeService);
  private readonly io = inject(ImportExportService);
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

  toggleAutoInstall(): void {
    this.update.setAutoInstall(!this.update.autoInstall());
  }

  checkNow(): void {
    void this.update.check();
  }

  /** Banner primary action: install in-app when possible, else open download. */
  install(): void {
    void this.update.installOrDownload();
  }

  /** Open the release page (release notes / manual download). */
  openReleasePage(): void {
    void this.update.openDownloadPage();
  }

  open(url: string): void {
    void this.update.openExternal(url);
  }

  openExport(): void {
    this.io.open("export");
  }

  openImport(): void {
    this.io.open("import");
  }

  /** Human-friendly "last checked" label. */
  lastCheckedLabel(): string {
    const t = this.update.lastChecked();
    if (t === null) return "never";
    return new Date(t).toLocaleString();
  }
}
