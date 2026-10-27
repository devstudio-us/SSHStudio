import { Component, computed, inject, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HostsService } from "./hosts.service";
import { ThemeService } from "./theme.service";
import { SshService } from "./ssh.service";
import { TerminalComponent } from "./terminal.component";
import { DashboardComponent } from "./dashboard.component";
import { NotesManagerComponent } from "./notes-manager.component";
import { NotePanelComponent } from "./note-panel.component";
import { NotesService } from "./notes.service";
import { Host } from "./host.model";
import { Note } from "./note.model";

type View = "terminals" | "dashboard" | "notes";

/** An open (or recently closed) SSH session shown as a terminal tab. */
interface Session {
  id: string;
  host: Host;
  closed: boolean;
  /** A command to run once the shell attaches (set when a note opened it). */
  pendingCommand?: string;
}

/** Local shape of the add/edit note form (tags edited as a comma string). */
interface NoteForm {
  name: string;
  tags: string;
  text: string;
  command: string;
  hostId: string | null;
}

/** Local shape of the "Add host" form (tags edited as a comma string). */
interface HostForm {
  name: string;
  hostname: string;
  port: number;
  user: string;
  identity_file: string;
  tags: string;
  notes: string;
}

/** State for the modal that asks for a password or key passphrase. */
interface SecretPrompt {
  host: Host;
  title: string;
  error?: string;
}

@Component({
  selector: "app-root",
  imports: [
    FormsModule,
    TerminalComponent,
    DashboardComponent,
    NotesManagerComponent,
    NotePanelComponent,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit {
  private readonly hostsService = inject(HostsService);
  private readonly themeService = inject(ThemeService);
  private readonly ssh = inject(SshService);
  private readonly notesService = inject(NotesService);

  readonly hosts = this.hostsService.hosts;
  readonly notes = this.notesService.notes;
  readonly theme = this.themeService.theme;

  readonly view = signal<View>("dashboard");
  /** Host ids connected at least once this session — the dashboard polls these;
   * other hosts still appear on the dashboard, just inactive. */
  readonly connectedHostIds = signal<Set<string>>(new Set());
  /** The host of the active terminal session — drives the notes side panel. */
  readonly activeHost = computed(
    () => this.sessions().find((s) => s.id === this.activeId())?.host ?? null,
  );

  readonly sessions = signal<Session[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly connectingId = signal<string | null>(null);
  readonly error = signal<string>("");

  readonly showHostForm = signal(false);
  /** null = adding a new host; otherwise the id of the host being edited. */
  readonly editingHostId = signal<string | null>(null);
  form: HostForm = AppComponent.blankForm();

  readonly secretPrompt = signal<SecretPrompt | null>(null);
  secretValue = "";
  private secretResolver: ((value: string | null) => void) | null = null;

  // Note add/edit modal + "run on which host?" picker.
  readonly showNoteForm = signal(false);
  readonly editingNoteId = signal<string | null>(null);
  noteForm: NoteForm = AppComponent.blankNoteForm();
  readonly runHostPicker = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadHosts(), this.loadNotes()]);
  }

  async loadHosts(): Promise<void> {
    try {
      await this.hostsService.refresh();
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async loadNotes(): Promise<void> {
    try {
      await this.notesService.refresh();
    } catch (e) {
      this.error.set(String(e));
    }
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }

  setView(view: View): void {
    this.view.set(view);
  }

  // --- Sessions / tabs ---

  /** True if the host has at least one live (not closed) session. */
  hasLiveSession(host: Host): boolean {
    return this.sessions().some((s) => s.host.id === host.id && !s.closed);
  }

  async openHost(
    host: Host,
    runAfter?: string,
    switchView = true,
  ): Promise<void> {
    this.error.set("");
    this.connectingId.set(host.id);
    if (switchView) {
      this.view.set("terminals");
    }
    try {
      await this.connectWith(host, undefined, undefined, runAfter);
    } finally {
      this.connectingId.set(null);
    }
  }

  /** Connect a host to start monitoring it, without leaving the dashboard. */
  connectForMetrics(host: Host): void {
    void this.openHost(host, undefined, false);
  }

  /** Attempt a connection, prompting for a secret and retrying on the
   * PASSWORD_REQUIRED / PASSPHRASE_REQUIRED sentinels (or a bad secret).
   * `runAfter`, if set, is a command the new terminal runs once attached. */
  private async connectWith(
    host: Host,
    secret: string | undefined,
    modalError?: string,
    runAfter?: string,
  ): Promise<void> {
    try {
      const id = await this.ssh.connect(host.id, secret);
      this.sessions.update((list) => [
        ...list,
        { id, host, closed: false, pendingCommand: runAfter },
      ]);
      this.activeId.set(id);
      // Now eligible for metrics polling on the dashboard.
      this.connectedHostIds.update((set) => new Set(set).add(host.id));
    } catch (e) {
      const msg = String(e);
      const usesKey = !!host.identity_file && host.identity_file.length > 0;

      if (msg.includes("PASSPHRASE_REQUIRED") || msg.includes("passphrase")) {
        const pass = await this.promptSecret(
          host,
          `Passphrase for ${host.identity_file}`,
          msg.includes("Incorrect") ? "Incorrect passphrase." : modalError,
        );
        if (pass !== null) {
          await this.connectWith(host, pass, undefined, runAfter);
        }
      } else if (
        msg.includes("PASSWORD_REQUIRED") ||
        (!usesKey && msg.includes("Authentication failed"))
      ) {
        const pw = await this.promptSecret(
          host,
          `Password for ${host.user}@${host.hostname}`,
          msg.includes("Authentication failed")
            ? "Authentication failed."
            : modalError,
        );
        if (pw !== null) {
          await this.connectWith(host, pw, undefined, runAfter);
        }
      } else {
        this.error.set(msg);
      }
    }
  }

  setActive(id: string): void {
    this.activeId.set(id);
  }

  markClosed(id: string): void {
    this.sessions.update((list) =>
      list.map((s) => (s.id === id ? { ...s, closed: true } : s)),
    );
  }

  async closeSession(id: string, event?: Event): Promise<void> {
    event?.stopPropagation();
    try {
      await this.ssh.disconnect(id);
    } catch {
      // already gone
    }
    this.sessions.update((list) => list.filter((s) => s.id !== id));
    if (this.activeId() === id) {
      this.activeId.set(this.sessions()[0]?.id ?? null);
    }
  }

  // --- Secret prompt modal ---

  private promptSecret(
    host: Host,
    title: string,
    error?: string,
  ): Promise<string | null> {
    this.secretValue = "";
    this.secretPrompt.set({ host, title, error });
    return new Promise((resolve) => (this.secretResolver = resolve));
  }

  submitSecret(): void {
    const value = this.secretValue;
    this.secretValue = "";
    this.secretPrompt.set(null);
    this.secretResolver?.(value);
    this.secretResolver = null;
  }

  cancelSecret(): void {
    this.secretValue = "";
    this.secretPrompt.set(null);
    this.secretResolver?.(null);
    this.secretResolver = null;
  }

  // --- Add / edit / delete host ---

  openAddForm(): void {
    this.form = AppComponent.blankForm();
    this.editingHostId.set(null);
    this.showHostForm.set(true);
  }

  openEditForm(host: Host, event?: Event): void {
    event?.stopPropagation();
    this.form = {
      name: host.name,
      hostname: host.hostname,
      port: host.port,
      user: host.user,
      identity_file: host.identity_file ?? "",
      tags: host.tags.join(", "),
      notes: host.notes,
    };
    this.editingHostId.set(host.id);
    this.showHostForm.set(true);
  }

  closeHostForm(): void {
    this.showHostForm.set(false);
  }

  async saveHost(): Promise<void> {
    this.error.set("");
    const identity = this.form.identity_file.trim();
    const fields = {
      name: this.form.name.trim(),
      hostname: this.form.hostname.trim(),
      port: Number(this.form.port) || 22,
      user: this.form.user.trim(),
      identity_file: identity.length > 0 ? identity : null,
      tags: this.splitTags(this.form.tags),
      notes: this.form.notes.trim(),
    };
    try {
      const editingId = this.editingHostId();
      if (editingId) {
        await this.hostsService.update({ id: editingId, ...fields });
      } else {
        await this.hostsService.add(fields);
      }
      this.showHostForm.set(false);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async deleteHost(host: Host, event?: Event): Promise<void> {
    event?.stopPropagation();
    this.error.set("");
    try {
      await this.hostsService.remove(host.id);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  // --- Notes: add / edit / delete ---

  /** Open the note modal in add mode, optionally pre-scoped to a host. */
  openNoteForm(hostId: string | null = null): void {
    this.noteForm = { ...AppComponent.blankNoteForm(), hostId };
    this.editingNoteId.set(null);
    this.showNoteForm.set(true);
  }

  openNoteEdit(note: Note): void {
    this.noteForm = {
      name: note.name,
      tags: note.tags.join(", "),
      text: note.text,
      command: note.command,
      hostId: note.host_id,
    };
    this.editingNoteId.set(note.id);
    this.showNoteForm.set(true);
  }

  closeNoteForm(): void {
    this.showNoteForm.set(false);
  }

  async saveNote(): Promise<void> {
    this.error.set("");
    const fields = {
      name: this.noteForm.name.trim(),
      tags: this.splitTags(this.noteForm.tags),
      text: this.noteForm.text.trim(),
      command: this.noteForm.command.replace(/\s+$/, ""),
      host_id: this.noteForm.hostId,
    };
    try {
      const editingId = this.editingNoteId();
      if (editingId) {
        await this.notesService.update({ id: editingId, ...fields });
      } else {
        await this.notesService.add(fields);
      }
      this.showNoteForm.set(false);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async deleteNote(note: Note): Promise<void> {
    this.error.set("");
    try {
      await this.notesService.remove(note.id);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  // --- Notes: run ---

  /** Run a note's command. Host-scoped notes target that host's terminal
   * (opening it if needed); global notes target the active terminal, or prompt
   * for a host when none is open. */
  async runNote(note: Note): Promise<void> {
    const command = note.command;
    if (!command.trim()) {
      return;
    }

    if (note.host_id) {
      const live = this.sessions().find(
        (s) => s.host.id === note.host_id && !s.closed,
      );
      if (live) {
        this.activeId.set(live.id);
        this.view.set("terminals");
        await this.ssh.writePty(live.id, this.withEnter(command));
        return;
      }
      const host = this.hosts().find((h) => h.id === note.host_id);
      if (host) {
        await this.openHost(host, command);
      } else {
        this.error.set("The host for this note no longer exists.");
      }
      return;
    }

    // Global note.
    const active = this.activeId();
    const liveActive =
      active != null && this.sessions().some((s) => s.id === active && !s.closed);
    if (liveActive) {
      this.view.set("terminals");
      await this.ssh.writePty(active, this.withEnter(command));
    } else {
      this.runHostPicker.set(command); // ask which host to run on
    }
  }

  chooseRunHost(host: Host): void {
    const command = this.runHostPicker();
    this.runHostPicker.set(null);
    if (command != null) {
      void this.openHost(host, command);
    }
  }

  cancelRunHost(): void {
    this.runHostPicker.set(null);
  }

  private withEnter(command: string): string {
    return command.endsWith("\n") ? command : command + "\n";
  }

  private splitTags(raw: string): string[] {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  private static blankNoteForm(): NoteForm {
    return { name: "", tags: "", text: "", command: "", hostId: null };
  }

  private static blankForm(): HostForm {
    return {
      name: "",
      hostname: "",
      port: 22,
      user: "",
      identity_file: "",
      tags: "",
      notes: "",
    };
  }
}
