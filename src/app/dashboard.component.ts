import { Component, computed, input, output, signal } from "@angular/core";
import { MetricsCardComponent } from "./metrics-card.component";
import { Host } from "./host.model";

/** Dashboard of metrics cards for every host, with a header toolbar
 * (live indicator, search, add host). Cards for un-connected hosts show an
 * idle state until connected. */
@Component({
  selector: "app-dashboard",
  imports: [MetricsCardComponent],
  template: `
    <header class="dash-head">
      <div class="dash-title">
        <h1>Dashboard</h1>
        <p>Live metrics for your servers.</p>
      </div>

      <div class="dash-controls">
        <span class="live" title="Metrics refresh automatically every 5 seconds">
          <span class="live-dot"></span> Live · 5s
        </span>
        <div class="dash-search">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />
          </svg>
          <input
            type="search"
            placeholder="Search servers…"
            [value]="query()"
            (input)="query.set(value($event))"
          />
        </div>
        <button class="primary add-host" type="button" (click)="addHost.emit()">
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14" /></svg>
          Add host
        </button>
      </div>
    </header>

    @if (hosts().length === 0) {
      <div class="empty-state">
        <span class="es-icon">
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="7" height="9" rx="1" />
            <rect x="14" y="3" width="7" height="5" rx="1" />
            <rect x="14" y="12" width="7" height="9" rx="1" />
            <rect x="3" y="16" width="7" height="5" rx="1" />
          </svg>
        </span>
        <h2>No metrics yet</h2>
        <p>Connect to a host from the sidebar and its live CPU, memory, disk, load and uptime will appear here.</p>
      </div>
    } @else if (filtered().length === 0) {
      <p class="no-match">No servers match “{{ query() }}”.</p>
    } @else {
      <div class="dash-grid">
        @for (host of filtered(); track host.id) {
          <app-metrics-card
            [host]="host"
            [monitored]="monitoredIds().has(host.id)"
            (connect)="connect.emit($event)"
            (openTerminal)="openTerminal.emit($event)"
            (addNote)="addNote.emit($event)"
            (edit)="edit.emit($event)"
            (remove)="remove.emit($event)"
          />
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        display: block;
        height: 100%;
        overflow-y: auto;
        padding: 1.5rem;
      }
      .dash-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: 1rem;
        flex-wrap: wrap;
        margin-bottom: 1.25rem;
      }
      .dash-title h1 {
        margin: 0;
        font-size: 1.35rem;
      }
      .dash-title p {
        margin: 0.2rem 0 0;
        font-size: 0.9rem;
        color: var(--text-muted);
      }
      .dash-controls {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        flex-wrap: wrap;
      }
      .live {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        font-size: 0.78rem;
        font-weight: 500;
        color: var(--text-muted);
        padding: 0.3rem 0.6rem;
        background-color: var(--surface-2);
        border-radius: 999px;
      }
      .live-dot {
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background-color: #22c55e;
        box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5);
        animation: pulse 2s infinite;
      }
      @keyframes pulse {
        0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.5); }
        70% { box-shadow: 0 0 0 6px rgba(34, 197, 94, 0); }
        100% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0); }
      }
      @media (prefers-reduced-motion: reduce) {
        .live-dot { animation: none; }
      }
      .dash-search {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
      .dash-search svg {
        position: absolute;
        left: 0.6rem;
        color: var(--text-faint);
        pointer-events: none;
      }
      .dash-search input {
        width: 200px;
        padding-left: 2rem;
      }
      .add-host {
        display: inline-flex;
        align-items: center;
        gap: 0.4rem;
        padding: 0.5rem 0.9rem;
        font-weight: 600;
        background-color: var(--accent);
        color: var(--accent-contrast);
      }
      .add-host:hover {
        background-color: var(--accent-hover);
      }
      .no-match {
        color: var(--text-faint);
        font-size: 0.9rem;
      }
      .dash-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 1rem;
      }
    `,
  ],
})
export class DashboardComponent {
  readonly hosts = input.required<Host[]>();
  /** Host ids currently monitored (connected this session). */
  readonly monitoredIds = input.required<Set<string>>();

  readonly connect = output<Host>();
  readonly openTerminal = output<Host>();
  readonly addHost = output<void>();
  /** Bubbled up from a card: the host id to scope a new note to. */
  readonly addNote = output<string>();
  readonly edit = output<Host>();
  readonly remove = output<Host>();

  readonly query = signal("");

  readonly filtered = computed(() => {
    const q = this.query().trim().toLowerCase();
    if (!q) return this.hosts();
    return this.hosts().filter((h) =>
      [h.name, h.hostname, h.user, h.tags.join(" ")]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  });

  value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }
}
