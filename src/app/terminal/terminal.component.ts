import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  effect,
  inject,
  input,
  output,
  viewChild,
} from "@angular/core";
import { Terminal, ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { UnlistenFn } from "@tauri-apps/api/event";
import { SshService } from "../services/ssh.service";
import { ThemeService, Theme } from "../services/theme.service";

/**
 * An xterm.js terminal bound to one SSH session. Streams shell output in,
 * sends keystrokes out, and keeps the PTY size in step with the container.
 * The session id is fixed for the component's lifetime.
 */
@Component({
  selector: "app-terminal",
  templateUrl: "./terminal.component.html",
  styleUrl: "./terminal.component.css",
})
export class TerminalComponent implements AfterViewInit, OnDestroy {
  readonly sessionId = input.required<string>();
  /** Whether this terminal's tab is currently shown. */
  readonly active = input<boolean>(false);
  /** A command to run once, right after the shell attaches (used when a note
   * opens a fresh terminal). Empty = nothing to run. */
  readonly pendingCommand = input<string>("");
  /** Emitted when the remote shell exits. */
  readonly closed = output<void>();

  private readonly ssh = inject(SshService);
  private readonly themeService = inject(ThemeService);
  private readonly hostRef =
    viewChild.required<ElementRef<HTMLDivElement>>("host");

  private term?: Terminal;
  private fit?: FitAddon;
  private resizeObserver?: ResizeObserver;
  private unlistenOutput?: UnlistenFn;
  private unlistenClosed?: UnlistenFn;

  constructor() {
    // Keep the terminal colors matched to the app theme.
    effect(() => {
      const theme = this.themeService.theme();
      if (this.term) {
        this.term.options.theme = TerminalComponent.palette(theme);
      }
    });
    // A hidden tab has zero size; re-fit once it becomes visible again.
    effect(() => {
      if (this.active() && this.term) {
        setTimeout(() => this.doFit(), 0);
      }
    });
  }

  async ngAfterViewInit(): Promise<void> {
    const term = new Terminal({
      fontFamily:
        'ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: TerminalComponent.palette(this.themeService.theme()),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(this.hostRef().nativeElement);
    this.term = term;
    this.fit = fit;

    const id = this.sessionId();

    this.unlistenOutput = await this.ssh.onOutput(id, (data) =>
      term.write(data),
    );
    this.unlistenClosed = await this.ssh.onClosed(id, () => {
      term.write("\r\n\x1b[90m[session closed]\x1b[0m\r\n");
      this.closed.emit();
    });

    term.onData((data) => void this.ssh.writePty(id, data));

    // Listeners are in place: start the stream, then size the PTY to the view.
    await this.ssh.attach(id);
    this.doFit();
    this.resizeObserver = new ResizeObserver(() => this.doFit());
    this.resizeObserver.observe(this.hostRef().nativeElement);
    term.focus();

    // If this terminal was opened to run a note, send it now.
    const pending = this.pendingCommand();
    if (pending.trim().length > 0) {
      void this.ssh.writePty(id, pending.endsWith("\n") ? pending : pending + "\n");
    }
  }

  /** Fit the terminal to the container and push the new size to the PTY. */
  private doFit(): void {
    if (!this.term || !this.fit) {
      return;
    }
    const el = this.hostRef().nativeElement;
    if (el.clientWidth === 0 || el.clientHeight === 0) {
      return; // hidden; skip until visible
    }
    try {
      this.fit.fit();
      void this.ssh.resizePty(this.sessionId(), this.term.cols, this.term.rows);
    } catch {
      // fit can throw if the element was detached mid-measure; ignore.
    }
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
    this.unlistenOutput?.();
    this.unlistenClosed?.();
    void this.ssh.disconnect(this.sessionId());
    this.term?.dispose();
  }

  private static palette(theme: Theme): ITheme {
    return theme === "dark"
      ? {
          background: "#0e1016",
          foreground: "#e7e9ee",
          cursor: "#ff8b33",
          selectionBackground: "#ff8b3340",
        }
      : {
          background: "#ffffff",
          foreground: "#171a1f",
          cursor: "#ed7a1e",
          selectionBackground: "#ff8b3333",
        };
  }
}
