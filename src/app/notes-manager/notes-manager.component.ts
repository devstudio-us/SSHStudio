import { Component, computed, input, output, signal } from "@angular/core";
import { SelectComponent, SelectOption } from "../select/select.component";
import { Note } from "../models/note.model";
import { Host } from "../models/host.model";

type SortMode = "custom" | "az" | "za";

/** One scope's group of commands: Global, or a single host. */
interface Section {
  /** Stable key: "global" or the host id. Used for collapse/sort state. */
  key: string;
  title: string;
  /** Host address, or null for Global. */
  sub: string | null;
  isGlobal: boolean;
  /** Scope passed when adding here: a host id, or null for Global. */
  scopeId: string | null;
  /** Commands in this section after the search filter and sort. */
  notes: Note[];
  /** How many commands the section has in total (before the search filter). */
  total: number;
}

/**
 * Full-page command manager. Commands are grouped into sections — Global first,
 * then one per host — each independently sorted and collapsible. One search and
 * a scope dropdown filter the whole page; each row expands to show its full
 * (possibly multi-line) command and description. CRUD intents bubble up to the
 * app component; copy is handled here.
 */
@Component({
  selector: "app-notes-manager",
  imports: [SelectComponent],
  templateUrl: "./notes-manager.component.html",
  styleUrl: "./notes-manager.component.css",
})
export class NotesManagerComponent {
  readonly notes = input.required<Note[]>();
  readonly hosts = input.required<Host[]>();

  readonly run = output<Note>();
  readonly edit = output<Note>();
  readonly remove = output<Note>();
  readonly addNew = output<void>();
  /** Add a command scoped to a section: a host id, or null for Global. */
  readonly addTo = output<string | null>();
  /** A new manual order: the full list of note ids in the desired order. */
  readonly reorder = output<string[]>();

  readonly query = signal("");
  readonly scopeFilter = signal("all");
  readonly copiedId = signal<string | null>(null);

  /** Which rows are expanded (showing full command + description). */
  private readonly expandedIds = signal<Set<string>>(new Set());
  /** Which sections are collapsed, by key. */
  private readonly collapsedKeys = signal<Set<string>>(new Set());
  /** Per-section sort mode, by key (defaults to A–Z). */
  private readonly sortByKey = signal<Record<string, SortMode>>({});

  readonly sortOptions: SelectOption[] = [
    { value: "custom", label: "Custom order" },
    { value: "az", label: "Name A–Z" },
    { value: "za", label: "Name Z–A" },
  ];

  // --- drag-to-reorder state (Custom order only) ---
  private dragKey: string | null = null;
  private dragFrom: number | null = null;
  readonly dragOverKey = signal<string | null>(null);
  readonly dragOverIndex = signal<number | null>(null);

  readonly scopeOptions = computed<SelectOption[]>(() => [
    { value: "all", label: "All scopes" },
    { value: "global", label: "Global" },
    ...this.hosts().map((h) => ({ value: h.id, label: h.name || h.hostname })),
  ]);

  /** Grouped, filtered and sorted sections to render. */
  readonly sections = computed<Section[]>(() => {
    const scope = this.scopeFilter();
    const q = this.query().trim().toLowerCase();
    const matches = (n: Note): boolean =>
      !q ||
      [n.name, n.text, n.command, n.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q);

    const out: Section[] = [];
    const add = (
      key: string,
      title: string,
      sub: string | null,
      scopeId: string | null,
      isGlobal: boolean,
      all: Note[],
    ): void => {
      out.push({
        key,
        title,
        sub,
        scopeId,
        isGlobal,
        notes: this.sortNotes(key, all.filter(matches)),
        total: all.length,
      });
    };

    if (scope === "all" || scope === "global") {
      const global = this.notes().filter((n) => !n.host_id);
      if (global.length > 0 || scope === "global") {
        add("global", "Global", null, null, true, global);
      }
    }
    if (scope !== "global") {
      for (const h of this.hosts()) {
        if (scope !== "all" && scope !== h.id) continue;
        const hostNotes = this.notes().filter((n) => n.host_id === h.id);
        // In "all", skip hosts with no commands; show an explicitly chosen host
        // even when empty (so you can add the first command to it).
        if (hostNotes.length === 0 && scope !== h.id) continue;
        const sub = `${h.user ? h.user + "@" : ""}${h.hostname}`;
        add(h.id, h.name || h.hostname, sub, h.id, false, hostNotes);
      }
    }
    return out;
  });

  /** Sections to actually render: hide ones the search emptied, but keep an
   *  explicitly chosen empty scope so its empty state (and add) still shows. */
  readonly visibleSections = computed(() =>
    this.sections().filter((s) => s.notes.length > 0 || s.total === 0),
  );

  readonly totalCount = computed(() => this.notes().length);

  private sortNotes(key: string, notes: Note[]): Note[] {
    const mode = this.sortMode(key);
    const label = (n: Note): string =>
      (n.name || n.command || n.text || "").toLowerCase();
    if (mode === "az") {
      return [...notes].sort((a, b) => label(a).localeCompare(label(b)));
    }
    if (mode === "za") {
      return [...notes].sort((a, b) => label(b).localeCompare(label(a)));
    }
    return notes; // custom: keep the stored (manual) order
  }

  // --- per-section sort ---
  sortMode(key: string): SortMode {
    return this.sortByKey()[key] ?? "custom";
  }
  setSort(key: string, mode: string | null): void {
    this.sortByKey.update((m) => ({ ...m, [key]: (mode as SortMode) ?? "custom" }));
  }

  // --- drag-to-reorder (Custom order, no active search) ---
  canReorder(key: string): boolean {
    return this.sortMode(key) === "custom" && this.query().trim() === "";
  }
  isDragOver(key: string, index: number): boolean {
    return this.dragOverKey() === key && this.dragOverIndex() === index;
  }
  onDragStart(key: string, index: number, event: DragEvent): void {
    this.dragKey = key;
    this.dragFrom = index;
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  }
  onDragOver(key: string, index: number, event: DragEvent): void {
    if (this.dragKey !== key) return;
    event.preventDefault();
    this.dragOverKey.set(key);
    this.dragOverIndex.set(index);
  }
  onDrop(sec: Section, index: number, event: DragEvent): void {
    event.preventDefault();
    const from = this.dragFrom;
    const key = this.dragKey;
    this.resetDrag();
    if (from === null || key !== sec.key || from === index) return;
    const ids = sec.notes.map((n) => n.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(index, 0, moved);
    // Rebuild the full id order: swap this scope's notes (in list order) for the
    // new order, leaving every other note exactly where it is.
    const inScope = (n: Note): boolean =>
      sec.isGlobal ? !n.host_id : n.host_id === sec.scopeId;
    let i = 0;
    const full = this.notes().map((n) => (inScope(n) ? ids[i++] : n.id));
    this.reorder.emit(full);
  }
  onDragEnd(): void {
    this.resetDrag();
  }
  private resetDrag(): void {
    this.dragKey = null;
    this.dragFrom = null;
    this.dragOverKey.set(null);
    this.dragOverIndex.set(null);
  }

  // --- section collapse ---
  isSectionCollapsed(key: string): boolean {
    return this.collapsedKeys().has(key);
  }
  toggleSection(key: string): void {
    this.collapsedKeys.update((s) => toggle(s, key));
  }

  // --- row expand ---
  isExpanded(id: string): boolean {
    return this.expandedIds().has(id);
  }
  toggleExpand(id: string): void {
    this.expandedIds.update((s) => toggle(s, id));
  }

  value(event: Event): string {
    return (event.target as HTMLInputElement | HTMLSelectElement).value;
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

/** Return a new Set with `value` toggled in/out. */
function toggle<T>(set: Set<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
