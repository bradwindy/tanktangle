import { TICK_HZ } from '../shared/constants';
import type { Award } from '../shared/protocol';
import type { Mode } from '../shared/settings';

/** Everything a match counts per seat, for scores, standings, the stats board and awards. */
export interface SeatScore {
  kills: number;
  deaths: number;
  lives: number;
  /** Out of lives, or left the match. */
  out: boolean;
  /** Tick the seat went out, 0 while still in. */
  outTick: number;
  /** Left the match before the end. */
  left: boolean;
  ricochetKills: number;
  selfDamage: number;
  crates: number;
  bricks: number;
  /** Ticks. */
  longestLife: number;
  /** Ticks alive in total. */
  aliveTicks: number;
  shots: number;
  /** Shots that damaged an enemy. */
  hits: number;
  /** Damage dealt to enemies. */
  damage: number;
  /** Damage taken from anything: enemies, teammates, yourself and the storm. */
  damageTaken: number;
  /** Most kills in one life. */
  bestStreak: number;
  /** Pixels driven. */
  distance: number;
  /** Kills on the player who was leading at the time. */
  kingslayer: number;
  /** Ticks after play started, -1 for none. */
  firstBloodAt: number;
  explosiveKills: number;
  beamKills: number;
  /** Runs of two or more kills close together. A run counts once however long it gets. */
  multiKills: number;
  /** Kills on the player who last killed you. */
  revengeKills: number;
  /** Kills made on the last hit point. */
  clutchKills: number;
  /** Kills by victim seat. */
  killsOn: Map<number, number>;
  /** Enemy shots turned away by a shield. */
  deflects: number;
  teamKills: number;
}

export const newScore = (lives: number): SeatScore => ({
  kills: 0,
  deaths: 0,
  lives,
  out: false,
  outTick: 0,
  left: false,
  ricochetKills: 0,
  selfDamage: 0,
  crates: 0,
  bricks: 0,
  longestLife: 0,
  aliveTicks: 0,
  shots: 0,
  hits: 0,
  damage: 0,
  damageTaken: 0,
  bestStreak: 0,
  distance: 0,
  kingslayer: 0,
  firstBloodAt: -1,
  explosiveKills: 0,
  beamKills: 0,
  multiKills: 0,
  revengeKills: 0,
  clutchKills: 0,
  killsOn: new Map(),
  deflects: 0,
  teamKills: 0,
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
const times = (n: number) => (n === 1 ? 'once' : `${n} times`);

/** A tank is 18 px long, about 6 m for a real tank. */
const PX_PER_METRE = 3;
const metres = (px: number) => {
  const m = Math.round(px / PX_PER_METRE);
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${m} m`;
};

const ONE_MINUTE = 60;

interface AwardRule {
  title: string;
  /** The seat's number for this award, or null to leave it out of the running. */
  value(s: SeatScore, seconds: number): number | null;
  /** The lowest value wins instead of the highest. */
  least?: boolean;
  /** The highest value must reach this. Most awards also need it above zero. */
  min?: number;
  /** How worth showing the award is when its winner stands out fully. */
  weight: number;
  text(v: number, s: SeatScore): string;
}

const AWARDS: readonly AwardRule[] = [
  { title: 'Kingslayer', weight: 1.2, value: (s) => s.kingslayer, text: (n) => `Took down the leader ${times(n)}` },
  { title: 'Ricochet Artist', weight: 1.2, value: (s) => s.ricochetKills, text: (n) => plural(n, 'bank-shot kill') },
  {
    title: 'Sharpshooter',
    weight: 1,
    min: 0.25,
    value: (s) => (s.shots >= 10 ? s.hits / s.shots : null),
    text: (v) => `${Math.round(v * 100)}% of shots hit`,
  },
  { title: 'Wrecking Ball', weight: 0.7, min: 3, value: (s) => s.bricks, text: (n) => `${plural(n, 'brick')} smashed` },
  { title: 'Crate Crasher', weight: 0.7, min: 2, value: (s) => s.crates, text: (n) => `${plural(n, 'crate')} grabbed` },
  { title: 'Own Worst Enemy', weight: 0.9, min: 2, value: (s) => s.selfDamage, text: (n) => `${n} damage from their own shots` },
  { title: 'Survivor', weight: 0.8, min: 30 * TICK_HZ, value: (s) => s.longestLife, text: (t) => `Longest life: ${Math.round(t / TICK_HZ)} s` },
  {
    title: 'First Blood',
    weight: 0.6,
    value: (s) => (s.firstBloodAt >= 0 ? 1 : 0),
    text: (_, s) => `Opened the scoring ${Math.ceil(s.firstBloodAt / TICK_HZ)} s in`,
  },
  { title: 'Rampage', weight: 1.2, min: 3, value: (s) => s.bestStreak, text: (n) => `${n} kills in one life` },
  {
    title: 'Untouchable',
    weight: 1.1,
    least: true,
    value: (s, seconds) => (!s.left && s.shots > 0 && seconds >= ONE_MINUTE ? s.damageTaken : null),
    text: (n) => (n === 0 ? 'Not a scratch all match' : `Took only ${n} damage all match`),
  },
  { title: 'Bullet Magnet', weight: 0.6, min: 5, value: (s) => s.damageTaken, text: (n) => `Soaked up ${n} damage` },
  { title: 'Trigger Happy', weight: 0.5, min: 20, value: (s) => s.shots, text: (n) => `Fired ${n} shots` },
  { title: 'Revenge', weight: 0.9, value: (s) => s.revengeKills, text: (n) => `Got even ${times(n)}` },
  {
    title: 'Two Birds',
    weight: 1.3,
    value: (s) => s.multiKills,
    text: (n) => (n === 1 ? 'Two kills in half a second' : `${n} multi-kills`),
  },
  { title: 'Clutch', weight: 1.1, value: (s) => s.clutchKills, text: (n) => `${plural(n, 'kill')} on their last hit point` },
  { title: 'Road Warrior', weight: 0.5, min: 50 * PX_PER_METRE, value: (s) => s.distance, text: (px) => `Drove ${metres(px)}` },
  {
    title: 'Turtle',
    weight: 0.6,
    least: true,
    value: (s) => (!s.left && s.shots > 0 && s.aliveTicks >= ONE_MINUTE * TICK_HZ ? s.distance : null),
    text: (px) => `Drove just ${metres(px)} all match`,
  },
  { title: 'Demolition', weight: 1, value: (s) => s.explosiveKills, text: (n) => `Blew up ${plural(n, 'tank')}` },
  { title: 'Laser Show', weight: 1, value: (s) => s.beamKills, text: (n) => `Zapped ${plural(n, 'tank')} with beams` },
  { title: 'Nemesis', weight: 1, min: 3, value: (s) => Math.max(0, ...s.killsOn.values()), text: (n) => `${n} kills on one rival` },
  { title: 'Shield Wall', weight: 0.8, min: 2, value: (s) => s.deflects, text: (n) => `Bounced ${plural(n, 'shot')} off their shield` },
  { title: 'Backstabber', weight: 0.9, value: (s) => s.teamKills, text: (n) => `Took out ${plural(n, 'teammate')}` },
];

const MAX_AWARDS = 5;
/** Below this the winner is barely ahead and the award says nothing. */
const MIN_STANDOUT = 0.1;
/** Standout for a winner with nobody to compare against. */
const SOLO_STANDOUT = 0.5;

interface Candidate {
  award: Award;
  strength: number;
}

/**
 * 0 to 1: how far the winner is ahead of the runner-up and of the field's mean, as a share of the winner's value.
 * For least awards the share is of the other value, so a winner on zero stands out fully.
 */
function standout(best: number, others: readonly number[], least: boolean): number {
  if (others.length === 0) return SOLO_STANDOUT;
  const gap = (v: number) => (least ? 1 - best / v : 1 - v / best);
  const mean = others.reduce((a, b) => a + b, 0) / others.length;
  return (gap(others[0]!) + gap(mean)) / 2;
}

/** The rule's winner, or null when there is none worth naming: nobody eligible, a tie at the top, or below the minimum. */
function contest(rule: AwardRule, ranked: readonly Entry[], seconds: number): Candidate | null {
  const field: { e: Entry; v: number }[] = [];
  for (const e of ranked) {
    const v = rule.value(e.score, seconds);
    if (v !== null) field.push({ e, v });
  }
  field.sort((a, b) => (rule.least ? a.v - b.v : b.v - a.v));
  const [top, ...rest] = field;
  if (!top || rest[0]?.v === top.v) return null;
  if (rule.least ? rest.length === 0 : top.v <= 0 || top.v < (rule.min ?? 0)) return null;
  const s = standout(top.v, rest.map((x) => x.v), !!rule.least);
  if (s < MIN_STANDOUT) return null;
  return { award: { title: rule.title, id: top.e.id, text: rule.text(top.v, top.e.score) }, strength: rule.weight * s };
}

/**
 * Up to five awards, strongest first: the winners who stand out most from the room, one award per player where
 * possible, then repeats to fill. seconds is the match length, for awards that need a long enough match.
 */
export function pickAwards(ranked: readonly Entry[], seconds: number): Award[] {
  const candidates = AWARDS.map((rule) => contest(rule, ranked, seconds))
    .filter((c): c is Candidate => c !== null)
    .sort((a, b) => b.strength - a.strength);
  const chosen = new Set<Candidate>();
  const winners = new Set<string>();
  for (const c of candidates) {
    if (chosen.size >= MAX_AWARDS || winners.has(c.award.id)) continue;
    chosen.add(c);
    winners.add(c.award.id);
  }
  for (const c of candidates) if (chosen.size < MAX_AWARDS) chosen.add(c);
  return candidates.filter((c) => chosen.has(c)).map((c) => c.award);
}
