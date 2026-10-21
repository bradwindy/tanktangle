export type Child = Node | string | number | null | undefined | false;

type Props = Record<string, unknown>;

/**
 * Tiny hyperscript helper. Styles go through CSSOM (style.setProperty), never a style attribute, so the strict
 * CSP (no inline styles) allows them. on* props become event listeners.
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') el.className = String(value);
    else if (key === 'style') for (const [prop, v] of Object.entries(value as Record<string, string>)) el.style.setProperty(prop, v);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value as EventListener);
    else if (key in el && !key.includes('-')) (el as unknown as Props)[key] = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  append(el, children);
  return el;
}

export function append(el: Element, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'number' ? String(c) : c);
  }
}

/** Replaces an element's children, skipping the empty ones. */
export function fill(el: Element, ...children: Child[]): void {
  el.replaceChildren();
  append(el, children);
}

/** Sets text only when it changed, so per-frame HUD updates do not touch the DOM. */
export function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

export function storageGet(kind: 'local' | 'session', key: string): string {
  try {
    return (kind === 'local' ? localStorage : sessionStorage).getItem(key) ?? '';
  } catch {
    return '';
  }
}

export function storageSet(kind: 'local' | 'session', key: string, value: string): void {
  try {
    (kind === 'local' ? localStorage : sessionStorage).setItem(key, value);
  } catch {
    // Private mode or storage disabled: the value lasts for this page only.
  }
}
