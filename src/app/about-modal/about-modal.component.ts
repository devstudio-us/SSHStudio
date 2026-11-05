import { Component, HostListener, inject } from "@angular/core";
import { AboutService } from "../services/about.service";
import { UpdateService } from "../services/update.service";

/**
 * About dialog — the single, cross-platform "About SSHStudio" modal. Shown by
 * AboutService (topbar logo, Settings, or the macOS menu). Reuses the running
 * version from UpdateService and opens links externally.
 */
@Component({
  selector: "app-about-modal",
  templateUrl: "./about-modal.component.html",
  styleUrl: "./about-modal.component.css",
})
export class AboutModalComponent {
  readonly about = inject(AboutService);
  private readonly update = inject(UpdateService);

  readonly version = this.update.version;

  readonly links = {
    repo: "https://github.com/devstudio-us/SSHStudio",
    releases: "https://github.com/devstudio-us/SSHStudio/releases",
    issues: "https://github.com/devstudio-us/SSHStudio/issues",
    license: "https://github.com/devstudio-us/SSHStudio/blob/main/LICENSE",
  };

  open(url: string): void {
    void this.update.openExternal(url);
  }

  @HostListener("document:keydown.escape")
  onEsc(): void {
    if (this.about.open()) this.about.close();
  }
}
