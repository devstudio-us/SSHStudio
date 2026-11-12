import {
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
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
  /** Mobile only: whether the search field is expanded (otherwise just an icon).
   *  Has no effect on desktop, where the field is always shown via CSS. */
  readonly searchOpen = signal(false);
  private readonly searchRef =
    viewChild<ElementRef<HTMLInputElement>>("searchRef");

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
  readonly dragging = signal(false);
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

  // --- drag-to-reorder (pointer-based; works in the webview, unlike HTML5 DnD).
  // Enabled only in Custom order with no active search. ---
  canReorder(key: string): boolean {
    return this.sortMode(key) === "custom" && this.query().trim() === "";
  }
  isDragOver(key: string, index: number): boolean {
    return (
      this.dragging() &&
      this.dragOverKey() === key &&
      this.dragOverIndex() === index
    );
  }

  startDrag(key: string, index: number, event: PointerEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.dragKey = key;
    this.dragFrom = index;
    this.dragging.set(true);
    this.dragOverKey.set(key);
    this.dragOverIndex.set(index);
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  }

  onDragMove(event: PointerEvent): void {
    if (!this.dragging()) return;
    const el = document.elementFromPoint(
      event.clientX,
      event.clientY,
    ) as HTMLElement | null;
    const row = el?.closest<HTMLElement>(".row");
    if (!row) return;
    const key = row.dataset["key"];
    const idx = row.dataset["index"];
    if (key !== this.dragKey || idx === undefined) return;
    this.dragOverIndex.set(Number(idx));
  }

  endDrag(event: PointerEvent): void {
    if (!this.dragging()) return;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(
      event.pointerId,
    );
    const from = this.dragFrom;
    const to = this.dragOverIndex();
    const key = this.dragKey;
    this.dragging.set(false);
    this.dragKey = null;
    this.dragFrom = null;
    this.dragOverKey.set(null);
    this.dragOverIndex.set(null);
    if (from === null || to === null || key === null || from === to) return;

    const sec = this.visibleSections().find((s) => s.key === key);
    if (!sec) return;
    const ids = sec.notes.map((n) => n.id);
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    // Rebuild the full id order: swap this scope's notes (in list order) for the
    // new order, leaving every other note exactly where it is.
    const inScope = (n: Note): boolean =>
      sec.isGlobal ? !n.host_id : n.host_id === sec.scopeId;
    let i = 0;
    const full = this.notes().map((n) => (inScope(n) ? ids[i++] : n.id));
    this.reorder.emit(full);
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

  // --- mobile collapsible search ---
  openSearch(): void {
    this.searchOpen.set(true);
    setTimeout(() => this.searchRef()?.nativeElement.focus(), 0);
  }
  collapseSearch(): void {
    // Mobile only: on desktop the field is always open (searchOpen stays false),
    // so Escape here does nothing, keeping desktop search behaviour unchanged.
    if (!this.searchOpen()) return;
    this.query.set("");
    this.searchOpen.set(false);
  }
  /** Collapse back to the icon when the field is left empty. */
  onSearchBlur(): void {
    if (!this.query().trim()) this.searchOpen.set(false);
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
