import { Component, computed, input, output, signal } from "@angular/core";
import { NgTemplateOutlet } from "@angular/common";
import { Note } from "./note.model";
import { Host } from "./host.model";

/**
 * Notes panel shown beside an open terminal. Top section = global notes,
 * bottom = notes scoped to this terminal's host. Run/copy/edit/add bubble up;
 * the panel can be collapsed to a thin rail.
 */
@Component({
  selector: "app-note-panel",
  template: `
    @if (collapsed()) {
      <button class="rail" type="button" (click)="collapsed.set(false)" title="Show notes">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
        <span class="rail-text">Notes</span>
      </button>
    } @else {
      <div class="panel">
        <header class="panel-head">
          <span>Notes</span>
          <button class="mini" type="button" (click)="collapsed.set(true)" title="Collapse">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M9 6l6 6-6 6" />
            </svg>
          </button>
        </header>

        <div class="scroll">
          <section>
            <div class="sec-head">
              <span>Global</span>
              <button class="mini" type="button" (click)="add.emit(null)" title="Add global note">+</button>
            </div>
            @for (note of globalNotes(); track note.id) {
              <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: note }" />
            } @empty {
              <p class="none">No global notes.</p>
            }
          </section>

          <section>
            <div class="sec-head">
              <span>{{ host().name || host().hostname }}</span>
              <button class="mini" type="button" (click)="add.emit(host().id)" title="Add note for this host">+</button>
            </div>
            @for (note of hostNotes(); track note.id) {
              <ng-container [ngTemplateOutlet]="row" [ngTemplateOutletContext]="{ $implicit: note }" />
            } @empty {
              <p class="none">No notes for this host.</p>
            }
          </section>
        </div>
      </div>
    }

    <ng-template #row let-note>
      <div class="note">
        <div class="note-head">
          <span class="note-name">{{ note.name || note.command || note.text }}</span>
        </div>
        @if (note.command) {
          <code class="cmd">{{ note.command }}</code>
        } @else if (note.text) {
          <p class="text">{{ note.text }}</p>
        }
        <div class="row-actions">
          @if (note.command) {
            <button class="run" type="button" (click)="run.emit(note)" title="Run">▶</button>
          }
          <button type="button" (click)="copy(note)" title="Copy">
            {{ copiedId() === note.id ? "✓" : "⧉" }}
          </button>
          <button type="button" (click)="edit.emit(note)" title="Edit">✎</button>
        </div>
      </div>
    </ng-template>
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        flex-shrink: 0;
      }
      .rail {
        height: 100%;
        width: 34px;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 0.5rem;
        padding-top: 0.6rem;
        background-color: var(--surface);
        border-left: 1px solid var(--border);
        color: var(--text-muted);
      }
      .rail:hover {
        color: var(--text);
      }
      .rail-text {
        writing-mode: vertical-rl;
        font-size: 0.72rem;
        letter-spacing: 0.08em;
        text-transform: uppercase;
      }
      .panel {
        width: 270px;
        height: 100%;
        display: flex;
        flex-direction: column;
        background-color: var(--surface);
        border-left: 1px solid var(--border);
      }
      .panel-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.55rem 0.7rem;
        border-bottom: 1px solid var(--border);
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--text-muted);
      }
      .scroll {
        flex: 1;
        overflow-y: auto;
        padding: 0.5rem;
      }
      section {
        margin-bottom: 0.9rem;
      }
      .sec-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.2rem 0.3rem;
        font-size: 0.72rem;
        font-weight: 600;
        letter-spacing: 0.04em;
        color: var(--text-faint);
      }
      .mini {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        background: transparent;
        border: none;
        color: var(--text-muted);
        font-size: 1rem;
        line-height: 1;
      }
      .mini:hover {
        color: var(--accent);
        background-color: var(--accent-soft);
      }
      .none {
        margin: 0.1rem 0.3rem;
        font-size: 0.78rem;
        color: var(--text-faint);
      }
      .note {
        background-color: var(--surface-2);
        border: 1px solid var(--border);
        border-radius: var(--radius-sm);
        padding: 0.45rem 0.55rem;
        margin-bottom: 0.4rem;
        display: flex;
        flex-direction: column;
        gap: 0.3rem;
      }
      .note-name {
        font-size: 0.82rem;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .cmd {
        font-family: ui-monospace, Menlo, Consolas, monospace;
        font-size: 0.74rem;
        color: var(--text-muted);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        display: block;
      }
      .text {
        margin: 0;
        font-size: 0.76rem;
        color: var(--text-muted);
        overflow: hidden;
        text-overflow: ellipsis;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
      }
      .row-actions {
        display: flex;
        gap: 0.25rem;
      }
      .row-actions button {
        flex: 1;
        padding: 0.2rem;
        font-size: 0.8rem;
        background-color: var(--surface);
        border: 1px solid var(--border);
        color: var(--text-muted);
      }
      .row-actions button:hover {
        color: var(--text);
        background-color: var(--surface-hover);
      }
      .row-actions button.run {
        color: var(--accent);
      }
      .row-actions button.run:hover {
        background-color: var(--accent);
        color: var(--accent-contrast);
      }
    `,
  ],
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
