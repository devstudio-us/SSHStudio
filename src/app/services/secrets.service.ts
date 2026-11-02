import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

/** Thin wrapper over the OS-keychain commands for saved host passwords.
 *  Passwords live in the keychain, never in the TOML config. */
@Injectable({ providedIn: "root" })
export class SecretsService {
  saveHostPassword(hostId: string, password: string): Promise<void> {
    return invoke("save_host_password", { hostId, password });
  }
  deleteHostPassword(hostId: string): Promise<void> {
    return invoke("delete_host_password", { hostId });
  }
  hasHostPassword(hostId: string): Promise<boolean> {
    return invoke<boolean>("has_host_password", { hostId });
  }
}
