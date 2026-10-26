import { Component, inject, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HostsService } from "./hosts.service";
import { ThemeService } from "./theme.service";
import { SshService } from "./ssh.service";
import { TerminalComponent } from "./terminal.component";
import { Host } from "./host.model";

/** An open (or recently closed) SSH session shown as a terminal tab. */
interface Session {
  id: string;
  host: Host;
  closed: boolean;
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
  imports: [FormsModule, TerminalComponent],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit {
  private readonly hostsService = inject(HostsService);
  private readonly themeService = inject(ThemeService);
  private readonly ssh = inject(SshService);

  readonly hosts = this.hostsService.hosts;
  readonly theme = this.themeService.theme;

  readonly sessions = signal<Session[]>([]);
  readonly activeId = signal<string | null>(null);
  readonly connectingId = signal<string | null>(null);
  readonly error = signal<string>("");

  readonly showAddForm = signal(false);
  form: HostForm = AppComponent.blankForm();

  readonly secretPrompt = signal<SecretPrompt | null>(null);
  secretValue = "";
  private secretResolver: ((value: string | null) => void) | null = null;

  async ngOnInit(): Promise<void> {
    await this.loadHosts();
  }

  async loadHosts(): Promise<void> {
    try {
      await this.hostsService.refresh();
    } catch (e) {
      this.error.set(String(e));
    }
  }

  toggleTheme(): void {
    this.themeService.toggle();
  }

  // --- Sessions / tabs ---

  /** True if the host has at least one live (not closed) session. */
  hasLiveSession(host: Host): boolean {
    return this.sessions().some((s) => s.host.id === host.id && !s.closed);
  }

  async openHost(host: Host): Promise<void> {
    this.error.set("");
    this.connectingId.set(host.id);
    try {
      await this.connectWith(host, undefined);
    } finally {
      this.connectingId.set(null);
    }
  }

  /** Attempt a connection, prompting for a secret and retrying on the
   * PASSWORD_REQUIRED / PASSPHRASE_REQUIRED sentinels (or a bad secret). */
  private async connectWith(
    host: Host,
    secret: string | undefined,
    modalError?: string,
  ): Promise<void> {
    try {
      const id = await this.ssh.connect(host.id, secret);
      this.sessions.update((list) => [...list, { id, host, closed: false }]);
      this.activeId.set(id);
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
          await this.connectWith(host, pass);
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
          await this.connectWith(host, pw);
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

  // --- Add / delete host ---

  openAddForm(): void {
    this.form = AppComponent.blankForm();
    this.showAddForm.set(true);
  }

  closeAddForm(): void {
    this.showAddForm.set(false);
  }

  async addHost(): Promise<void> {
    this.error.set("");
    try {
      const identity = this.form.identity_file.trim();
      await this.hostsService.add({
        name: this.form.name.trim(),
        hostname: this.form.hostname.trim(),
        port: Number(this.form.port) || 22,
        user: this.form.user.trim(),
        identity_file: identity.length > 0 ? identity : null,
        tags: this.splitTags(this.form.tags),
        notes: this.form.notes.trim(),
      });
      this.showAddForm.set(false);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async deleteHost(host: Host, event: Event): Promise<void> {
    event.stopPropagation();
    this.error.set("");
    try {
      await this.hostsService.remove(host.id);
    } catch (e) {
      this.error.set(String(e));
    }
  }

  private splitTags(raw: string): string[] {
    return raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
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
