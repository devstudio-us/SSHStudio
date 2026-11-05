import { Injectable, inject } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { HostsService } from "./hosts.service";
import { NotesService } from "./notes.service";
import { Host } from "../models/host.model";
import { Note } from "../models/note.model";

/** Parsed contents of a backup file (from the Rust `read_backup` preview). */
export interface BackupFile {
  format: string;
  version: number;
  app_version: string;
  hosts: Host[];
  notes: Note[];
}

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
 * keys are referenced by path only. Export and import both work on a chosen
 * set of host ids. Import is non-destructive (merge + skip duplicates), handled
 * in Rust; this service drives the native dialogs and refreshes the stores.
 */
@Injectable({ providedIn: "root" })
export class BackupService {
  private readonly hosts = inject(HostsService);
  private readonly notes = inject(NotesService);

  /** Prompt for a destination and export the chosen hosts. Returns false if
   * the user cancelled the save dialog. */
  async export(hostIds: string[], includeNotes: boolean): Promise<boolean> {
    const path = await save({
      title: "Export SSHStudio data",
      defaultPath: "sshstudio-backup.json",
      filters: [{ name: "SSHStudio backup", extensions: ["json"] }],
    });
    if (!path) return false;
    await invoke("export_data", { path, hostIds, includeNotes });
    return true;
  }

  /** Prompt for a backup file and parse it (no changes yet). Returns null if
   * the user cancelled. */
  async pickAndRead(): Promise<{ path: string; backup: BackupFile } | null> {
    const selected = await open({
      title: "Import SSHStudio data",
      multiple: false,
      directory: false,
      filters: [{ name: "SSHStudio backup", extensions: ["json"] }],
    });
    if (typeof selected !== "string") return null;
    const backup = await invoke<BackupFile>("read_backup", { path: selected });
    return { path: selected, backup };
  }

  /** Merge the chosen hosts from a previously-read file. */
  async import(
    path: string,
    hostIds: string[],
    includeNotes: boolean,
  ): Promise<ImportSummary> {
    const summary = await invoke<ImportSummary>("import_data", {
      path,
      hostIds,
      includeNotes,
    });
    // Reload both stores so the new hosts/commands show up immediately.
    await Promise.all([this.hosts.refresh(), this.notes.refresh()]);
    return summary;
  }
}
