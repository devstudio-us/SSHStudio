import { Component, input, output } from "@angular/core";
import { MetricsCardComponent } from "./metrics-card.component";
import { Host } from "./host.model";

/** Grid of metrics cards for the hosts connected this session. */
@Component({
  selector: "app-dashboard",
  imports: [MetricsCardComponent],
  template: `
    <header class="dash-head">
      <h1>Dashboard</h1>
      <p>Live metrics for the servers you've connected to this session.</p>
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
    } @else {
      <div class="dash-grid">
        @for (host of hosts(); track host.id) {
          <app-metrics-card
            [host]="host"
            [monitored]="monitoredIds().has(host.id)"
            (connect)="connect.emit($event)"
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
        margin-bottom: 1.25rem;
      }
      .dash-head h1 {
        margin: 0;
        font-size: 1.35rem;
      }
      .dash-head p {
        margin: 0.25rem 0 0;
        font-size: 0.9rem;
        color: var(--text-muted);
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
  /** Bubbled up from a card: the host id to scope a new note to. */
  readonly addNote = output<string>();
  readonly edit = output<Host>();
  readonly remove = output<Host>();
}
