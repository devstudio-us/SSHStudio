import { Injectable, inject } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { HostsService } from "./hosts.service";
import { NotesService } from "./notes.service";

/** Counts returned by the Rust `import_data` command. */
export interface ImportSummary {
  hosts_added: number;
  hosts_skipped: number;
  notes_added: number;
  notes_skipped: number;
}

/**
 * Import / export of hosts (and optionally commands) as a single JSON file.
 * The file carries no secrets — passwords stay in the OS keychain and private
 * keys are referenced by path only. Import is non-destructive (merge + skip
 * duplicates), handled entirely in Rust; this service just drives the native
 * file dialogs and refreshes the stores afterwards.
 */
@Injectable({ providedIn: "root" })
export class BackupService {
  private readonly hosts = inject(HostsService);
  private readonly notes = inject(NotesService);

  /** Prompt for a destination and write the export. Returns false if the user
   * cancelled the save dialog. */
  async export(includeNotes: boolean): Promise<boolean> {
    const path = await save({
      title: "Export SSHStudio data",
      defaultPath: "sshstudio-backup.json",
      filters: [{ name: "SSHStudio backup", extensions: ["json"] }],
    });
    if (!path) return false;
    await invoke("export_data", { path, includeNotes });
    return true;
  }

  /** Prompt for a file and merge it in. Returns null if the user cancelled. */
  async import(): Promise<ImportSummary | null> {
    const selected = await open({
      title: "Import SSHStudio data",
      multiple: false,
      directory: false,
      filters: [{ name: "SSHStudio backup", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return null;
    const summary = await invoke<ImportSummary>("import_data", { path: selected });
    // Reload both stores so the new hosts/commands show up immediately.
    await Promise.all([this.hosts.refresh(), this.notes.refresh()]);
    return summary;
  }
}
