import {
  Component,
  ElementRef,
  computed,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from "@angular/core";
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

  /** A section with no notes starts collapsed; a non-empty one starts open.
   * linkedSignal keeps that as the default while still allowing a manual
   * toggle — the default is re-applied only when the section's emptiness
   * flips (e.g. its first note is added or its last one removed). */
  private readonly hostEmpty = computed(() => this.hostNotes().length === 0);
  private readonly globalEmpty = computed(
    () => this.globalNotes().length === 0,
  );
  readonly hostCollapsed = linkedSignal(() => this.hostEmpty());
  readonly globalCollapsed = linkedSignal(() => this.globalEmpty());

  readonly globalNotes = computed(() =>
    this.notes().filter((n) => !n.host_id),
  );
  readonly hostNotes = computed(() =>
    this.notes().filter((n) => n.host_id === this.host().id),
  );

  /** Both sections open → the divider is draggable to resize their heights. */
  readonly bothOpen = computed(
    () => !this.hostCollapsed() && !this.globalCollapsed(),
  );
  /** Fraction of the split height given to the top (host) section. */
  readonly topRatio = signal(0.5);
  readonly dragging = signal(false);
  private readonly splitRef = viewChild<ElementRef<HTMLElement>>("splitRef");

  startDrag(event: PointerEvent): void {
    event.preventDefault();
    this.dragging.set(true);
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
  }

  onDrag(event: PointerEvent): void {
    if (!this.dragging()) return;
    const el = this.splitRef()?.nativeElement;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0) return;
    const ratio = (event.clientY - rect.top) / rect.height;
    this.topRatio.set(Math.min(0.85, Math.max(0.15, ratio)));
  }

  endDrag(event: PointerEvent): void {
    this.dragging.set(false);
    (event.target as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

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
