/** Mirrors the Rust `Note` struct. `host_id` null = global; a non-empty
 * `command` makes the note runnable. */
export interface Note {
  id: string;
  name: string;
  tags: string[];
  text: string;
  command: string;
  host_id: string | null;
}

/** A note not yet saved — the backend assigns `id`. */
export type NewNote = Omit<Note, "id">;
