/** Each slot either holds still or kicks, so a kick lasts one slot. */
const JITTER_SLOT = 0.07;
/** Share of slots that kick: about one kick every five seconds. */
const JITTER_CHANCE = 0.014;
const JITTER_PX = 2;

function hash(n: number): number {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * A rare horizontal sync kick in CSS px at a performance.now() time in seconds: zero almost always, a brief shove of
 * up to JITTER_PX now and then. The renderer and crt.ts both read it, so the game and the UI jump together.
 */
export function hsyncJitter(seconds: number): number {
  const slot = Math.floor(seconds / JITTER_SLOT);
  if (hash(slot) > JITTER_CHANCE) return 0;
  const kick = Math.round((hash(slot * 31 + 7) * 2 - 1) * JITTER_PX);
  return kick === 0 ? 1 : kick;
}
