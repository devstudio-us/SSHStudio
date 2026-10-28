import {
  AfterViewInit,
  Component,
  ElementRef,
  OnDestroy,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";
import { SelectComponent, SelectOption } from "../select/select.component";
import { Note } from "../models/note.model";
import { Host } from "../models/host.model";

const MIN_COL_WIDTH = 340; // px per column before adding another

/**
 * Full-page manager for notes: list, filter by scope (Global / a host), search
 * by name/text/tags, and run/copy/edit/delete each. CRUD intents bubble up to
 * the app component (which owns the note modal and run logic); copy is handled
 * here since it needs nothing else.
 */
@Component({
  selector: "app-notes-manager",
  imports: [SelectComponent],
  templateUrl: "./notes-manager.component.html",
  styleUrl: "./notes-manager.component.css",
})
export class NotesManagerComponent implements AfterViewInit, OnDestroy {
  readonly notes = input.required<Note[]>();
  readonly hosts = input.required<Host[]>();

  readonly run = output<Note>();
  readonly edit = output<Note>();
  readonly remove = output<Note>();
  readonly addNew = output<void>();

  readonly query = signal("");
  readonly scopeFilter = signal("all");
  readonly copiedId = signal<string | null>(null);

  private readonly host = inject(ElementRef<HTMLElement>);
  private resizeObserver?: ResizeObserver;
  /** Available width for the columns; drives the responsive column count. */
  private readonly width = signal(0);

  /** Number of columns that fit, from 1 up. */
  readonly columnCount = computed(() =>
    Math.max(1, Math.floor((this.width() || MIN_COL_WIDTH) / MIN_COL_WIDTH)),
  );

  /** Filtered notes distributed across columns round-robin by index, so the
   * first row reads left-to-right and each column still packs tightly. */
  readonly noteColumns = computed<Note[][]>(() => {
    const n = this.columnCount();
    const cols: Note[][] = Array.from({ length: n }, () => []);
    this.filtered().forEach((note, i) => cols[i % n].push(note));
    return cols;
  });

  ngAfterViewInit(): void {
    const el = this.host.nativeElement;
    this.resizeObserver = new ResizeObserver(() => {
      // Subtract the host's horizontal padding to get the usable track width.
      const style = getComputedStyle(el);
      const pad =
        parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
      this.width.set(Math.max(0, el.clientWidth - pad));
    });
    this.resizeObserver.observe(el);
  }

  ngOnDestroy(): void {
    this.resizeObserver?.disconnect();
  }

  readonly scopeOptions = computed<SelectOption[]>(() => [
    { value: "all", label: "All scopes" },
    { value: "global", label: "Global" },
    ...this.hosts().map((h) => ({ value: h.id, label: h.name || h.hostname })),
  ]);

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    const scope = this.scopeFilter();
    return this.notes().filter((n) => {
      if (scope === "global" && n.host_id) return false;
      if (scope !== "all" && scope !== "global" && n.host_id !== scope) {
        return false;
      }
      if (!q) return true;
      const haystack = [n.name, n.text, n.command, n.tags.join(" ")]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
  }

  scopeLabel(note: Note): string {
    if (!note.host_id) return "Global";
    const host = this.hosts().find((h) => h.id === note.host_id);
    return host ? host.name || host.hostname : "Unknown host";
  }

  async copy(note: Note): Promise<void> {
    const payload = note.command || note.text;
    try {
      await navigator.clipboard.writeText(payload);
      this.copiedId.set(note.id);
      setTimeout(() => this.copiedId.set(null), 1200);
    } catch {
      // clipboard may be unavailable; ignore silently
    }
  }
}
