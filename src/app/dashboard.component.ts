import { Component, input } from "@angular/core";
import { MetricsCardComponent } from "./metrics-card.component";
import { Host } from "./host.model";

/** Grid of metrics cards for the hosts connected this session. */
@Component({
  selector: "app-dashboard",
  imports: [MetricsCardComponent],
  template: `
    @if (hosts().length === 0) {
      <div class="dash-empty">
        <h2>No metrics yet</h2>
        <p>Connect to a host to start monitoring it here.</p>
      </div>
    } @else {
      <div class="dash-grid">
        @for (host of hosts(); track host.id) {
          <app-metrics-card [host]="host" />
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
        padding: 1.25rem;
      }
      .dash-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
        gap: 1rem;
      }
      .dash-empty {
        height: 100%;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        text-align: center;
        color: var(--text-muted);
      }
      .dash-empty h2 {
        margin: 0 0 0.25rem;
        color: var(--text);
      }
    `,
  ],
})
export class DashboardComponent {
  readonly hosts = input.required<Host[]>();
}
