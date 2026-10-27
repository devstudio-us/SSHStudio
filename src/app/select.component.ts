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
  template: `
    <button
      type="button"
      class="trigger"
      [class.open]="open()"
      (click)="toggle()"
      [attr.aria-expanded]="open()"
    >
      <span class="label">{{ selectedLabel() }}</span>
      <svg class="chev" viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <path d="m6 9 6 6 6-6" />
      </svg>
    </button>

    @if (open()) {
      <div class="panel" role="listbox">
        @for (opt of options(); track opt.value; let i = $index) {
          <button
            type="button"
            class="opt"
            role="option"
            [class.selected]="opt.value === value()"
            [class.active]="i === highlighted()"
            [attr.aria-selected]="opt.value === value()"
            (click)="choose(opt)"
            (mouseenter)="highlighted.set(i)"
          >
            <span class="opt-label">{{ opt.label }}</span>
            @if (opt.value === value()) {
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5" /></svg>
            }
          </button>
        }
      </div>
    }
  `,
  styles: [
    `
      :host {
        position: relative;
        display: inline-block;
      }
      .trigger {
        display: inline-flex;
        align-items: center;
        gap: 0.5rem;
        width: 100%;
        padding: 0.5rem 0.6rem 0.5rem 0.7rem;
        font: inherit;
        font-size: 0.95rem;
        text-align: left;
        color: var(--text);
        background-color: var(--surface);
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-sm);
        cursor: pointer;
        transition: border-color 0.15s ease, box-shadow 0.15s ease;
      }
      .trigger:hover {
        border-color: var(--text-faint);
      }
      .trigger.open,
      .trigger:focus-visible {
        outline: none;
        border-color: var(--accent);
        box-shadow: 0 0 0 3px var(--accent-soft);
      }
      .label {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .chev {
        flex-shrink: 0;
        color: var(--text-muted);
        transition: transform 0.15s ease;
      }
      .trigger.open .chev {
        transform: rotate(180deg);
      }

      .panel {
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        min-width: 100%;
        max-height: 260px;
        overflow-y: auto;
        padding: 4px;
        background-color: var(--surface);
        border: 1px solid var(--border);
        border-radius: var(--radius);
        box-shadow: var(--shadow-lg);
        z-index: 60;
      }
      .opt {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 0.6rem;
        width: 100%;
        padding: 0.45rem 0.6rem;
        font: inherit;
        font-size: 0.9rem;
        text-align: left;
        color: var(--text);
        background: transparent;
        border: none;
        border-radius: var(--radius-sm);
        cursor: pointer;
        white-space: nowrap;
      }
      .opt.active {
        background-color: var(--surface-hover);
      }
      .opt.selected {
        color: var(--accent);
        font-weight: 600;
      }
      .opt.selected.active {
        background-color: var(--accent-soft);
      }
      .opt-label {
        overflow: hidden;
        text-overflow: ellipsis;
      }
    `,
  ],
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
