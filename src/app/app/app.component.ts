import {
  ChangeDetectorRef,
  Component,
  computed,
  HostListener,
  inject,
  OnDestroy,
  OnInit,
  signal,
} from "@angular/core";
import { FormsModule } from "@angular/forms";
import { open } from "@tauri-apps/plugin-dialog";
import { HostsService } from "../services/hosts.service";
import { ThemeService } from "../services/theme.service";
import { SshService } from "../services/ssh.service";
import { TerminalComponent } from "../terminal/terminal.component";
import { DashboardComponent } from "../dashboard/dashboard.component";
import { NotesManagerComponent } from "../notes-manager/notes-manager.component";
import { NotePanelComponent } from "../note-panel/note-panel.component";
import { SftpBrowserComponent } from "../sftp-browser/sftp-browser.component";
import { SelectComponent, SelectOption } from "../select/select.component";
import { SettingsComponent } from "../settings/settings.component";
import { ImportExportComponent } from "../import-export/import-export.component";
import { AboutModalComponent } from "../about-modal/about-modal.component";
import { AboutService } from "../services/about.service";
import { listen } from "@tauri-apps/api/event";
import { AutofocusDirective } from "../directives/autofocus.directive";
import { NotesService } from "../services/notes.service";
import { SftpService } from "../services/sftp.service";
import { SecretsService } from "../services/secrets.service";
import { UpdateService } from "../services/update.service";
import { ImportExportService } from "../services/import-export.service";
import { onBackButtonPress, exit } from "@tauri-apps/api/app";
import type { PluginListener } from "@tauri-apps/api/core";
import { Host } from "../models/host.model";
import { Note } from "../models/note.model";

type View = "terminals" | "dashboard" | "notes" | "settings";
/** Within the host workspace (terminals view), show the shells or the files. */
type WorkspaceMode = "terminal" | "files" | "commands";

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
  /** How to authenticate: a saved/prompted password, or a private key file. */
  authMethod: "password" | "key";
  /** Password typed in the form (saved to the OS keychain, never to config).
   *  Blank when editing keeps any already-saved password. */
  password: string;
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

/** State for the generic confirm-before-delete modal. */
interface ConfirmState {
  title: string;
  message: string;
  confirmLabel: string;
  onConfirm: () => void | Promise<void>;
}

@Component({
  selector: "app-root",
  imports: [
    FormsModule,
    TerminalComponent,
    DashboardComponent,
    NotesManagerComponent,
    NotePanelComponent,
    SftpBrowserComponent,
    SelectComponent,
    SettingsComponent,
    ImportExportComponent,
    AboutModalComponent,
    AutofocusDirective,
  ],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit, OnDestroy {
  private readonly hostsService = inject(HostsService);
  private readonly themeService = inject(ThemeService);
  private readonly ssh = inject(SshService);
  private readonly notesService = inject(NotesService);
  private readonly sftp = inject(SftpService);
  private readonly secrets = inject(SecretsService);
  private readonly update = inject(UpdateService);
  private readonly aboutService = inject(AboutService);
  private readonly io = inject(ImportExportService);
  private readonly cdr = inject(ChangeDetectorRef);

  /** Android back-button listener handle (null off Android / outside Tauri). */
  private backListener: PluginListener | null = null;

  readonly hosts = this.hostsService.hosts;
  readonly notes = this.notesService.notes;
  readonly theme = this.themeService.theme;
  /** True when the update check found a newer release — shows a dot on the
   * Settings nav item. */
  readonly updateAvailable = computed(
    () => this.update.status().state === "available",
  );

  readonly view = signal<View>("dashboard");
  /** Terminal vs Files within the active host's workspace. */
  readonly workspaceMode = signal<WorkspaceMode>("terminal");

  /** "commands" is a mobile-only workspace mode (driven by the bottom bar). If
   * the window grows to desktop width, fall back to the terminal — on desktop
   * the commands panel is a side column again, so there's no "commands" mode. */
  @HostListener("window:resize")
  onWorkspaceResize(): void {
    if (window.innerWidth > 760 && this.workspaceMode() === "commands") {
      this.workspaceMode.set("terminal");
    }
  }
  /** Mobile only: whether the host/nav sidebar drawer is open. On desktop the
   * sidebar is always in the layout and this flag is ignored by the CSS. */
  readonly sidebarOpen = signal(false);
  /** Host ids with at least one live terminal session — the single source of
   * truth for "connected". Drives both the sidebar list and the dashboard's
   * monitored state, so they can never disagree. Closing a host's last tab (or
   * its shell exiting) drops it from here automatically. */
  readonly connectedHostIds = computed(() => {
    const ids = new Set<string>();
    for (const s of this.sessions()) if (!s.closed) ids.add(s.host.id);
    return ids;
  });
  /** The host of the active terminal session — drives the notes side panel. */
  readonly activeHost = computed(
    () => this.sessions().find((s) => s.id === this.activeId())?.host ?? null,
  );
  /** The host currently being connected (for the "Connecting…" state). */
  readonly connectingHost = computed(() => {
    const id = this.connectingId();
    return id ? (this.hosts().find((h) => h.id === id) ?? null) : null;
  });
  /** Show the "Connecting…" screen in the terminal view: a connect is in flight
   * for a host that doesn't have a live terminal yet. */
  readonly showConnecting = computed(() => {
    const h = this.connectingHost();
    return !!h && !this.hasLiveSession(h);
  });
  /** Hosts with at least one live terminal session — the sidebar shows only
   * these; all hosts (connected or not) live on the Dashboard. */
  readonly connectedHosts = computed(() =>
    this.hosts().filter((h) => this.hasLiveSession(h)),
  );
  /** Sessions for the active host only, so the terminal tab bar shows just the
   * selected server's terminals (others stay open, just hidden). */
  readonly visibleSessions = computed(() => {
    const hostId = this.activeHost()?.id;
    const all = this.sessions();
    return hostId ? all.filter((s) => s.host.id === hostId) : all;
  });
  /** Scope options for the note form: Global (null) + each host. */
  readonly noteScopeOptions = computed<SelectOption[]>(() => [
    { value: null, label: "Global" },
    ...this.hosts().map((h) => ({ value: h.id, label: h.name || h.hostname })),
  ]);

  readonly sessions = signal<Session[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly connectingId = signal<string | null>(null);
  readonly error = signal<string>("");
  /** Last connection error per host id, shown on that host's dashboard card. */
  readonly connectErrors = signal<Record<string, string>>({});

  readonly showHostForm = signal(false);
  /** null = adding a new host; otherwise the id of the host being edited. */
  readonly editingHostId = signal<string | null>(null);
  /** True while editing a host that already has a password saved (shows a hint
   *  that leaving the field blank keeps it). */
  readonly editHasPassword = signal(false);
  /** Set when the user chose to remove the host's saved password on save. */
  readonly removeSavedPassword = signal(false);
  form: HostForm = AppComponent.blankForm();

  readonly secretPrompt = signal<SecretPrompt | null>(null);
  secretValue = "";
  private secretResolver: ((value: string | null) => void) | null = null;

  // Note add/edit modal + "run on which host?" picker.
  readonly showNoteForm = signal(false);
  readonly editingNoteId = signal<string | null>(null);
  noteForm: NoteForm = AppComponent.blankNoteForm();
  readonly runHostPicker = signal<string | null>(null);

  readonly confirmState = signal<ConfirmState | null>(null);
  /** When set, the "open a new terminal or go to the existing one?" modal is
   * shown for this host (which already has a live terminal). */
  readonly terminalChoice = signal<Host | null>(null);

  async ngOnInit(): Promise<void> {
    await Promise.all([this.loadHosts(), this.loadNotes()]);
    // Daily "is there a newer release?" check (if enabled and due). Runs in the
    // background; failures are swallowed so startup is never blocked by it. The
    // timer keeps it going daily even if the window stays open for days.
    // Always check on launch (ignores the cadence gate) so a still-pending
    // update's banner reappears every time the app is opened.
    void this.update.checkOnLaunch();
    this.update.startAutoTimer();
    // Desktop webviews throttle background timers, so also check when the window
    // regains focus/visibility (cadence-gated, so it won't spam).
    this.update.startFocusChecks();
    // macOS menu "About SSHStudio" → open the same in-app modal. No-op outside
    // Tauri (e.g. `ng serve`).
    void listen("open-about", () => this.aboutService.show()).catch(() => {});
    // Android hardware/gesture back: route it through our own navigation instead
    // of letting it close the app. onBackButtonPress fires on Android ONLY — on
    // desktop/iOS the handler is never called, and off-Tauri (`ng serve`) the
    // registration throws and is swallowed, so the web view is never affected.
    try {
      this.backListener = await onBackButtonPress(() => this.handleAndroidBack());
    } catch {
      // Not Android (or not running under Tauri): no back button to handle.
    }
  }

  ngOnDestroy(): void {
    void this.backListener?.unregister();
  }

  /**
   * Android back. Walks a sensible order: dismiss the topmost overlay, then step
   * out of a workspace sub-mode (Files/Commands → terminal), then fall back to
   * the Dashboard (the app's home), and only exit at the very root. Each step
   * reuses the same close/cancel methods the UI buttons call. Android-only — see
   * the registration in ngOnInit.
   */
  private handleAndroidBack(): void {
    // 1. Close whatever overlay is on top, if any.
    if (this.secretPrompt()) return this.cancelSecret();
    if (this.confirmState()) return this.confirmState.set(null);
    if (this.terminalChoice()) return this.cancelTerminalChoice();
    if (this.runHostPicker()) return this.cancelRunHost();
    if (this.showNoteForm()) return this.closeNoteForm();
    if (this.showHostForm()) return this.closeHostForm();
    if (this.aboutService.open()) return this.aboutService.close();
    if (this.io.mode()) return this.io.close();
    if (this.sidebarOpen()) return this.closeSidebar();

    // 2. In a host workspace, back out of Files/Commands to the terminal first.
    if (this.view() === "terminals" && this.workspaceMode() !== "terminal") {
      this.workspaceMode.set("terminal");
      return;
    }

    // 3. Not on the Dashboard? Go there rather than leaving the app.
    if (this.view() !== "dashboard") {
      this.setView("dashboard");
      return;
    }

    // 4. Root (Dashboard, nothing open): leave the app, like a normal Android app.
    void exit(0);
  }

  /** Open the shared About modal (topbar logo). */
  openAbout(): void {
    this.aboutService.show();
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
    this.closeSidebar();
  }

  /** Toggle the mobile sidebar drawer (no effect on the desktop layout). */
  toggleSidebar(): void {
    this.sidebarOpen.update((v) => !v);
  }

  /** Close the mobile sidebar drawer. Called after any sidebar action that
   * navigates or opens a modal, so the drawer gets out of the way on a phone.
   * A no-op on desktop, where the sidebar is always shown. */
  closeSidebar(): void {
    this.sidebarOpen.set(false);
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
    this.clearConnectError(host.id);
    this.connectingId.set(host.id);
    if (switchView) {
      this.view.set("terminals");
      this.workspaceMode.set("terminal");
    }
    try {
      await this.connectWith(host, undefined, undefined, runAfter);
    } finally {
      this.connectingId.set(null);
    }
  }

  /** Connect a host from the dashboard; once it connects, open its terminal.
   * Stays on the dashboard while connecting (and if it fails, so the card shows
   * the error), then switches to the Terminals view on success. */
  async connectForMetrics(host: Host): Promise<void> {
    await this.openHost(host, undefined, false);
    if (this.hasLiveSession(host)) {
      this.focusOrOpenHost(host);
    }
  }

  /** Open this host's terminal: focus its most recent live session if there is
   * one, otherwise open a new one. Switches to the Terminals view. */
  focusOrOpenHost(host: Host): void {
    const live = [...this.sessions()]
      .reverse()
      .find((s) => s.host.id === host.id && !s.closed);
    if (live) {
      this.activeId.set(live.id);
      this.view.set("terminals");
      this.workspaceMode.set("terminal");
    } else {
      void this.openHost(host);
    }
    this.closeSidebar();
  }

  /** Number of live (not closed) terminals open for a host. */
  liveSessionCount(host: Host): number {
    return this.sessions().filter((s) => s.host.id === host.id && !s.closed)
      .length;
  }

  /** Dashboard "open terminal" icon: if the host already has a live terminal,
   * ask whether to open another or switch to it; otherwise open one directly. */
  openTerminalFor(host: Host): void {
    if (this.sessions().some((s) => s.host.id === host.id && !s.closed)) {
      this.terminalChoice.set(host);
    } else {
      void this.openHost(host);
    }
  }

  chooseNewTerminal(): void {
    const host = this.terminalChoice();
    this.terminalChoice.set(null);
    if (host) void this.openHost(host);
  }

  chooseExistingTerminal(): void {
    const host = this.terminalChoice();
    this.terminalChoice.set(null);
    if (host) this.focusOrOpenHost(host);
  }

  cancelTerminalChoice(): void {
    this.terminalChoice.set(null);
  }

  /** Tab-bar "+": open another terminal for the active tab's server. */
  openAnotherForActive(): void {
    const host = this.activeHost();
    if (host) void this.openHost(host);
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
      // Adding the session marks the host connected (connectedHostIds derives
      // from live sessions), so it becomes eligible for dashboard metrics.
      this.clearConnectError(host.id);
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
        // A non-auth failure (host down, refused, timeout, bad key, …).
        // Record it against this host so its dashboard card shows which
        // server failed and why. On the dashboard the card already surfaces
        // it, so skip the global banner there; show it only when the failure
        // happens off-dashboard (e.g. opening a terminal), where no card is
        // visible.
        this.setConnectError(host.id, msg);
        if (this.view() !== "dashboard") {
          this.error.set(`${host.name || host.hostname}: ${msg}`);
        }
      }
    }
  }

  private setConnectError(hostId: string, msg: string): void {
    this.connectErrors.update((map) => ({ ...map, [hostId]: msg }));
  }

  private clearConnectError(hostId: string): void {
    this.connectErrors.update((map) => {
      if (!(hostId in map)) return map;
      const next = { ...map };
      delete next[hostId];
      return next;
    });
  }

  setActive(id: string): void {
    this.activeId.set(id);
  }

  markClosed(id: string): void {
    this.sessions.update((list) =>
      list.map((s) => (s.id === id ? { ...s, closed: true } : s)),
    );
  }

  /** Open a connected host's workspace on the Files (SFTP) side. */
  openSftp(host: Host, event?: Event): void {
    event?.stopPropagation();
    this.focusOrOpenHost(host); // make it the active host, in the Terminals view
    this.workspaceMode.set("files");
    this.closeSidebar();
  }

  /** Disconnect a host from the sidebar: close all its terminal sessions, so it
   * drops off the "Connected hosts" list and reverts to idle on the Dashboard
   * (metrics stop). Does not delete the saved host (that lives on the
   * Dashboard). */
  async disconnectHost(host: Host, event?: Event): Promise<void> {
    event?.stopPropagation();
    // Also close any SFTP session for this host.
    void this.sftp.disconnect(host.id);
    const ids = this.sessions()
      .filter((s) => s.host.id === host.id)
      .map((s) => s.id);
    for (const id of ids) {
      try {
        await this.ssh.disconnect(id);
      } catch {
        // already gone
      }
    }
    this.sessions.update((list) => list.filter((s) => s.host.id !== host.id));
    if (!this.sessions().some((s) => s.id === this.activeId())) {
      this.activeId.set(this.sessions()[0]?.id ?? null);
    }
    // No need to touch the dashboard: connectedHostIds derives from live
    // sessions, so removing them drops the host to the idle "Connect" state and
    // stops its metrics poller.
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
    this.editHasPassword.set(false);
    this.removeSavedPassword.set(false);
    this.showHostForm.set(true);
    this.closeSidebar();
  }

  /** Toggle "remove the saved password on save". */
  toggleRemovePassword(): void {
    this.removeSavedPassword.update((v) => !v);
  }

  /** Hint shown next to the Password label. */
  passwordHint(): string {
    if (!this.editHasPassword()) return "(optional)";
    return this.removeSavedPassword() ? "(will be removed on save)" : "(saved — leave blank to keep)";
  }

  openEditForm(host: Host, event?: Event): void {
    event?.stopPropagation();
    const identity = host.identity_file ?? "";
    this.form = {
      name: host.name,
      hostname: host.hostname,
      port: host.port,
      user: host.user,
      authMethod: identity.length > 0 ? "key" : "password",
      password: "",
      identity_file: identity,
      tags: host.tags.join(", "),
      notes: host.notes,
    };
    // Reflect whether a password is already saved for this host.
    this.editHasPassword.set(false);
    this.removeSavedPassword.set(false);
    void this.secrets.hasHostPassword(host.id).then((has) => {
      this.editHasPassword.set(has);
      this.cdr.markForCheck();
    });
    this.editingHostId.set(host.id);
    this.showHostForm.set(true);
    this.closeSidebar();
  }

  closeHostForm(): void {
    this.showHostForm.set(false);
  }

  /** Open the native file picker and put the chosen key file's path into the
   * form. `open` returns the selected path (string), or null if cancelled. */
  async browseIdentityFile(): Promise<void> {
    const selected = await open({
      multiple: false,
      directory: false,
      title: "Select private key",
    });
    if (typeof selected === "string") {
      this.form.identity_file = selected;
      // The native dialog resolves outside Angular; this app is zoneless, so
      // nudge change detection to refresh the input immediately.
      this.cdr.markForCheck();
    }
  }

  /** Name, hostname and user must be filled and the port a valid 1–65535. When
   * the "Private key" method is chosen, an identity file path is also required;
   * "Password" needs nothing extra (the password is asked for at connect time). */
  hostFormValid(): boolean {
    const f = this.form;
    const port = Number(f.port);
    return (
      f.name.trim().length > 0 &&
      f.hostname.trim().length > 0 &&
      f.user.trim().length > 0 &&
      Number.isInteger(port) &&
      port >= 1 &&
      port <= 65535 &&
      (f.authMethod !== "key" || f.identity_file.trim().length > 0)
    );
  }

  async saveHost(): Promise<void> {
    if (!this.hostFormValid()) return;
    this.error.set("");
    // Only keep the key path when the key method is chosen.
    const identity = this.form.identity_file.trim();
    const useKey = this.form.authMethod === "key" && identity.length > 0;
    const password = this.form.password;
    const fields = {
      name: this.form.name.trim(),
      hostname: this.form.hostname.trim(),
      port: Number(this.form.port) || 22,
      user: this.form.user.trim(),
      identity_file: useKey ? identity : null,
      tags: this.splitTags(this.form.tags),
      notes: this.form.notes.trim(),
    };
    try {
      const editingId = this.editingHostId();
      const hostId = editingId
        ? (await this.hostsService.update({ id: editingId, ...fields }), editingId)
        : (await this.hostsService.add(fields)).id;
      // Keep the keychain in step with the chosen method: a typed password is
      // saved; switching to key auth or choosing "remove" clears any stored one.
      // A blank password on edit (without "remove") leaves the saved one as is.
      if (useKey) {
        await this.secrets.deleteHostPassword(hostId);
      } else if (password.length > 0) {
        await this.secrets.saveHostPassword(hostId, password);
      } else if (this.removeSavedPassword()) {
        await this.secrets.deleteHostPassword(hostId);
      }
      this.showHostForm.set(false);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  deleteHost(host: Host, event?: Event): void {
    event?.stopPropagation();
    this.askConfirm({
      title: "Delete host",
      message: `Delete "${host.name || host.hostname}"? This removes it from your saved hosts.`,
      confirmLabel: "Delete host",
      onConfirm: () => this.doDeleteHost(host),
    });
  }

  private async doDeleteHost(host: Host): Promise<void> {
    this.error.set("");
    try {
      await this.hostsService.remove(host.id);
      // Don't leave an orphaned password behind in the keychain.
      await this.secrets.deleteHostPassword(host.id);
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

  /** Persist a manual reorder of commands from the Commands page. */
  async reorderNotes(orderedIds: string[]): Promise<void> {
    this.error.set("");
    try {
      await this.notesService.reorder(orderedIds);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  /** A note needs a name and at least one of command or text. */
  noteFormValid(): boolean {
    const f = this.noteForm;
    return (
      f.name.trim().length > 0 &&
      (f.command.trim().length > 0 || f.text.trim().length > 0)
    );
  }

  async saveNote(): Promise<void> {
    if (!this.noteFormValid()) return;
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

  deleteNote(note: Note): void {
    this.askConfirm({
      title: "Delete command",
      message: `Delete "${note.name || note.command || note.text || "this command"}"?`,
      confirmLabel: "Delete command",
      onConfirm: () => this.doDeleteNote(note),
    });
  }

  private async doDeleteNote(note: Note): Promise<void> {
    this.error.set("");
    try {
      await this.notesService.remove(note.id);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  // --- Confirm modal ---

  private askConfirm(state: ConfirmState): void {
    this.confirmState.set(state);
  }

  async confirmYes(): Promise<void> {
    const state = this.confirmState();
    this.confirmState.set(null);
    if (state) {
      await state.onConfirm();
    }
  }

  confirmNo(): void {
    this.confirmState.set(null);
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
      // Prefer the tab the user is currently on (when it's for this host), so a
      // command runs where they expect — not just the first tab of that host.
      const activeId = this.activeId();
      const active = this.sessions().find(
        (s) => s.id === activeId && !s.closed && s.host.id === note.host_id,
      );
      const live =
        active ??
        this.sessions().find((s) => s.host.id === note.host_id && !s.closed);
      if (live) {
        this.activeId.set(live.id);
        this.view.set("terminals");
        // Mobile only: running from the Commands pane should reveal the terminal
        // so you see the output. "commands" mode never happens on desktop, so
        // this leaves desktop behaviour unchanged.
        if (this.workspaceMode() === "commands") {
          this.workspaceMode.set("terminal");
        }
        await this.ssh.writePty(live.id, this.withEnter(command));
        return;
      }
      const host = this.hosts().find((h) => h.id === note.host_id);
      if (host) {
        await this.openHost(host, command);
      } else {
        this.error.set("The host for this command no longer exists.");
      }
      return;
    }

    // Global note.
    const active = this.activeId();
    const liveActive =
      active != null && this.sessions().some((s) => s.id === active && !s.closed);
    if (liveActive) {
      this.view.set("terminals");
      // Mobile only (see above): reveal the terminal after running.
      if (this.workspaceMode() === "commands") {
        this.workspaceMode.set("terminal");
      }
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
      authMethod: "password",
      password: "",
      identity_file: "",
      tags: "",
      notes: "",
    };
  }
}
