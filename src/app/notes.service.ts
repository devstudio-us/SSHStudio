import { Injectable, signal } from "@angular/core";
import { invoke } from "@tauri-apps/api/core";
import { Note, NewNote } from "./note.model";

/** CRUD over the notes Tauri commands, with the list held in a signal. */
@Injectable({ providedIn: "root" })
export class NotesService {
  readonly notes = signal<Note[]>([]);

  async refresh(): Promise<void> {
    this.notes.set(await invoke<Note[]>("list_notes"));
  }

  async add(note: NewNote): Promise<void> {
    await invoke<Note>("add_note", { note: { ...note, id: "" } });
    await this.refresh();
  }

  async update(note: Note): Promise<void> {
    await invoke<Note>("update_note", { note });
    await this.refresh();
  }

  async remove(id: string): Promise<void> {
    await invoke("delete_note", { id });
    await this.refresh();
  }
}
