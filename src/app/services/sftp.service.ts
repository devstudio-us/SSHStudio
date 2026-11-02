import { Injectable } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { FileEntry } from "../models/file-entry.model";

/** Payload of a `sftp-progress-<id>` event. */
export interface TransferProgress {
  transferred: number;
  total: number;
}

/** Thin wrapper over the Rust SFTP + local-filesystem commands. All product
 * logic lives in the components; this just crosses the IPC boundary. */
@Injectable({ providedIn: "root" })
export class SftpService {
  // --- local filesystem (left pane) ---
  localHome(): Promise<string> {
    return invoke<string>("local_home");
  }
  localList(path: string): Promise<FileEntry[]> {
    return invoke<FileEntry[]>("local_list", { path });
  }

  // --- remote filesystem (right pane) ---
  remoteHome(hostId: string): Promise<string> {
    return invoke<string>("sftp_home", { hostId });
  }
  remoteList(hostId: string, path: string): Promise<FileEntry[]> {
    return invoke<FileEntry[]>("sftp_list", { hostId, path });
  }
  mkdir(hostId: string, path: string): Promise<void> {
    return invoke("sftp_mkdir", { hostId, path });
  }
  rename(hostId: string, from: string, to: string): Promise<void> {
    return invoke("sftp_rename", { hostId, from, to });
  }
  remove(hostId: string, path: string, isDir: boolean): Promise<void> {
    return invoke("sftp_delete", { hostId, path, isDir });
  }
  disconnect(hostId: string): Promise<void> {
    return invoke("sftp_disconnect", { hostId });
  }

  // --- transfers ---
  download(
    hostId: string,
    remotePath: string,
    localPath: string,
    transferId: string,
  ): Promise<void> {
    return invoke("sftp_download", { hostId, remotePath, localPath, transferId });
  }
  upload(
    hostId: string,
    localPath: string,
    remotePath: string,
    transferId: string,
  ): Promise<void> {
    return invoke("sftp_upload", { hostId, localPath, remotePath, transferId });
  }
  downloadDir(
    hostId: string,
    remotePath: string,
    localPath: string,
    transferId: string,
  ): Promise<void> {
    return invoke("sftp_download_dir", { hostId, remotePath, localPath, transferId });
  }
  uploadDir(
    hostId: string,
    localPath: string,
    remotePath: string,
    transferId: string,
  ): Promise<void> {
    return invoke("sftp_upload_dir", { hostId, localPath, remotePath, transferId });
  }
  onProgress(
    transferId: string,
    cb: (p: TransferProgress) => void,
  ): Promise<UnlistenFn> {
    return listen<TransferProgress>(`sftp-progress-${transferId}`, (e) =>
      cb(e.payload),
    );
  }
}
