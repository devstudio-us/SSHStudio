import { AfterViewInit, Directive, ElementRef, inject } from "@angular/core";

/**
 * Focuses the host element once it is inserted into the DOM. Use on the first
 * field of a modal: the native `autofocus` attribute only fires on initial page
 * load, so it does nothing for dialogs rendered later with `@if`. Because the
 * element is created fresh each time the modal opens, this runs every time.
 */
@Directive({
  selector: "[appAutofocus]",
})
export class AutofocusDirective implements AfterViewInit {
  private readonly el = inject<ElementRef<HTMLElement>>(ElementRef);

  ngAfterViewInit(): void {
    queueMicrotask(() => this.el.nativeElement.focus());
  }
}
