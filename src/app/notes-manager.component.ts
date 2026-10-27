import { Component, computed, input, output, signal } from "@angular/core";
import { SelectComponent, SelectOption } from "./select.component";
import { Note } from "./note.model";
import { Host } from "./host.model";

/**
 * Full-page manager for notes: list, filter by scope (Global / a host), search
 * by name/text/tags, and run/copy/edit/delete each. CRUD intents bubble up to
 * the app component (which owns the note modal and run logic); copy is handled
 * here since it needs nothing else.
 */
@Component({
  selector: "app-notes-manager",
  imports: [SelectComponent],
  template: `
    <div class="head">
      <h2>Notes</h2>
      <button class="primary" type="button" (click)="addNew.emit()">New note</button>
    </div>

    <div class="filters">
      <input
        class="search"
        type="search"
        placeholder="Search name, text, tags…"
        [value]="query()"
        (input)="query.set(value($event))"
      />
      <app-select
        class="scope-select"
        [options]="scopeOptions()"
        [value]="scopeFilter()"
        (valueChange)="scopeFilter.set($event ?? 'all')"
      />
    </div>

    @if (filtered().length === 0) {
      <div class="empty-state">
        <span class="es-icon">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <path d="M4 3h11l5 5v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z" />
            <path d="M14 3v6h6M8 13h8M8 17h5" />
          </svg>
        </span>
        @if (notes().length === 0) {
          <h2>No notes yet</h2>
          <p>Save commands and snippets here — run them in a terminal or copy them when you need them.</p>
          <button class="primary" type="button" (click)="addNew.emit()">Create your first note</button>
        } @else {
          <h2>No matches</h2>
          <p>No notes match your search or filter.</p>
        }
      </div>
    }

    <ul class="note-list">
      @for (note of filtered(); track note.id) {
        <li class="note">
          <div class="note-top">
            @if (note.command) {
              <span class="run-ico" title="Runnable">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
              </span>
            }
            <span class="note-name">{{ note.name || note.command || note.text || "(untitled)" }}</span>
            <span class="scope-badge" [class.global]="!note.host_id">{{ scopeLabel(note) }}</span>
          </div>

          @if (note.command) {
            <pre class="cmd">{{ note.command }}</pre>
          }
          @if (note.text) {
            <p class="text">{{ note.text }}</p>
          }
          @if (note.tags.length > 0) {
            <div class="tags">
              @for (tag of note.tags; track tag) {
                <span class="tag">{{ tag }}</span>
              }
            </div>
          }

          <div class="actions">
            @if (note.command) {
              <button class="run" type="button" (click)="run.emit(note)" title="Run in terminal">
                <svg viewBox="0 0 24 24" width="11" height="11" fill="currentColor"><polygon points="6 4 20 12 6 20 6 4" /></svg>
                Run
              </button>
              <button class="icon-act" type="button" (click)="copy(note)" [title]="copiedId() === note.id ? 'Copied' : 'Copy command'" aria-label="Copy">
                @if (copiedId() === note.id) {
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
                } @else {
                  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h8" /></svg>
                }
              </button>
            }
            <button class="icon-act" type="button" (click)="edit.emit(note)" title="Edit" aria-label="Edit">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></svg>
            </button>
            <button class="icon-act del" type="button" (click)="remove.emit(note)" title="Delete" aria-label="Delete">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M10 11v6M14 11v6" /></svg>
            </button>
          </div>
        </li>
      }
    </ul>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        overflow-y: auto;
        padding: 1.25rem;
      }
      .head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin-bottom: 0.9rem;
      }
      .head h2 {
        margin: 0;
        font-size: 1.1rem;
      }
      .filters {
        display: flex;
        gap: 0.6rem;
        margin-bottom: 1rem;
        max-width: 760px;
      }
      .search {
        flex: 1;
      }
      .filters .scope-select {
        min-width: 160px;
      }
      /* Masonry: cards pack top-to-bottom per column, no row-alignment gaps. */
      .note-list {
        list-style: none;
        margin: 0;
        padding: 0;
        columns: 320px;
        column-gap: 0.85rem;
      }
      .note {
        break-inside: avoid;
        margin: 0 0 0.85rem;
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 0.85rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        transition: box-shadow 0.16s ease, border-color 0.16s ease,
          transform 0.12s ease;
      }
      .note:hover {
        border-color: color-mix(in srgb, var(--accent) 40%, var(--border));
        box-shadow: 0 10px 26px -10px var(--accent-glow);
        transform: translateY(-2px);
      }
      .note-top {
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }
      .run-ico {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 6px;
        flex-shrink: 0;
        background-color: var(--accent-soft);
        color: var(--accent);
      }
      .note-name {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .scope-badge {
        margin-left: auto;
        flex-shrink: 0;
        font-size: 0.7rem;
        padding: 0.1rem 0.5rem;
        border-radius: 999px;
        background-color: var(--accent-soft);
        color: var(--accent);
      }
      .scope-badge.global {
        background-color: var(--surface-2);
        color: var(--text-muted);
      }
      .cmd {
        margin: 0;
        padding: 0.5rem 0.65rem 0.5rem 0.6rem;
        background-color: color-mix(in srgb, var(--accent-soft) 55%, var(--bg));
        border: 1px solid var(--border);
        border-left: 3px solid var(--accent);
        border-radius: var(--radius-sm);
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.82rem;
        line-height: 1.5;
        white-space: pre-wrap;
        word-break: break-word;
        color: var(--text);
      }
      .text {
        margin: 0;
        font-size: 0.86rem;
        color: var(--text-muted);
        white-space: pre-wrap;
      }
      .tags {
        display: flex;
        flex-wrap: wrap;
        gap: 0.3rem;
      }
      .tag {
        font-size: 0.68rem;
        padding: 0.05rem 0.45rem;
        border-radius: 999px;
        background-color: var(--surface-2);
        color: var(--text-muted);
      }
      .actions {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        margin-top: 0.15rem;
      }
      .actions .run {
        display: inline-flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.38rem 0.75rem;
        font-size: 0.8rem;
        font-weight: 600;
        background-color: var(--accent);
        border: 1px solid transparent;
        color: var(--accent-contrast);
        box-shadow: 0 6px 14px -7px var(--accent-glow);
      }
      .actions .run:hover {
        background-color: var(--accent-hover);
      }
      .icon-act {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 30px;
        height: 30px;
        border-radius: var(--radius-sm);
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-faint);
      }
      .icon-act:hover {
        background-color: var(--surface-hover);
        color: var(--text);
      }
      .icon-act.del:hover {
        background-color: var(--danger-soft);
        color: var(--danger);
      }
      .primary {
        padding: 0.5rem 1rem;
        font-weight: 600;
        background-color: var(--accent);
        color: var(--accent-contrast);
      }
      .primary:hover {
        background-color: var(--accent-hover);
      }
    `,
  ],
})
export class NotesManagerComponent {
  readonly notes = input.required<Note[]>();
  readonly hosts = input.required<Host[]>();

  readonly run = output<Note>();
  readonly edit = output<Note>();
  readonly remove = output<Note>();
  readonly addNew = output<void>();

  readonly query = signal("");
  readonly scopeFilter = signal("all");
  readonly copiedId = signal<string | null>(null);

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
