import { Component, effect, inject, input, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { UnlistenFn } from "@tauri-apps/api/event";
import { Host } from "../models/host.model";
import { FileEntry } from "../models/file-entry.model";
import { SftpService } from "../services/sftp.service";

type Side = "local" | "remote";

/** A running or finished file transfer, shown with a progress bar. */
interface Transfer {
  id: string;
  name: string;
  /** "up" = upload (local→remote), "down" = download (remote→local). */
  dir: "up" | "down";
  transferred: number;
  total: number;
  done: boolean;
  error?: string;
  unlisten?: UnlistenFn;
}

/** State for the small name/confirm modal (new folder, rename, delete). */
interface Ask {
  title: string;
  /** true = confirm only (no text field). */
  confirm: boolean;
  value: string;
  okLabel: string;
  onOk: (value: string) => void;
  /** Called when the modal is dismissed with Cancel (used by overwrite prompt). */
  onCancel?: () => void;
}

/**
 * Two-pane SFTP browser: local files on the left, the host's files on the
 * right. Navigate with double-click, select (click to toggle), transfer with
 * the arrow buttons or by dragging between panes. Remote-side management
 * (new folder / rename / delete) is available on the right pane.
 */
@Component({
  selector: "app-sftp-browser",
  imports: [FormsModule],
  templateUrl: "./sftp-browser.component.html",
  styleUrl: "./sftp-browser.component.css",
})
export class SftpBrowserComponent {
  readonly host = input.required<Host>();

  private readonly sftp = inject(SftpService);

  readonly localPath = signal("");
  readonly remotePath = signal("");
  readonly localEntries = signal<FileEntry[]>([]);
  readonly remoteEntries = signal<FileEntry[]>([]);
  readonly localSel = signal<Set<string>>(new Set());
  readonly remoteSel = signal<Set<string>>(new Set());
  readonly localErr = signal("");
  readonly remoteErr = signal("");
  readonly localBusy = signal(false);
  readonly remoteBusy = signal(false);
  readonly transfers = signal<Transfer[]>([]);
  /** Which pane an in-flight drag started from (to allow a cross-pane drop). */
  readonly dragSide = signal<Side | null>(null);
  readonly ask = signal<Ask | null>(null);
  askValue = "";

  constructor() {
    // Load both panes whenever the browsed host changes.
    effect(() => {
      const id = this.host().id;
      void this.initPanes(id);
    });
  }

  private async initPanes(hostId: string): Promise<void> {
    this.localErr.set("");
    this.remoteErr.set("");
    try {
      await this.openLocal(await this.sftp.localHome());
    } catch (e) {
      this.localErr.set(String(e));
    }
    try {
      await this.openRemote(await this.sftp.remoteHome(hostId));
    } catch (e) {
      this.remoteErr.set(String(e));
    }
  }

  // --- navigation / listing ---

  async openLocal(path: string): Promise<void> {
    this.localBusy.set(true);
    this.localErr.set("");
    try {
      const entries = await this.sftp.localList(path);
      this.localPath.set(path);
      this.localEntries.set(entries);
      this.localSel.set(new Set());
    } catch (e) {
      this.localErr.set(String(e));
    } finally {
      this.localBusy.set(false);
    }
  }

  async openRemote(path: string): Promise<void> {
    this.remoteBusy.set(true);
    this.remoteErr.set("");
    try {
      const entries = await this.sftp.remoteList(this.host().id, path);
      this.remotePath.set(path);
      this.remoteEntries.set(entries);
      this.remoteSel.set(new Set());
    } catch (e) {
      this.remoteErr.set(String(e));
    } finally {
      this.remoteBusy.set(false);
    }
  }

  openEntry(side: Side, entry: FileEntry): void {
    if (!entry.is_dir) return;
    if (side === "local") void this.openLocal(entry.path);
    else void this.openRemote(entry.path);
  }

  up(side: Side): void {
    if (side === "local") void this.openLocal(this.parentOf(this.localPath(), false));
    else void this.openRemote(this.parentOf(this.remotePath(), true));
  }

  refresh(side: Side): void {
    if (side === "local") void this.openLocal(this.localPath());
    else void this.openRemote(this.remotePath());
  }

  // --- selection ---

  toggle(side: Side, entry: FileEntry, event: Event): void {
    event.stopPropagation();
    const sel = side === "local" ? this.localSel : this.remoteSel;
    const next = new Set(sel());
    if (next.has(entry.path)) next.delete(entry.path);
    else next.add(entry.path);
    sel.set(next);
  }

  clearSel(side: Side): void {
    (side === "local" ? this.localSel : this.remoteSel).set(new Set());
  }

  selectedCount(side: Side): number {
    return (side === "local" ? this.localSel : this.remoteSel)().size;
  }

  // --- transfers ---

  async upload(): Promise<void> {
    const targets = this.localEntries().filter((e) => this.localSel().has(e.path));
    if (!targets.length) return;

    // Anything with the same name already in the destination folder would be
    // replaced; ask first. (Folders merge, overwriting files inside.)
    const existing = new Set(this.remoteEntries().map((e) => e.name));
    const clashes = targets.filter((t) => existing.has(t.name)).map((t) => t.name);
    if (clashes.length && !(await this.confirmOverwrite(clashes, this.hostLabel()))) return;

    const hostId = this.host().id;
    for (const entry of targets) {
      const dest = this.joinRemote(this.remotePath(), entry.name);
      await this.runTransfer("up", entry.name, (id) =>
        entry.is_dir
          ? this.sftp.uploadDir(hostId, entry.path, dest, id)
          : this.sftp.upload(hostId, entry.path, dest, id),
      );
    }
    // Clear the source selection so the next pick starts fresh.
    this.clearSel("local");
    await this.openRemote(this.remotePath());
  }

  async download(): Promise<void> {
    const targets = this.remoteEntries().filter((e) => this.remoteSel().has(e.path));
    if (!targets.length) return;

    const existing = new Set(this.localEntries().map((e) => e.name));
    const clashes = targets.filter((t) => existing.has(t.name)).map((t) => t.name);
    if (clashes.length && !(await this.confirmOverwrite(clashes, "this computer"))) return;

    const hostId = this.host().id;
    for (const entry of targets) {
      const dest = this.joinLocal(this.localPath(), entry.name);
      await this.runTransfer("down", entry.name, (id) =>
        entry.is_dir
          ? this.sftp.downloadDir(hostId, entry.path, dest, id)
          : this.sftp.download(hostId, entry.path, dest, id),
      );
    }
    // Clear the source selection so the next pick starts fresh.
    this.clearSel("remote");
    await this.openLocal(this.localPath());
  }

  private hostLabel(): string {
    const h = this.host();
    return h.name || h.hostname;
  }

  /** Ask before replacing existing items at the destination. Resolves true to
   *  proceed, false to cancel. */
  private confirmOverwrite(names: string[], where: string): Promise<boolean> {
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? `, and ${names.length - 3} more` : "";
    const title =
      names.length === 1
        ? `"${names[0]}" already exists in ${where}. Overwrite?`
        : `${names.length} items already exist in ${where} (${shown}${more}). Overwrite?`;
    return new Promise((resolve) => {
      this.askValue = "";
      this.ask.set({
        title,
        value: "",
        confirm: true,
        okLabel: "Overwrite",
        onOk: () => resolve(true),
        onCancel: () => resolve(false),
      });
    });
  }

  private async runTransfer(
    dir: "up" | "down",
    name: string,
    run: (id: string) => Promise<void>,
  ): Promise<void> {
    const id = crypto.randomUUID();
    const unlisten = await this.sftp.onProgress(id, (p) =>
      this.patchTransfer(id, { transferred: p.transferred, total: p.total }),
    );
    this.transfers.update((list) => [
      ...list,
      { id, name, dir, transferred: 0, total: 0, done: false, unlisten },
    ]);
    try {
      await run(id);
      this.patchTransfer(id, { done: true });
      // Auto-clear a successful transfer after a moment.
      setTimeout(() => this.dismissTransfer(id), 4000);
    } catch (e) {
      this.patchTransfer(id, { done: true, error: String(e) });
    } finally {
      unlisten();
    }
  }

  private patchTransfer(id: string, patch: Partial<Transfer>): void {
    this.transfers.update((list) =>
      list.map((t) => (t.id === id ? { ...t, ...patch } : t)),
    );
  }

  dismissTransfer(id: string): void {
    this.transfers.update((list) => list.filter((t) => t.id !== id));
  }

  pct(t: Transfer): number {
    return t.total > 0 ? Math.min(100, (t.transferred / t.total) * 100) : t.done ? 100 : 0;
  }

  pctLabel(t: Transfer): string {
    return `${Math.round(this.pct(t))}%`;
  }

  // --- drag and drop between panes ---

  onDragStart(side: Side, entry: FileEntry): void {
    const sel = side === "local" ? this.localSel : this.remoteSel;
    if (!sel().has(entry.path)) sel.set(new Set([entry.path]));
    this.dragSide.set(side);
  }

  onDragOver(side: Side, event: DragEvent): void {
    // Only allow a drop on the opposite pane.
    if (this.dragSide() && this.dragSide() !== side) event.preventDefault();
  }

  async onDrop(side: Side, event: DragEvent): Promise<void> {
    event.preventDefault();
    const from = this.dragSide();
    this.dragSide.set(null);
    if (from === "remote" && side === "local") await this.download();
    else if (from === "local" && side === "remote") await this.upload();
  }

  // --- remote management (new folder / rename / delete) ---

  newFolder(): void {
    this.openAsk("New folder", "", false, "Create", (name) => {
      const n = name.trim();
      if (!n) return;
      this.sftp
        .mkdir(this.host().id, this.joinRemote(this.remotePath(), n))
        .then(() => this.openRemote(this.remotePath()))
        .catch((e) => this.remoteErr.set(String(e)));
    });
  }

  renameSelected(): void {
    const sel = [...this.remoteSel()];
    if (sel.length !== 1) return;
    const entry = this.remoteEntries().find((e) => e.path === sel[0]);
    if (!entry) return;
    this.openAsk("Rename", entry.name, false, "Rename", (name) => {
      const n = name.trim();
      if (!n || n === entry.name) return;
      this.sftp
        .rename(this.host().id, entry.path, this.joinRemote(this.remotePath(), n))
        .then(() => this.openRemote(this.remotePath()))
        .catch((e) => this.remoteErr.set(String(e)));
    });
  }

  deleteSelected(): void {
    const targets = this.remoteEntries().filter((e) =>
      this.remoteSel().has(e.path),
    );
    if (!targets.length) return;
    const label =
      targets.length === 1 ? `"${targets[0].name}"` : `${targets.length} items`;
    this.openAsk(`Delete ${label}?`, "", true, "Delete", () => {
      void (async () => {
        let err = "";
        for (const t of targets) {
          try {
            await this.sftp.remove(this.host().id, t.path, t.is_dir);
          } catch (e) {
            err = String(e);
          }
        }
        // Refresh first (it clears the error), then surface any failure — e.g.
        // "X isn't empty, so it can't be deleted" — so the message persists.
        await this.openRemote(this.remotePath());
        if (err) this.remoteErr.set(err);
      })();
    });
  }

  // --- name/confirm modal ---

  private openAsk(
    title: string,
    value: string,
    confirm: boolean,
    okLabel: string,
    onOk: (value: string) => void,
  ): void {
    this.askValue = value;
    this.ask.set({ title, value, confirm, okLabel, onOk });
  }

  confirmAsk(): void {
    const a = this.ask();
    this.ask.set(null);
    a?.onOk(this.askValue);
  }

  cancelAsk(): void {
    const a = this.ask();
    this.ask.set(null);
    a?.onCancel?.();
  }

  // --- helpers ---

  private parentOf(p: string, remote: boolean): string {
    if (remote) {
      const n = p.replace(/\/+$/, "");
      const i = n.lastIndexOf("/");
      return i <= 0 ? "/" : n.slice(0, i);
    }
    const n = p.replace(/[\\/]+$/, "");
    const i = Math.max(n.lastIndexOf("/"), n.lastIndexOf("\\"));
    if (i < 0) return p;
    if (i === 0) return n.slice(0, 1) || "/";
    const parent = n.slice(0, i);
    return /^[A-Za-z]:$/.test(parent) ? parent + "\\" : parent;
  }

  private joinRemote(dir: string, name: string): string {
    return dir === "/" || dir === "" ? `/${name}` : `${dir.replace(/\/+$/, "")}/${name}`;
  }

  private joinLocal(dir: string, name: string): string {
    const sep = dir.includes("\\") || /^[A-Za-z]:/.test(dir) ? "\\" : "/";
    return dir.replace(/[\\/]+$/, "") + sep + name;
  }

  fmtSize(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
    if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${bytes} B`;
  }

  fmtDate(secs: number | null): string {
    if (!secs) return "";
    const d = new Date(secs * 1000);
    return d.toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }
}
