import { describe, expect, it } from 'vitest';
import { TILE } from '../src/shared/constants';
import { CAUSE_STORM, CRATE_KINDS, Weapon } from '../src/shared/types';
import { cameraView, clampAxis, FIT_MARGIN, fitScale, followScale, toScreen } from '../src/client/render/camera';
import { ICON_KEY, ICON_ROWS, ICON_SIZE, type IconKind } from '../src/client/render/iconmaps';
import { paintMap, parseMap, rotateSampled, upscale8 } from '../src/client/render/pixels';

describe('camera', () => {
  it('fits the whole maze plus margin into the viewport', () => {
    const view = { x: 0, y: 0, w: 1000, h: 500 };
    const s = fitScale(8 * TILE, 5 * TILE, view);
    expect((8 * TILE + 2 * FIT_MARGIN) * s).toBeLessThanOrEqual(view.w + 1e-9);
    expect((5 * TILE + 2 * FIT_MARGIN) * s).toBeCloseTo(view.h);
  });

  it('follow scale shows at least five cells on the short side, within 1.5 to 3 CSS px per world px', () => {
    expect(followScale({ x: 0, y: 0, w: 390, h: 844 })).toBe(1.5);
    expect(followScale({ x: 0, y: 0, w: 2000, h: 1200 })).toBe(3);
    const tablet = followScale({ x: 0, y: 0, w: 1024, h: 600 });
    expect(600 / tablet).toBeGreaterThanOrEqual(5 * TILE);
  });

  it('clamps the follow window to the maze, and centres a maze smaller than the window', () => {
    expect(clampAxis(10, 100, 0, 1000)).toBe(100);
    expect(clampAxis(990, 100, 0, 1000)).toBe(900);
    expect(clampAxis(500, 100, 0, 1000)).toBe(500);
    expect(clampAxis(30, 300, 0, 400)).toBe(200);
  });

  it('puts the camera point at the centre of the viewport rect', () => {
    const view = { x: 0, y: 60, w: 400, h: 300 };
    const cam = cameraView(240, 120, 2, view);
    expect(toScreen(cam, 240, 120)).toEqual({ x: 200, y: 210 });
    expect(toScreen(cam, 250, 120).x).toBe(220);
  });
});

describe('sprites', () => {
  it('rotates pixel art clockwise on screen for positive angles, matching the game heading', () => {
    // A 1 px nub to the right of centre, like a barrel at heading 0.
    const map = paintMap(16, 16, (x, y) => (x === 13 && (y === 7 || y === 8) ? 1 : 0));
    const big = upscale8(map);
    const down = rotateSampled(big, 8, Math.PI / 2);
    const lit: [number, number][] = [];
    down.data.forEach((v, i) => v && lit.push([i % 16, Math.floor(i / 16)]));
    expect(lit.length).toBeGreaterThan(0);
    for (const [x, y] of lit) {
      expect(y).toBe(13);
      expect([7, 8]).toContain(x);
    }
    expect(Array.from(rotateSampled(big, 8, 0).data)).toEqual(Array.from(map.data));
  });

  it('has a well-formed icon for every weapon, crate kind and the storm', () => {
    const kinds: IconKind[] = [Weapon.Gun, ...CRATE_KINDS, CAUSE_STORM];
    for (const kind of kinds) {
      const rows = ICON_ROWS[kind];
      expect(rows, `icon ${kind}`).toHaveLength(ICON_SIZE);
      const map = parseMap(rows, ICON_KEY);
      expect(map.w).toBe(ICON_SIZE);
      expect(map.data.some((v) => v !== 0)).toBe(true);
    }
  });
});
