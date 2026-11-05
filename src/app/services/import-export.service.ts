import { Injectable, signal } from "@angular/core";

/** Which tab the import/export dialog opens on (null = closed). */
export type IoMode = "export" | "import" | null;

/**
 * Tiny UI state holder so any view (Dashboard, Settings) can open the shared
 * import/export dialog without output/input plumbing. The dialog component
 * renders once at the app root and reads this signal.
 */
@Injectable({ providedIn: "root" })
export class ImportExportService {
  readonly mode = signal<IoMode>(null);

  open(mode: "export" | "import"): void {
    this.mode.set(mode);
  }

  close(): void {
    this.mode.set(null);
  }
}
