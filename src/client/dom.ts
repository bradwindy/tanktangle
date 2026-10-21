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

const SVG_NS = 'http://www.w3.org/2000/svg';

/** First letter of a name for swatches and tiles, '?' for an empty one. */
export const initial = (name: string) => (Array.from(name)[0] ?? '?').toUpperCase();

/** SVG counterpart of h(). Attributes only: the CSP allows presentation attributes, unlike style attributes. */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, ...children: SVGElement[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  for (const c of children) el.appendChild(c);
  return el;
}

/** Line icons on a 24 unit grid, drawn in the text colour. */
export const ICONS = {
  enter: ['M20 5v7a3 3 0 0 1-3 3H5', 'M9 11l-4 4 4 4'],
  copy: ['M8 8h12v12H8z', 'M16 8V4H4v12h4'],
  share: ['M12 3v12', 'M7 8l5-5 5 5', 'M5 13v8h14v-8'],
  leave: ['M10 4H4v16h6', 'M14 8l4 4-4 4', 'M18 12H9'],
  close: ['M6 6l12 12M18 6L6 18'],
  minus: ['M5 12h14'],
  plus: ['M12 5v14M5 12h14'],
  check: ['M5 12l5 5 9-10'],
  menu: ['M4 6h16M4 12h16M4 18h16'],
  chevron: ['M9 5l7 7-7 7'],
  star: ['M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.5l-5.4 3 1.2-6-4.5-4.2 6.1-.7z'],
  bolt: ['M13 2L4 14h7l-1 8 9-12h-7z'],
  ricochet: ['M3 20L8 6l6 12 5-12'],
  swap: ['M4 8h14l-4-4', 'M20 16H6l4 4'],
  gauge: ['M3 18a9 9 0 0 1 18 0', 'M12 18L7 12'],
  target: ['M4 12a8 8 0 1 0 16 0a8 8 0 1 0-16 0', 'M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0', 'M12 1v5M12 18v5M1 12h5M18 12h5'],
  crown: ['M4 19h16', 'M4 16L3 6l5 4 4-6 4 6 5-4-1 10z'],
  brick: ['M3 5h18v14H3z', 'M3 12h18', 'M9 5v7M15 12v7'],
  crate: ['M4 4h16v16H4z', 'M4 4l16 16M20 4L4 20'],
  heart: ['M12 20.5l-7.8-7.6a4.8 4.8 0 0 1 6.8-6.8l1 1 1-1a4.8 4.8 0 0 1 6.8 6.8z'],
  shield: ['M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z'],
  drop: ['M12 3c4 5 6 8 6 11a6 6 0 0 1-12 0c0-3 2-6 6-11z'],
  magnet: ['M6 3v9a6 6 0 0 0 12 0V3h-4v9a2 2 0 0 1-4 0V3z'],
  burst: ['M3 12h4M10 12h4M17 12h4'],
  birds: ['M3 8l4 3 4-3', 'M13 14l4 3 4-3'],
  battery: ['M3 8h16v8H3z', 'M21 11v2', 'M6 11v2'],
  road: ['M8 3L4 21M16 3l4 18', 'M12 5v3M12 11v3M12 17v3'],
  beam: ['M2 12h6l2-5 4 10 2-5h6'],
  swords: ['M5 5l14 14M19 5L5 19', 'M4 16l4 4M20 16l-4 4'],
  dagger: ['M14 3l7 7-9 9-4 1 1-4z', 'M3 21l4-4'],
} as const;

export function icon(paths: readonly string[], size = 18, stroke = 2): SVGSVGElement {
  return svg(
    'svg',
    { class: 'ico', width: size, height: size, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': stroke, 'stroke-linecap': 'square', 'aria-hidden': 'true' },
    ...paths.map((d) => svg('path', { d })),
  );
}

/** appendChild rather than append: the tests' Workers types redefine Element.append for HTMLRewriter. */
export function append(el: Node, children: Child[]): void {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
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
