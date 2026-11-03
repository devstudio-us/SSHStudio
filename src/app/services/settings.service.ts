import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";

/** App preferences persisted by the Rust backend in `settings.toml`. */
export interface AppSettings {
  /** SFTP download folder, or null until the user has chosen one. */
  download_dir: string | null;
}

/** Thin wrapper over the Rust settings commands. */
@Injectable({ providedIn: "root" })
export class SettingsService {
  getSettings(): Promise<AppSettings> {
    return invoke<AppSettings>("get_settings");
  }
  /** Save the SFTP download folder (empty string clears it). */
  setDownloadDir(dir: string): Promise<AppSettings> {
    return invoke<AppSettings>("set_download_dir", { dir });
  }
}
