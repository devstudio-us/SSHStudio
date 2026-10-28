import { Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { Host, NewHost } from "../models/host.model";

/**
 * Thin wrapper over the hosts Tauri commands. Holds the current list in a
 * signal so components can render it reactively; every mutation re-reads from
 * the backend so the UI always reflects what's actually on disk.
 */
@Injectable({ providedIn: "root" })
export class HostsService {
  readonly hosts = signal<Host[]>([]);

  async refresh(): Promise<void> {
    this.hosts.set(await invoke<Host[]>("list_hosts"));
  }

  async add(host: NewHost): Promise<void> {
    // `id` is minted server-side; send an empty one to satisfy the struct.
    await invoke<Host>("add_host", { host: { ...host, id: "" } });
    await this.refresh();
  }

  async update(host: Host): Promise<void> {
    await invoke<Host>("update_host", { host });
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await invoke("delete_host", { id });
    await this.refresh();
  }
}
