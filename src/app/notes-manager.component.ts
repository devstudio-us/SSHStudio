import { Component, computed, input, output, signal } from "@angular/core";
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
      <select [value]="scopeFilter()" (change)="scopeFilter.set(value($event))">
        <option value="all">All scopes</option>
        <option value="global">Global</option>
        @for (host of hosts(); track host.id) {
          <option [value]="host.id">{{ host.name || host.hostname }}</option>
        }
      </select>
    </div>

    @if (filtered().length === 0) {
      <p class="empty">No notes match. Create one with “New note”.</p>
    }

    <ul class="note-list">
      @for (note of filtered(); track note.id) {
        <li class="note">
          <div class="note-top">
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
              <button class="run" type="button" (click)="run.emit(note)" title="Run in terminal">▶ Run</button>
              <button type="button" (click)="copy(note)">{{ copiedId() === note.id ? "Copied" : "Copy" }}</button>
            }
            <button type="button" (click)="edit.emit(note)">Edit</button>
            <button class="danger" type="button" (click)="remove.emit(note)">Delete</button>
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
      select {
        background-color: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-sm);
        padding: 0.5rem 0.6rem;
        color: var(--text);
      }
      .empty {
        color: var(--text-faint);
        font-size: 0.9rem;
      }
      .note-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        max-width: 760px;
      }
      .note {
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 0.85rem 1rem;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }
      .note-top {
        display: flex;
        align-items: center;
        gap: 0.6rem;
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
        padding: 0.5rem 0.65rem;
        background-color: var(--bg);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.82rem;
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
        gap: 0.4rem;
        margin-top: 0.1rem;
      }
      .actions button {
        padding: 0.35rem 0.7rem;
        font-size: 0.8rem;
        background-color: var(--surface-2);
        border: 1px solid var(--border);
        color: var(--text);
      }
      .actions button:hover {
        background-color: var(--surface-hover);
      }
      .actions button.run {
        background-color: var(--accent);
        border-color: transparent;
        color: var(--accent-contrast);
        font-weight: 600;
      }
      .actions button.run:hover {
        background-color: var(--accent-hover);
      }
      .actions button.danger:hover {
        color: var(--danger);
        border-color: var(--danger);
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
