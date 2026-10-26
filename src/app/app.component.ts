import { Component, inject, OnInit, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { HostsService } from "./hosts.service";
import { Host } from "./host.model";

/** Local shape of the "Add host" form. Kept separate from `Host` because tags
 * are edited as a comma-separated string and the port as a plain input. */
interface HostForm {
  name: string;
  hostname: string;
  port: number;
  user: string;
  identity_file: string;
  tags: string;
  notes: string;
}

@Component({
  selector: "app-root",
  imports: [FormsModule],
  templateUrl: "./app.component.html",
  styleUrl: "./app.component.css",
})
export class AppComponent implements OnInit {
  private readonly hostsService = inject(HostsService);

  readonly hosts = this.hostsService.hosts;
  readonly selected = signal<Host | null>(null);
  readonly error = signal<string>("");

  form: HostForm = AppComponent.blankForm();

  async ngOnInit(): Promise<void> {
    await this.load();
  }

  async load(): Promise<void> {
    this.error.set("");
    try {
      await this.hostsService.refresh();
    } catch (e) {
      this.error.set(String(e));
    }
  }

  select(host: Host): void {
    this.selected.set(host);
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
      this.form = AppComponent.blankForm();
    } catch (e) {
      this.error.set(String(e));
    }
  }

  async deleteHost(host: Host, event: Event): Promise<void> {
    event.stopPropagation();
    this.error.set("");
    try {
      await this.hostsService.remove(host.id);
      if (this.selected()?.id === host.id) {
        this.selected.set(null);
      }
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
