import { MAX_HP, TEAM_COLORS, TEAM_NAMES } from '../shared/constants';
import type { PublicPlayer } from '../shared/protocol';
import { CAUSE_STORM, Weapon, type Upgrade } from '../shared/types';
import { CRATE_NAMES } from '../shared/weapons';
import { h, ICONS, icon, initial, setText } from './dom';
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
  /** Match clock, storm countdown or OVERTIME. */
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
const ICON_PX = 16;
const UPGRADE_WARN_S = 1.5;
/** The desktop layout, with player and kill feed columns beside the arena, needs at least this much room (CSS px). */
const WIDE_MIN_W = 1000;
const WIDE_MIN_H = 560;
/** Minimap width in the desktop side column (CSS px). */
const MAP_WIDE_PX = 166;
/** Past this many rows the player column drops to one line per player. */
const DENSE_ROWS = 6;
/** Lives are drawn as separate marks up to this many, then as one mark and a count. */
const LIFE_MARKS = 4;

const weaponName = (w: Weapon) => (w === Weapon.Gun ? 'Cannon' : CRATE_NAMES[w]);

function whoEl(w: Who): HTMLElement {
  return h('span', { class: w.me ? 'who me' : 'who', style: { '--c': w.color } }, w.name);
}

export interface HudHandlers {
  menu(): void;
  cycle(): void;
}

/**
 * The in-match DOM overlay: top bar, players, kill feed, minimap, your status, and the touch controls.
 * Wide screens get player and kill feed columns beside the arena; narrower ones and phones get a compact top panel.
 */
export class Hud {
  readonly el: HTMLElement;
  readonly minimap: HTMLCanvasElement;
  readonly touchLayer: HTMLElement;
  readonly stickBase: HTMLElement;
  readonly stickKnob: HTMLElement;
  readonly fireButton: HTMLElement;
  private head: HTMLElement;
  private code: HTMLElement;
  private mode: HTMLElement;
  private headline: HTMLElement;
  private timer: HTMLElement;
  /** The newest feed line, shown in the compact top panel where the feed column has no room. */
  private latest: HTMLElement;
  private players: HTMLElement;
  private board: HTMLElement;
  private side: HTMLElement;
  private feed: HTMLElement;
  private status: HTMLElement;
  private notice: HTMLElement;
  private next: HTMLButtonElement;
  private boardKey = '';
  /** Starts as a key no status can have, so the first update always renders (hiding the panel for spectators). */
  private statusKey = '-';
  private feedItems: { el: HTMLElement; at: number }[] = [];

  constructor(parent: HTMLElement, on: HudHandlers) {
    this.stickKnob = h('div', { class: 'knob' });
    this.stickBase = h('div', { class: 'stick' }, this.stickKnob);
    this.fireButton = h('div', { class: 'fire', 'aria-hidden': 'true' }, h('b', {}, 'Fire'), h('small', {}, 'Hold'));
    this.touchLayer = h('div', { class: 'touch' }, h('div', { class: 'stick-hint', 'aria-hidden': 'true' }), this.stickBase, this.fireButton);

    this.code = h('span', { class: 'hud-code' });
    this.mode = h('span', { class: 'mode' });
    this.headline = h('span', { class: 'headline' });
    this.timer = h('span', { class: 'timer' });
    this.latest = h('div', { class: 'latest', 'aria-hidden': 'true' });
    this.board = h('div', { class: 'board' });
    this.players = h('div', { class: 'players-col' }, h('div', { class: 'col-title' }, 'Players'), this.board);
    const menu = h(
      'button',
      { class: 'btn menu-btn', type: 'button', 'aria-label': 'Menu', title: 'Menu (Esc)', onclick: () => on.menu() },
      icon(ICONS.menu, 18, 2.2),
      h('span', { class: 'menu-text' }, 'Menu'),
      h('kbd', {}, 'Esc'),
    );
    this.head = h(
      'div',
      { class: 'hud-head' },
      h('div', { class: 'hud-brand' }, h('span', { class: 'tt' }, 'TT'), this.code),
      h('div', { class: 'hud-center' }, this.mode, this.headline, this.timer, this.latest),
      menu,
      this.players,
    );

    this.minimap = h('canvas', { class: 'minimap', title: 'Tap to watch the next tank' });
    this.minimap.addEventListener('click', () => on.cycle());
    this.next = h('button', { class: 'btn small next', type: 'button', onclick: () => on.cycle() }, h('span', { class: 'bl' }, 'Next tank'));
    this.feed = h('div', { class: 'feed', 'aria-live': 'polite' });
    this.side = h(
      'div',
      { class: 'side' },
      h('div', { class: 'map' }, h('span', { class: 'map-title' }, 'Map'), this.minimap),
      this.next,
      h('div', { class: 'feed-col' }, h('div', { class: 'col-title' }, 'Kill feed'), this.feed),
    );

    this.status = h('div', { class: 'status' });
    this.notice = h('div', { class: 'notice' });
    this.el = h('div', { class: 'hud hidden' }, this.touchLayer, h('div', { class: 'hud-top' }, this.head, this.side), this.status, this.notice);
    parent.appendChild(this.el);
  }

  setRoom(code: string): void {
    setText(this.code, code);
  }

  show(on: boolean): void {
    this.el.classList.toggle('hidden', !on);
  }

  /** Phones: joystick and fire button. Also picks the wide desktop layout when there is room for it. */
  setTouch(on: boolean): void {
    this.el.classList.toggle('touching', on);
    this.el.classList.toggle('wide', !on && innerWidth >= WIDE_MIN_W && innerHeight >= WIDE_MIN_H);
  }

  /** Follow camera: show the minimap, sized to the maze's shape. */
  setFollow(on: boolean, maze: { w: number; h: number } | null): void {
    this.el.classList.toggle('follow', on);
    if (!on || !maze) return;
    const width = this.el.classList.contains('wide') ? MAP_WIDE_PX : Math.round(Math.min(150, Math.max(96, innerWidth * 0.26)));
    this.minimap.style.width = `${width}px`;
    this.minimap.style.height = `${Math.round((width * maze.h) / maze.w)}px`;
  }

  /** Room the arena leaves for the HUD in fit mode, in CSS px: top bar, status bar and, when wide, the side columns. */
  insets(): { top: number; bottom: number; side: number } {
    if (this.el.classList.contains('hidden')) return { top: 0, bottom: 0, side: 0 };
    const top = this.head.getBoundingClientRect().bottom + 6;
    let bottom = 0;
    if (!this.status.classList.contains('hidden')) bottom = innerHeight - this.status.getBoundingClientRect().top + 6;
    let side = 0;
    if (this.el.classList.contains('wide')) side = Math.max(this.players.getBoundingClientRect().right, innerWidth - this.side.getBoundingClientRect().left) + 6;
    return { top, bottom, side };
  }

  update(model: HudModel, now: number): void {
    const timed = !model.lives;
    const left = model.players.filter((p) => !p.player.out).length;
    setText(this.mode, timed ? 'Timed' : 'Lives');
    setText(this.headline, timed ? model.timer || '--:--' : `${left} ${left === 1 ? 'tank' : 'tanks'} left`);
    this.headline.classList.toggle('alert', timed && model.alert);
    setText(this.timer, timed ? '' : model.timer);
    this.timer.classList.toggle('alert', !timed && model.alert);
    this.timer.classList.toggle('hidden', timed || model.timer === '');
    this.updateBoard(model);
    this.updateStatus(model);
    setText(this.notice, model.notice);
    this.notice.classList.toggle('hidden', model.notice === '');
    this.next.classList.toggle('hidden', !model.canCycle);
    this.expireFeed(now);
  }

  addFeed(entry: FeedEntry, now: number): void {
    const row = this.feedLine(entry);
    this.feed.appendChild(row);
    this.latest.replaceChildren(this.feedLine(entry));
    this.feedItems.push({ el: row, at: now });
    while (this.feedItems.length > FEED_MAX) this.feedItems.shift()!.el.remove();
  }

  clearFeed(): void {
    for (const item of this.feedItems) item.el.remove();
    this.feedItems = [];
    this.latest.replaceChildren();
  }

  private feedLine(entry: FeedEntry): HTMLElement {
    return entry.kind === 'note' ? h('div', { class: 'line note' }, whoEl(entry.who), h('b', {}, entry.text)) : this.killLine(entry);
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
    if (this.feedItems.length === 0 && this.latest.firstChild) this.latest.replaceChildren();
  }

  private updateBoard(model: HudModel): void {
    const key = JSON.stringify([
      model.teams,
      model.lives,
      model.myId,
      model.players.map(({ player: p, color }) => [p.id, p.name, color, p.team, p.bot, p.kills, p.deaths, p.lives, p.out, p.connected]),
    ]);
    if (key === this.boardKey) return;
    this.boardKey = key;
    const score = (p: PublicPlayer) => (model.lives ? (p.out ? -1 : p.lives) * 1000 + p.kills : p.kills * 1000 - p.deaths);
    const sorted = [...model.players].sort((a, b) => score(b.player) - score(a.player) || a.player.seat - b.player.seat);
    const count = (n: number) => (model.lives ? `${n} ${n === 1 ? 'life' : 'lives'}` : `${n} ${n === 1 ? 'kill' : 'kills'}`);
    const chips: HTMLElement[] = [];
    if (model.teams) {
      const totals = new Map<number, number>();
      for (const { player: p } of model.players) {
        if (p.team <= 0) continue;
        totals.set(p.team, (totals.get(p.team) ?? 0) + (model.lives ? (p.out ? 0 : p.lives) : p.kills));
      }
      for (const [team, total] of [...totals].sort((a, b) => b[1] - a[1] || a[0] - b[0])) {
        const name = TEAM_NAMES[team] ?? '';
        chips.push(this.chip('team', TEAM_COLORS[team] ?? '#e8e8e3', `${name} team`, name, '', `${name} team: ${count(total)}`, this.value(model.lives, total)));
      }
    }
    for (const { player: p, color } of sorted) {
      const me = p.id === model.myId;
      const cls = [me && 'me', p.out && 'out', !p.connected && 'away'].filter(Boolean).join(' ');
      const tag = p.out ? 'Out' : !p.connected ? 'Away' : me ? 'You' : p.bot ? 'Bot' : '';
      const state = p.out ? 'out' : count(model.lives ? p.lives : p.kills);
      chips.push(this.chip(cls, color, p.name, initial(p.name), tag, `${p.name}: ${state}`, p.out ? null : this.value(model.lives, model.lives ? p.lives : p.kills)));
    }
    this.board.classList.toggle('dense', chips.length > DENSE_ROWS);
    this.board.replaceChildren(...chips);
  }

  /** One player (or team) in the players column; in the compact panel a small tile with an initial. */
  private chip(cls: string, color: string, name: string, initial: string, tag: string, label: string, value: HTMLElement | null): HTMLElement {
    return h(
      'div',
      { class: `chip ${cls}`, role: 'img', 'aria-label': label, title: name },
      h('i', { class: 'swatch', style: { '--c': color } }),
      h('span', { class: 'nm' }, name),
      h('span', { class: 'ini' }, initial),
      tag ? h('span', { class: `tag ${tag === 'Out' ? 'out' : ''}` }, tag) : null,
      value,
    );
  }

  private value(lives: boolean, n: number): HTMLElement {
    if (!lives) return h('b', { class: 'val' }, h('small', {}, 'K'), String(n));
    const el = h('b', { class: 'val' });
    for (let i = 0; i < (n > LIFE_MARKS ? 1 : n); i++) el.appendChild(h('i', { class: 'life' }));
    if (n > LIFE_MARKS) el.appendChild(document.createTextNode(`x${n}`));
    return el;
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
    const weaponIco = weaponIcon(me.weapon, 24);
    weaponIco.classList.add('icon');
    const weapon = h(
      'div',
      { class: 'cell weapon' },
      weaponIco,
      h(
        'div',
        { class: 'cell-col' },
        h('span', { class: 'cell-k' }, 'Weapon'),
        h('span', { class: 'wname' }, weaponName(me.weapon), me.weapon !== Weapon.Gun && h('b', { class: 'ammo' }, ` x${me.ammo}`)),
      ),
    );
    const pips = h('div', { class: 'pips', role: 'img', 'aria-label': `${me.hp} of ${MAX_HP} health` });
    for (let i = 0; i < MAX_HP; i++) pips.appendChild(h('i', { class: i < me.hp ? 'pip on' : 'pip' }));
    const hp = h('div', { class: 'cell hp' }, h('span', { class: 'cell-k' }, 'HP', h('span', { class: 'hp-n' }, ` ${me.hp}/${MAX_HP}`)), pips);
    const upgrades = me.upgrades.map((u) => {
      const ico = weaponIcon(u.kind, 18);
      ico.classList.add('icon');
      return h('div', { class: u.left < UPGRADE_WARN_S ? 'cell upgrade warn' : 'cell upgrade', title: CRATE_NAMES[u.kind] }, ico, h('span', {}, `${Math.ceil(u.left)}s`));
    });
    const keys = h('div', { class: 'cell keys' }, h('kbd', {}, 'Space'), 'fire');
    this.status.replaceChildren(weapon, hp, ...upgrades, keys);
  }
}
