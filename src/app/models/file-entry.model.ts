/** A file or directory in either pane. Mirrors the Rust `FileEntry` (snake_case
 * to match the serde payload crossing the Tauri IPC boundary). */
export interface FileEntry {
  name: string;
  /** Full path: POSIX for remote, native for local. */
  path: string;
  is_dir: boolean;
  size: number;
  /** Last-modified Unix timestamp (seconds), or null if unknown. */
  modified: number | null;
}
