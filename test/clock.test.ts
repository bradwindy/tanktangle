import { describe, expect, it } from 'vitest';
import { GameClock, Lead, MAX_LEAD, ServerClock, START_LEAD } from '../src/client/clock';
import { TICK_MS } from '../src/shared/constants';

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

  it('stays within its limits', () => {
    const lead = new Lead();
    lead.onAck(ack(1, -500), 1);
    expect(lead.value).toBe(MAX_LEAD);
    const low = new Lead();
    for (let seq = 1; seq <= 60; seq++) low.onAck(ack(seq, 30), seq);
    expect(low.value).toBe(1);
  });
});

describe('GameClock', () => {
  it('never steps the sim tick back when the lead drops; it stalls instead', () => {
    const clock = new GameClock();
    clock.onSnap(100, 0);
    const first = clock.frame(0);
    expect(first.tick).toBe(100 + START_LEAD);
    for (let seq = 1; seq <= 3; seq++) clock.onAck({ seq, tick: 0, margin: 10 }, seq);
    expect(clock.lead.value).toBe(START_LEAD - 1);
    const stalled = clock.frame(TICK_MS / 2);
    expect(stalled).toEqual({ tick: first.tick, alpha: 1 });
    expect(clock.frame(2.5 * TICK_MS).tick).toBe(first.tick + 1);
  });
});
