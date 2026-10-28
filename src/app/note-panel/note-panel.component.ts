import { Component, computed, input, output, signal } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { Note } from "../models/note.model";
import { Host } from "../models/host.model";

/**
 * Notes panel shown beside an open terminal. Top section = global notes,
 * bottom = notes scoped to this terminal's host. Run/copy/edit/add bubble up;
 * the panel can be collapsed to a thin rail.
 */
@Component({
  selector: "app-note-panel",
  templateUrl: "./note-panel.component.html",
  styleUrl: "./note-panel.component.css",
  imports: [NgTemplateOutlet],
})
export class NotePanelComponent {
  readonly host = input.required<Host>();
  readonly notes = input.required<Note[]>();

  readonly run = output<Note>();
  readonly edit = output<Note>();
  /** Emits the scope for a new note: a host id, or null for global. */
  readonly add = output<string | null>();

  readonly collapsed = signal(false);
  readonly copiedId = signal<string | null>(null);

  readonly globalNotes = computed(() =>
    this.notes().filter((n) => !n.host_id),
  );
  readonly hostNotes = computed(() =>
    this.notes().filter((n) => n.host_id === this.host().id),
  );

  async copy(note: Note): Promise<void> {
    try {
      await navigator.clipboard.writeText(note.command || note.text);
      this.copiedId.set(note.id);
      setTimeout(() => this.copiedId.set(null), 1000);
    } catch {
      // ignore
    }
  }
}
