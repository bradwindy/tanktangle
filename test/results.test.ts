import { describe, expect, it } from 'vitest';
import { newScore, pickAwards, type Entry, type SeatScore } from '../src/worker/results';

const entry = (seat: number, score: Partial<SeatScore>): Entry => ({ seat, id: `p${seat}`, score: { ...newScore(3), ...score } });

describe('awards', () => {
  it('gives at most five, one per player before anyone gets a second, leaving out the weakest standout', () => {
    const awards = pickAwards(
      [
        entry(0, { kingslayer: 4, ricochetKills: 6, bestStreak: 6 }),
        entry(1, { bricks: 20 }),
        entry(2, { deflects: 5 }),
        entry(3, { revengeKills: 3 }),
        entry(4, { damageTaken: 9 }),
        entry(5, { shots: 40 }),
      ],
      30,
    );
    expect(awards).toHaveLength(5);
    expect(new Set(awards.map((a) => a.id)).size).toBe(5);
    expect(awards.map((a) => a.id)).not.toContain('p5');
  });

  it('fills up to five with repeats when few players earned anything', () => {
    const awards = pickAwards([entry(0, { kingslayer: 4, ricochetKills: 6, bestStreak: 6 }), entry(1, { bricks: 20, crates: 6 }), entry(2, {})], 30);
    expect(awards.map((a) => a.id).sort()).toEqual(['p0', 'p0', 'p0', 'p1', 'p1']);
  });

  it('names no winner for a tie at the top or a value below the award minimum', () => {
    const awards = pickAwards([entry(0, { bricks: 10, crates: 1 }), entry(1, { bricks: 10 }), entry(2, {})], 30);
    expect(awards.map((a) => a.title)).not.toContain('Wrecking Ball');
    expect(awards.map((a) => a.title)).not.toContain('Crate Crasher');
  });
});
