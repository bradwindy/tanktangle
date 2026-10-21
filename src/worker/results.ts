import { TICK_HZ } from '../shared/constants';
import type { Award } from '../shared/protocol';
import type { Mode } from '../shared/settings';

/** Everything a match counts per seat, for scores, standings and awards. */
export interface SeatScore {
  kills: number;
  deaths: number;
  lives: number;
  /** Out of lives, or left the match. */
  out: boolean;
  /** Tick the seat went out, 0 while still in. */
  outTick: number;
  ricochetKills: number;
  selfDamage: number;
  crates: number;
  bricks: number;
  /** Ticks. */
  longestLife: number;
  shots: number;
  /** Shots that damaged an enemy. */
  hits: number;
  /** Kills on the player who was leading at the time. */
  kingslayer: number;
}

export const newScore = (lives: number): SeatScore => ({
  kills: 0,
  deaths: 0,
  lives,
  out: false,
  outTick: 0,
  ricochetKills: 0,
  selfDamage: 0,
  crates: 0,
  bricks: 0,
  longestLife: 0,
  shots: 0,
  hits: 0,
  kingslayer: 0,
});

export interface Entry {
  seat: number;
  id: string;
  score: SeatScore;
}

/** Best first. Lives: still in, then the latest knocked out, then kills. Timed: kills, then fewer deaths. */
export function rank(mode: Mode, entries: readonly Entry[]): Entry[] {
  const outKey = (e: Entry) => (e.score.out ? e.score.outTick : Infinity);
  return [...entries].sort(
    (a, b) =>
      (mode === 'lives' ? outKey(b) - outKey(a) || 0 : 0) ||
      b.score.kills - a.score.kills ||
      a.score.deaths - b.score.deaths ||
      a.seat - b.seat,
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

interface AwardRule {
  title: string;
  value(s: SeatScore): number;
  text(v: number): string;
}

const AWARDS: readonly AwardRule[] = [
  { title: 'Kingslayer', value: (s) => s.kingslayer, text: (n) => `Took down the leader ${n === 1 ? 'once' : `${n} times`}` },
  { title: 'Ricochet Artist', value: (s) => s.ricochetKills, text: (n) => `${plural(n, 'bank-shot kill')}` },
  { title: 'Sharpshooter', value: (s) => (s.shots >= 10 ? s.hits / s.shots : 0), text: (v) => `${Math.round(v * 100)}% of shots hit` },
  { title: 'Wrecking Ball', value: (s) => s.bricks, text: (n) => `${plural(n, 'brick')} smashed` },
  { title: 'Crate Crasher', value: (s) => s.crates, text: (n) => `${plural(n, 'crate')} grabbed` },
  { title: 'Own Worst Enemy', value: (s) => s.selfDamage, text: (n) => `${n} damage from their own shots` },
  { title: 'Survivor', value: (s) => s.longestLife, text: (t) => `Longest life: ${Math.round(t / TICK_HZ)} s` },
];

const MAX_AWARDS = 3;

/** Up to three awards with non-zero values, one per player where possible. ranked breaks ties. */
export function pickAwards(ranked: readonly Entry[]): Award[] {
  const best = AWARDS.map((rule) => {
    let top: Entry | null = null;
    let topValue = 0;
    for (const e of ranked) {
      const v = rule.value(e.score);
      if (v > topValue) {
        top = e;
        topValue = v;
      }
    }
    return { rule, top, value: topValue };
  });
  const awarded = new Set<string>();
  const picked = new Set<string>();
  const out: Award[] = [];
  const give = (allowRepeat: boolean) => {
    for (const { rule, top, value } of best) {
      if (out.length >= MAX_AWARDS || !top || picked.has(rule.title)) continue;
      if (!allowRepeat && awarded.has(top.id)) continue;
      out.push({ title: rule.title, id: top.id, text: rule.text(value) });
      awarded.add(top.id);
      picked.add(rule.title);
    }
  };
  give(false);
  give(true);
  return out;
}
