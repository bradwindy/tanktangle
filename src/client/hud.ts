import { MAX_HP, TEAM_COLORS, TEAM_NAMES } from '../shared/constants';
import type { PublicPlayer } from '../shared/protocol';
import { CAUSE_STORM, Weapon, type Upgrade } from '../shared/types';
import { CRATE_NAMES } from '../shared/weapons';
import { h, setText } from './dom';
import { weaponIcon } from './render/icons';

export interface Who {
  name: string;
  color: string;
  me: boolean;
}

export type FeedEntry =
  | { kind: 'kill'; killer: Who | null; victim: Who; cause: number; self: boolean; teamKill: boolean }
  /** A streak call for another player. */
  | { kind: 'note'; who: Who; text: string };

export interface HudPlayer {
  player: PublicPlayer;
  color: string;
}

export interface HudModel {
  /** Top centre: match clock, storm countdown or OVERTIME. */
  timer: string;
  alert: boolean;
  teams: boolean;
  lives: boolean;
  /** Seated players with their tank colours. */
  players: HudPlayer[];
  myId: string;
  me: { alive: boolean; hp: number; weapon: Weapon; ammo: number; upgrades: { kind: Upgrade; left: number }[] } | null;
  /** Spectating, respawn countdown or out of lives. */
  notice: string;
  /** Spectating: show the next-tank button. */
  canCycle: boolean;
}

const FEED_MAX = 5;
const FEED_MS = 7000;
const ICON_PX = 18;
const UPGRADE_WARN_S = 1.5;

const weaponName = (w: Weapon) => (w === Weapon.Gun ? 'Cannon' : CRATE_NAMES[w]);

const swatch = (color: string) => h('i', { class: 'swatch', style: { '--c': color } });

function whoEl(w: Who): HTMLElement {
  return h('span', { class: w.me ? 'who me' : 'who', style: { '--c': w.color } }, w.name);
}

export interface HudHandlers {
  menu(): void;
  cycle(): void;
}

/** The in-match DOM overlay: clock, scoreboard, kill feed, minimap, your status, and the touch controls. */
export class Hud {
  readonly el: HTMLElement;
  readonly minimap: HTMLCanvasElement;
  readonly touchLayer: HTMLElement;
  readonly stickBase: HTMLElement;
  readonly stickKnob: HTMLElement;
  readonly fireButton: HTMLElement;
  private top: HTMLElement;
  private timer: HTMLElement;
  private board: HTMLElement;
  private feed: HTMLElement;
  private status: HTMLElement;
  private notice: HTMLElement;
  private next: HTMLButtonElement;
  private boardKey = '';
  /** Starts as a key no status can have, so the first update always renders (hiding the panel for spectators). */
  private statusKey = '-';
  private sideWidth = -1;
  private feedItems: { el: HTMLElement; at: number }[] = [];

  constructor(parent: HTMLElement, on: HudHandlers) {
    this.stickKnob = h('div', { class: 'knob' });
    this.stickBase = h('div', { class: 'stick' }, this.stickKnob);
    this.fireButton = h('div', { class: 'fire', 'aria-hidden': 'true' }, 'FIRE');
    this.touchLayer = h('div', { class: 'touch' }, this.stickBase, this.fireButton);
    this.timer = h('div', { class: 'timer' });
    this.board = h('div', { class: 'board' });
    this.top = h('div', { class: 'hud-top' }, this.timer, this.board);
    this.minimap = h('canvas', { class: 'minimap', title: 'Tap to watch the next tank' });
    this.minimap.addEventListener('click', () => on.cycle());
    this.next = h('button', { class: 'btn small next', type: 'button', onclick: () => on.cycle() }, 'Next tank');
    this.feed = h('div', { class: 'feed', 'aria-live': 'polite' });
    this.status = h('div', { class: 'status' });
    this.notice = h('div', { class: 'notice' });
    const menu = h('button', { class: 'btn icon menu-btn', type: 'button', 'aria-label': 'Menu', title: 'Menu (Esc)', onclick: () => on.menu() }, h('span', { class: 'bars' }));
    this.el = h(
      'div',
      { class: 'hud hidden' },
      this.touchLayer,
      menu,
      this.top,
      h('div', { class: 'side' }, this.minimap, this.next, this.feed),
      this.status,
      this.notice,
    );
    parent.appendChild(this.el);
  }

  show(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
  }

  /** Phones: joystick and fire button, compact panels. */
  setTouch(on: boolean): void {
    this.el.classList.toggle('touching', on);
  }

  /** Follow camera: show the minimap, sized to the maze's shape. */
  setFollow(on: boolean, maze: { w: number; h: number } | null): void {
    this.el.classList.toggle('follow', on);
    if (!on || !maze) {
      this.setSide(0);
      return;
    }
    const width = Math.round(Math.min(150, Math.max(96, innerWidth * 0.26)));
    this.setSide(width + 20);
    this.minimap.style.width = `${width}px`;
    this.minimap.style.height = `${Math.round((width * maze.h) / maze.w)}px`;
  }

  /** Keeps the scoreboard clear of the minimap column. */
  private setSide(px: number): void {
    if (px === this.sideWidth) return;
    this.sideWidth = px;
    this.el.style.setProperty('--side', `${px}px`);
  }

  /** Room the arena leaves for the HUD at the top and bottom in fit mode, in CSS px. */
  insets(): { top: number; bottom: number } {
    if (this.el.classList.contains('hidden')) return { top: 0, bottom: 0 };
    const top = this.top.getBoundingClientRect().bottom + 6;
    let bottom = 0;
    if (!this.status.classList.contains('hidden')) bottom = innerHeight - this.status.getBoundingClientRect().top + 6;
    return { top, bottom };
  }

  update(model: HudModel, now: number): void {
    setText(this.timer, model.timer);
    this.timer.classList.toggle('alert', model.alert);
    this.timer.classList.toggle('hidden', model.timer === '');
    this.updateBoard(model);
    this.updateStatus(model);
    setText(this.notice, model.notice);
    this.notice.classList.toggle('hidden', model.notice === '');
    this.next.classList.toggle('hidden', !model.canCycle);
    this.expireFeed(now);
  }

  addFeed(entry: FeedEntry, now: number): void {
    const row =
      entry.kind === 'note'
        ? h('div', { class: 'line note' }, whoEl(entry.who), h('b', {}, entry.text))
        : this.killLine(entry);
    this.feed.appendChild(row);
    this.feedItems.push({ el: row, at: now });
    while (this.feedItems.length > FEED_MAX) this.feedItems.shift()!.el.remove();
  }

  clearFeed(): void {
    for (const item of this.feedItems) item.el.remove();
    this.feedItems = [];
  }

  private killLine(e: Extract<FeedEntry, { kind: 'kill' }>): HTMLElement {
    const icon = weaponIcon(e.cause === CAUSE_STORM ? CAUSE_STORM : (e.cause as Weapon), ICON_PX);
    icon.classList.add('icon');
    const mine = e.victim.me || !!e.killer?.me;
    const cls = `line${mine ? ' mine' : ''}`;
    if (e.self) return h('div', { class: cls }, whoEl(e.victim), icon, h('span', { class: 'quiet' }, 'self-destructed'));
    if (!e.killer) {
      const text = e.cause === CAUSE_STORM ? 'lost to the storm' : 'was wrecked';
      return h('div', { class: cls }, icon, whoEl(e.victim), h('span', { class: 'quiet' }, text));
    }
    return h('div', { class: cls }, whoEl(e.killer), icon, whoEl(e.victim), e.teamKill && h('span', { class: 'quiet' }, 'team kill'));
  }

  private expireFeed(now: number): void {
    while (this.feedItems.length > 0 && now - this.feedItems[0]!.at > FEED_MS) this.feedItems.shift()!.el.remove();
  }

  private updateBoard(model: HudModel): void {
    const key = JSON.stringify([
      model.teams,
      model.lives,
      model.myId,
      model.players.map(({ player: p, color }) => [p.id, p.name, color, p.team, p.kills, p.deaths, p.lives, p.out, p.connected]),
    ]);
    if (key === this.boardKey) return;
    this.boardKey = key;
    const score = (p: PublicPlayer) => (model.lives ? (p.out ? -1 : p.lives) * 1000 + p.kills : p.kills * 1000 - p.deaths);
    const sorted = [...model.players].sort((a, b) => score(b.player) - score(a.player) || a.player.seat - b.player.seat);
    const chips: HTMLElement[] = [];
    if (model.teams) {
      const totals = new Map<number, number>();
      for (const { player: p } of model.players) {
        if (p.team <= 0) continue;
        totals.set(p.team, (totals.get(p.team) ?? 0) + (model.lives ? (p.out ? 0 : p.lives) : p.kills));
      }
      for (const [team, total] of [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
        chips.push(h('div', { class: 'chip team', style: { '--c': TEAM_COLORS[team] ?? '#fff' } }, h('span', { class: 'nm' }, TEAM_NAMES[team] ?? ''), this.value(model.lives, total)));
      }
    }
    for (const { player: p, color } of sorted) {
      const cls = ['chip', p.id === model.myId && 'me', p.out && 'out', !p.connected && 'away'].filter(Boolean).join(' ');
      chips.push(h('div', { class: cls, title: p.name }, swatch(color), h('span', { class: 'nm' }, p.name), this.value(model.lives, model.lives ? p.lives : p.kills)));
    }
    this.board.replaceChildren(...chips);
  }

  private value(lives: boolean, n: number): HTMLElement {
    return lives ? h('b', { class: 'val' }, h('i', { class: 'heart' }), String(n)) : h('b', { class: 'val' }, String(n));
  }

  private updateStatus(model: HudModel): void {
    const me = model.me;
    const key = me
      ? [me.alive, me.hp, me.weapon, me.ammo, ...me.upgrades.map((u) => `${u.kind}:${Math.ceil(u.left)}:${u.left < UPGRADE_WARN_S}`)].join('|')
      : '';
    if (key === this.statusKey) return;
    this.statusKey = key;
    this.status.classList.toggle('hidden', !me);
    if (!me) {
      this.status.replaceChildren();
      return;
    }
    const pips = h('div', { class: 'pips', 'aria-label': `${me.hp} of ${MAX_HP} health` });
    for (let i = 0; i < MAX_HP; i++) pips.appendChild(h('i', { class: i < me.hp ? 'pip on' : 'pip' }));
    const icon = weaponIcon(me.weapon, 24);
    icon.classList.add('icon');
    const weapon = h(
      'div',
      { class: 'weapon' },
      icon,
      h('span', { class: 'wname' }, weaponName(me.weapon)),
      me.weapon !== Weapon.Gun && h('b', { class: 'ammo' }, `x${me.ammo}`),
    );
    const upgrades = me.upgrades.map((u) => {
      const ico = weaponIcon(u.kind, 18);
      ico.classList.add('icon');
      return h('div', { class: u.left < UPGRADE_WARN_S ? 'upgrade warn' : 'upgrade', title: CRATE_NAMES[u.kind] }, ico, h('span', {}, `${Math.ceil(u.left)}s`));
    });
    this.status.replaceChildren(pips, weapon, ...upgrades);
  }
}
