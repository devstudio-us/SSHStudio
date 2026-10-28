import {
  Component,
  ElementRef,
  computed,
  input,
  output,
  signal,
  viewChild,
} from "@angular/core";
import { MetricsCardComponent } from "../metrics-card/metrics-card.component";
import { Host } from "../host.model";

/** Dashboard of metrics cards for every host, with a header toolbar
 * (live indicator, search, add host). Cards for un-connected hosts show an
 * idle state until connected. */
@Component({
  selector: "app-dashboard",
  imports: [MetricsCardComponent],
  templateUrl: "./dashboard.component.html",
  styleUrl: "./dashboard.component.css",
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
  readonly searchOpen = signal(false);
  private readonly searchRef =
    viewChild<ElementRef<HTMLInputElement>>("searchRef");

  openSearch(): void {
    this.searchOpen.set(true);
    setTimeout(() => this.searchRef()?.nativeElement.focus(), 0);
  }

  collapseSearch(): void {
    this.query.set("");
    this.searchOpen.set(false);
  }

  /** Collapse back to the icon when the field is left empty. */
  onSearchBlur(): void {
    if (!this.query().trim()) {
      this.searchOpen.set(false);
    }
  }

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
