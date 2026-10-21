import { describe, expect, it } from 'vitest';
import { GameClock, Lead, MAX_LEAD, MAX_LEAD_STEP, MAX_STALL_TICKS, ServerClock, START_LEAD } from '../src/client/clock';
import { MAX_QUEUED_INPUTS, TICK_MS } from '../src/shared/constants';

describe('ServerClock', () => {
  it('follows the least delayed snapshot of the last second', () => {
    const c = new ServerClock();
    // Tick 100 arrives 30 ms late, tick 102 right on time, tick 104 50 ms late.
    c.onSnap(100, 1000 + 30);
    c.onSnap(102, 1000 + 2 * TICK_MS);
    c.onSnap(104, 1000 + 4 * TICK_MS + 50);
    const now = 1000 + 10 * TICK_MS;
    expect(c.tick(now)).toBeCloseTo(110, 6);
  });

  it('adopts a slower path once the fast samples are a second old, and restarts when ticks go back', () => {
    const c = new ServerClock();
    c.onSnap(0, 0);
    // From here on every snapshot is 40 ms later than the first one implied.
    for (let k = 2; k <= 90; k += 2) c.onSnap(k, k * TICK_MS + 40);
    expect(c.tick(90 * TICK_MS + 40)).toBeCloseTo(90, 6);
    c.onSnap(3, 5000);
    expect(c.tick(5000)).toBeCloseTo(3, 6);
  });

  it('keeps its anchor through a network stall whose backlog arrives in one burst', () => {
    const c = new ServerClock();
    for (let k = 0; k <= 60; k += 2) c.onSnap(k, k * TICK_MS + 30);
    // Ticks 62 to 80 are held up 300 ms, then arrive together; later ones are on time again.
    const burst = 80 * TICK_MS + 30 + 300;
    for (let k = 62; k <= 80; k += 2) c.onSnap(k, burst);
    for (let k = 100; k <= 110; k += 2) c.onSnap(k, k * TICK_MS + 30);
    expect(c.tick(110 * TICK_MS + 30)).toBeCloseTo(110, 6);
  });
});

describe('Lead', () => {
  const ack = (seq: number, margin: number) => ({ seq, tick: 0, margin });

  it('raises by 1 - margin on a late ack, once per round of inputs in flight', () => {
    const lead = new Lead();
    expect(lead.onAck(ack(1, -2), 3)).toBe(true);
    expect(lead.value).toBe(START_LEAD + 3);
    // Seqs 2 and 3 were sent before the change, with the old lead: they are late too but must not count.
    expect(lead.onAck(ack(2, -2), 3)).toBe(false);
    expect(lead.onAck(ack(3, -1), 4)).toBe(false);
    expect(lead.onAck(ack(4, -1), 5)).toBe(true);
    expect(lead.value).toBe(START_LEAD + 5);
  });

  it('ignores repeated acks and lowers by one after three new early acks in a row', () => {
    const lead = new Lead();
    lead.onAck(ack(1, 5), 1);
    lead.onAck(ack(1, 5), 1);
    lead.onAck(ack(2, 5), 2);
    expect(lead.value).toBe(START_LEAD);
    lead.onAck(ack(3, 2), 3);
    lead.onAck(ack(4, 5), 4);
    lead.onAck(ack(5, 5), 5);
    expect(lead.value).toBe(START_LEAD);
    lead.onAck(ack(6, 4), 6);
    expect(lead.value).toBe(START_LEAD - 1);
  });

  it('lets one stalled input raise it by MAX_LEAD_STEP only, and gives the surplus back after three early acks', () => {
    const lead = new Lead();
    // The input was held up 500 ms: 29 ticks late.
    lead.onAck(ack(1, -29), 1);
    expect(lead.value).toBe(START_LEAD + MAX_LEAD_STEP);
    // The link is fine again: inputs that arrived with margin 1 now have the extra lead to spare.
    const spare = 1 + MAX_LEAD_STEP;
    lead.onAck(ack(2, spare + 1), 2);
    lead.onAck(ack(3, spare), 3);
    lead.onAck(ack(4, spare + 2), 4);
    // Lowered so the earliest of the three would have arrived with margin 3.
    expect(lead.value).toBe(START_LEAD + MAX_LEAD_STEP - (spare - 3));
  });

  it('moves at most MAX_LEAD_STEP per change and stays within its limits', () => {
    const lead = new Lead();
    for (let seq = 1; seq <= 20; seq++) lead.onAck(ack(seq, -500), seq);
    expect(lead.value).toBe(MAX_LEAD);
    for (let seq = 21; seq <= 23; seq++) lead.onAck(ack(seq, 30), seq);
    expect(lead.value).toBe(MAX_LEAD - MAX_LEAD_STEP);
    for (let seq = 24; seq <= 200; seq++) lead.onAck(ack(seq, 30), seq);
    expect(lead.value).toBe(1);
    // At the highest lead, an input sent every tick waits about MAX_LEAD ticks: the server must queue that many.
    expect(MAX_QUEUED_INPUTS).toBeGreaterThan(MAX_LEAD);
  });
});

describe('GameClock', () => {
  it('never steps the sim tick back when the lead drops; it stalls instead', () => {
    const clock = new GameClock();
    clock.onSnap(100, 0);
    const first = clock.frame(0);
    expect(first.tick).toBe(100 + START_LEAD);
    for (let seq = 1; seq <= 3; seq++) clock.onAck({ seq, tick: 0, margin: 4 }, seq);
    expect(clock.lead.value).toBe(START_LEAD - 1);
    const stalled = clock.frame(TICK_MS / 2);
    expect(stalled).toEqual({ tick: first.tick, alpha: 1 });
    expect(clock.frame(2.5 * TICK_MS).tick).toBe(first.tick + 1);
  });

  it('follows the server back when its tick loop stalls, instead of freezing for the length of the stall', () => {
    for (const gap of [500, 1500]) {
      const clock = new GameClock();
      const snaps: { at: number; k: number }[] = [];
      // 60 Hz server with 30 ms of network delay. It stops for `gap` ms at 5 s and resumes from the same tick.
      let k = 0;
      for (let t = 0; t < 9000; t += TICK_MS) {
        if (t >= 5000 && t < 5000 + gap) continue;
        k++;
        if (k % 2 === 0) snaps.push({ at: t + 30, k });
      }
      let next = 0;
      let last = -1;
      let stalledFrom = 0;
      let longestStall = 0;
      for (let now = 0; now < 9000; now += TICK_MS) {
        while (next < snaps.length && snaps[next]!.at <= now) clock.onSnap(snaps[next]!.k, snaps[next++]!.at);
        if (!clock.ready) continue;
        const { tick } = clock.frame(now);
        if (tick !== last) stalledFrom = now;
        longestStall = Math.max(longestStall, now - stalledFrom);
        last = tick;
      }
      expect(longestStall).toBeLessThanOrEqual(MAX_STALL_TICKS * TICK_MS + 1);
      // Back on the server's clock: the newest snapshot tick plus the lead.
      const newest = snaps.at(-1)!;
      expect(Math.abs(last - newest.k - START_LEAD)).toBeLessThanOrEqual(2);
    }
  });
});
