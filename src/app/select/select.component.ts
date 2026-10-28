import {
  Component,
  ElementRef,
  HostListener,
  computed,
  inject,
  input,
  output,
  signal,
} from "@angular/core";

export interface SelectOption {
  value: string | null;
  label: string;
}

/**
 * A themed dropdown that replaces the native <select>, whose open option list
 * the OS draws and CSS can't style. Value is one-way in (`value`) + out
 * (`valueChange`); options are `{ value, label }`. Closes on outside click or
 * Escape, and supports arrow-key navigation.
 */
@Component({
  selector: "app-select",
  templateUrl: "./select.component.html",
  styleUrl: "./select.component.css",
})
export class SelectComponent {
  readonly options = input.required<SelectOption[]>();
  readonly value = input<string | null>(null);
  readonly valueChange = output<string | null>();

  readonly open = signal(false);
  readonly highlighted = signal(-1);

  private readonly host = inject(ElementRef);

  readonly selectedLabel = computed(() => {
    const v = this.value();
    const opts = this.options();
    return opts.find((o) => o.value === v)?.label ?? opts[0]?.label ?? "";
  });

  toggle(): void {
    this.open.update((o) => !o);
    if (this.open()) {
      const v = this.value();
      this.highlighted.set(this.options().findIndex((o) => o.value === v));
    }
  }

  choose(opt: SelectOption): void {
    this.valueChange.emit(opt.value);
    this.open.set(false);
  }

  @HostListener("keydown", ["$event"])
  onKey(e: KeyboardEvent): void {
    const opts = this.options();
    if (!this.open()) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        this.toggle();
      }
      return;
    }
    if (e.key === "Escape") {
      this.open.set(false);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.highlighted.update((i) => Math.min(opts.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      this.highlighted.update((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const opt = opts[this.highlighted()];
      if (opt) this.choose(opt);
    }
  }

  @HostListener("document:click", ["$event"])
  onDocClick(e: MouseEvent): void {
    if (!this.host.nativeElement.contains(e.target as Node)) {
      this.open.set(false);
    }
  }
}
