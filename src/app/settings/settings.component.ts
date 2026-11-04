import { Component, inject, signal } from "@angular/core";
import { ThemeService, ThemeMode } from "../services/theme.service";
import { UpdateService } from "../services/update.service";
import { BackupService } from "../services/backup.service";

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
  private readonly backup = inject(BackupService);
  readonly update = inject(UpdateService);

  /** Current theme mode (drives the picker's active state). */
  readonly mode = this.themeService.mode;

  // --- Backup (import / export) ---
  /** Whether an export should include saved commands. */
  readonly includeCommands = signal(true);
  /** "" | "export" | "import" while an operation is in flight. */
  readonly backupBusy = signal<"" | "export" | "import">("");
  readonly backupMsg = signal("");
  readonly backupErr = signal("");

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

  toggleIncludeCommands(): void {
    this.includeCommands.update((v) => !v);
  }

  async doExport(): Promise<void> {
    this.backupErr.set("");
    this.backupMsg.set("");
    this.backupBusy.set("export");
    try {
      const ok = await this.backup.export(this.includeCommands());
      if (ok) {
        this.backupMsg.set(
          this.includeCommands()
            ? "Exported your hosts and commands."
            : "Exported your hosts.",
        );
      }
    } catch (e) {
      this.backupErr.set(String(e));
    } finally {
      this.backupBusy.set("");
    }
  }

  async doImport(): Promise<void> {
    this.backupErr.set("");
    this.backupMsg.set("");
    this.backupBusy.set("import");
    try {
      const s = await this.backup.import();
      if (s) {
        const parts = [`${s.hosts_added} ${s.hosts_added === 1 ? "host" : "hosts"}`];
        if (s.notes_added > 0 || s.notes_skipped > 0) {
          parts.push(`${s.notes_added} ${s.notes_added === 1 ? "command" : "commands"}`);
        }
        let msg = `Imported ${parts.join(" and ")}.`;
        const skipped = s.hosts_skipped + s.notes_skipped;
        if (skipped > 0) {
          msg += ` Skipped ${skipped} already present.`;
        }
        this.backupMsg.set(msg);
      }
    } catch (e) {
      this.backupErr.set(String(e));
    } finally {
      this.backupBusy.set("");
    }
  }

  /** Human-friendly "last checked" label. */
  lastCheckedLabel(): string {
    const t = this.update.lastChecked();
    if (t === null) return "never";
    return new Date(t).toLocaleString();
  }
}
