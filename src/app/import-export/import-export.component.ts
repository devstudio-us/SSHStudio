import {
  Component,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from "@angular/core";
import { HostsService } from "../services/hosts.service";
import { ImportExportService } from "../services/import-export.service";
import { BackupService } from "../services/backup.service";
import { Host } from "../models/host.model";

/**
 * Shared Import / Export dialog, opened from the Dashboard or Settings via
 * ImportExportService. Two tabs: Export (pick which saved hosts to write to a
 * file, optionally with commands) and Import (pick a file, then choose which of
 * its hosts to merge in). Selection supports "select all" or individual hosts.
 */
@Component({
  selector: "app-import-export",
  templateUrl: "./import-export.component.html",
  styleUrl: "./import-export.component.css",
})
export class ImportExportComponent {
  private readonly io = inject(ImportExportService);
  private readonly hostsService = inject(HostsService);
  private readonly backup = inject(BackupService);

  readonly mode = this.io.mode;
  readonly tab = signal<"export" | "import">("export");

  // --- Export ---
  readonly hosts = this.hostsService.hosts;
  readonly exportSel = signal<Set<string>>(new Set());
  readonly includeCommandsExport = signal(true);

  // --- Import ---
  readonly importStep = signal<"pick" | "choose">("pick");
  readonly importPath = signal("");
  readonly importHosts = signal<Host[]>([]);
  readonly importNotesCount = signal(0);
  readonly importSel = signal<Set<string>>(new Set());
  readonly includeCommandsImport = signal(true);

  readonly busy = signal(false);
  readonly msg = signal("");
  readonly err = signal("");

  constructor() {
    // When the dialog opens, sync the tab and reset that tab's state.
    effect(() => {
      const m = this.mode();
      if (!m) return;
      this.tab.set(m);
      this.resetState(m);
    });
  }

  private resetState(m: "export" | "import"): void {
    this.msg.set("");
    this.err.set("");
    this.busy.set(false);
    if (m === "export") {
      // Default: everything selected. untracked so this effect doesn't re-run
      // (and wipe the user's selection) just because the hosts list changed.
      this.exportSel.set(new Set(untracked(this.hosts).map((h) => h.id)));
      this.includeCommandsExport.set(true);
    } else {
      this.importStep.set("pick");
      this.importPath.set("");
      this.importHosts.set([]);
      this.importNotesCount.set(0);
      this.importSel.set(new Set());
    }
  }

  switchTab(t: "export" | "import"): void {
    this.tab.set(t);
    this.resetState(t);
  }

  close(): void {
    this.io.close();
  }

  // --- Export selection ---
  isExportSelected(id: string): boolean {
    return this.exportSel().has(id);
  }
  toggleExport(id: string): void {
    const s = new Set(this.exportSel());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.exportSel.set(s);
  }
  readonly allExportSelected = computed(() => {
    const hosts = this.hosts();
    return hosts.length > 0 && hosts.every((h) => this.exportSel().has(h.id));
  });
  toggleAllExport(): void {
    if (this.allExportSelected()) this.exportSel.set(new Set());
    else this.exportSel.set(new Set(this.hosts().map((h) => h.id)));
  }
  readonly exportCount = computed(() => this.exportSel().size);

  // --- Import selection ---
  isImportSelected(id: string): boolean {
    return this.importSel().has(id);
  }
  toggleImport(id: string): void {
    const s = new Set(this.importSel());
    if (s.has(id)) s.delete(id);
    else s.add(id);
    this.importSel.set(s);
  }
  readonly allImportSelected = computed(() => {
    const hosts = this.importHosts();
    return hosts.length > 0 && hosts.every((h) => this.importSel().has(h.id));
  });
  toggleAllImport(): void {
    if (this.allImportSelected()) this.importSel.set(new Set());
    else this.importSel.set(new Set(this.importHosts().map((h) => h.id)));
  }
  readonly importCount = computed(() => this.importSel().size);

  // --- Actions ---
  async doExport(): Promise<void> {
    this.err.set("");
    this.msg.set("");
    const ids = [...this.exportSel()];
    if (ids.length === 0) return;
    this.busy.set(true);
    try {
      const ok = await this.backup.export(ids, this.includeCommandsExport());
      if (ok) {
        this.msg.set(
          `Exported ${ids.length} ${ids.length === 1 ? "host" : "hosts"}` +
            (this.includeCommandsExport() ? " with commands." : "."),
        );
      }
    } catch (e) {
      this.err.set(String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async pickFile(): Promise<void> {
    this.err.set("");
    this.msg.set("");
    this.busy.set(true);
    try {
      const res = await this.backup.pickAndRead();
      if (res) {
        const hosts = res.backup.hosts ?? [];
        const noteCount = res.backup.notes?.length ?? 0;
        this.importPath.set(res.path);
        this.importHosts.set(hosts);
        this.importNotesCount.set(noteCount);
        this.importSel.set(new Set(hosts.map((h) => h.id)));
        this.includeCommandsImport.set(noteCount > 0);
        this.importStep.set("choose");
      }
    } catch (e) {
      this.err.set(String(e));
    } finally {
      this.busy.set(false);
    }
  }

  async doImport(): Promise<void> {
    this.err.set("");
    this.msg.set("");
    const ids = [...this.importSel()];
    if (ids.length === 0) return;
    this.busy.set(true);
    try {
      const s = await this.backup.import(
        this.importPath(),
        ids,
        this.includeCommandsImport(),
      );
      const parts = [`${s.hosts_added} ${s.hosts_added === 1 ? "host" : "hosts"}`];
      if (s.notes_added > 0 || s.notes_skipped > 0) {
        parts.push(`${s.notes_added} ${s.notes_added === 1 ? "command" : "commands"}`);
      }
      let msg = `Imported ${parts.join(" and ")}.`;
      const skipped = s.hosts_skipped + s.notes_skipped;
      if (skipped > 0) msg += ` Skipped ${skipped} already present.`;
      this.msg.set(msg);
      // Back to the picker so the summary shows and another file can be chosen.
      this.importStep.set("pick");
      this.importHosts.set([]);
    } catch (e) {
      this.err.set(String(e));
    } finally {
      this.busy.set(false);
    }
  }

  hostLabel(h: Host): string {
    return h.name || h.hostname;
  }
  hostAddr(h: Host): string {
    return `${h.user ? h.user + "@" : ""}${h.hostname}:${h.port}`;
  }
}
