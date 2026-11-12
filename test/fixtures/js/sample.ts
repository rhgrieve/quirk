export function open(dialog: HTMLDialogElement) {
  dialog.showModal();
}

export function guarded(dialog: HTMLDialogElement) {
  if ('showModal' in dialog) dialog.showModal();
}

export function earlyExit(dialog: HTMLDialogElement) {
  if (!('showModal' in dialog)) return;
  dialog.showModal();
}

export const copy = structuredClone({ a: 1 });
export const last = [1, 2, 3].at(-1);
export const grouped = Object.groupBy([1, 2], (n) => (n % 2 ? 'odd' : 'even'));

export class Widget extends HTMLElement {
  connectedCallback() {
    this.attachInternals();
    this.append(document.createElement('span'));
  }
}

export function optional(el: Element) {
  el.checkVisibility?.();
}

// quirk-ignore bcd:javascript.builtins.String.replaceAll -- polyfilled
export const s = 'a'.replaceAll('a', 'b');

export function permissions() {
  navigator.permissions?.query({ name: 'geolocation' }).then((status) => status.state);
}

export function uses(el: HTMLElement) {
  el.inert = true;
  return el.popover;
}

export class Transitions {
  get available() {
    return document.startViewTransition;
  }
  run(render: () => void) {
    if (this.available) {
      queueMicrotask(() => document.startViewTransition(render));
    }
    try {
      setTimeout(() => document.startViewTransition(render));
    } catch {}
  }
}
