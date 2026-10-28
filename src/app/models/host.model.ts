/** Mirrors the Rust `Host` struct. Field names are snake_case to match the
 * serde payload crossing the Tauri IPC boundary. */
export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  user: string;
  identity_file: string | null;
  tags: string[];
  notes: string;
}

/** A host that has not been saved yet — the backend assigns `id`. */
export type NewHost = Omit<Host, "id">;
