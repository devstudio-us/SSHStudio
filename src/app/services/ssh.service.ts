import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";

/**
 * Wraps the SSH Tauri commands and the per-session output/closed events.
 * Argument keys are camelCase; Tauri maps them to the snake_case Rust params.
 */
@Injectable({ providedIn: "root" })
export class SshService {
  /** Open a session; resolves to its id. `password` is also the key passphrase
   * for key-auth hosts. May reject with the sentinels PASSWORD_REQUIRED /
   * PASSPHRASE_REQUIRED, which the caller turns into a prompt. */
  connect(hostId: string, password?: string): Promise<string> {
    return invoke<string>("connect", { hostId, password: password ?? null });
  }

  /** Start streaming output for a session. Call only after subscribing to its
   * events, so the initial shell banner isn't lost. */
  attach(sessionId: string): Promise<void> {
    return invoke("attach", { sessionId });
  }

  disconnect(sessionId: string): Promise<void> {
    return invoke("disconnect", { sessionId });
  }

  writePty(sessionId: string, data: string): Promise<void> {
    return invoke("write_pty", { sessionId, data });
  }

  resizePty(sessionId: string, cols: number, rows: number): Promise<void> {
    return invoke("resize_pty", { sessionId, cols, rows });
  }

  /** Shell output arrives as a byte array; hand it to the callback as bytes. */
  onOutput(
    sessionId: string,
    cb: (data: Uint8Array) => void,
  ): Promise<UnlistenFn> {
    return listen<number[]>(`pty-output-${sessionId}`, (event) =>
      cb(new Uint8Array(event.payload)),
    );
  }

  /** Fires once when the shell exits or the channel closes. */
  onClosed(sessionId: string, cb: () => void): Promise<UnlistenFn> {
    return listen(`pty-closed-${sessionId}`, () => cb());
  }
}
