import { Injectable, signal } from "@angular/core";

/**
 * Open-state for the shared About modal. Any entry point (topbar logo, the
 * Settings About section, or the macOS menu's "About" item) flips this, and the
 * AboutModalComponent — rendered once at the app root — shows the dialog. One
 * modal, identical on Windows, macOS and Linux.
 */
@Injectable({ providedIn: "root" })
export class AboutService {
  readonly open = signal(false);

  show(): void {
    this.open.set(true);
  }

  close(): void {
    this.open.set(false);
  }
}
