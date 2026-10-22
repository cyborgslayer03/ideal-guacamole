import { describe, expect, it } from 'vitest';
import { createCampaign, missionBoard, resolveMission } from '../src/core/campaign';
import { LEGENDS, legendCharacter, legendsUniverse } from '../src/core/roster';
import { SKILL_SLOTS } from '../src/core/rules';
import { MOVEMENT_KINDS, isMovement } from '../src/core/types';
import { normalizeCharacter, normalizeUniverse } from '../src/core/validate';

describe('legends roster', () => {
  it('has heroes and villains with unique names', () => {
    expect(LEGENDS.filter((l) => l.role === 'hero').length).toBeGreaterThanOrEqual(6);
    expect(LEGENDS.filter((l) => l.role === 'villain').length).toBeGreaterThanOrEqual(6);
    expect(new Set(LEGENDS.map((l) => l.alias)).size).toBe(LEGENDS.length);
  });

  it('gives every legend a way to move and a full, legal power set', () => {
    for (const spec of LEGENDS) {
      const c = legendCharacter(spec);
      expect(normalizeCharacter(c)).toEqual(c);
      expect(c.powers.some((p) => isMovement(p.kind)), spec.alias).toBe(true);
      const active = c.powers.filter((p) => !isMovement(p.kind));
      expect(active.length).toBeGreaterThanOrEqual(3);
      expect(active.length).toBeLessThanOrEqual(SKILL_SLOTS);
      // At most one power on the travel button.
      expect(c.powers.filter((p) => ['flight', 'teleport', 'leap'].includes(p.kind)).length).toBeLessThanOrEqual(1);
    }
  });

  it('covers every movement style on both sides', () => {
    for (const role of ['hero', 'villain'] as const) {
      const kinds = new Set(LEGENDS.filter((l) => l.role === role).flatMap((l) => l.powers.map((p) => p.kind)));
      for (const m of MOVEMENT_KINDS) expect(kinds, `${role} ${m}`).toContain(m);
    }
  });

  it('builds a valid Legends universe whose story branches both reach the finale', () => {
    const u = legendsUniverse();
    expect(normalizeUniverse(JSON.parse(JSON.stringify(u)))).toEqual(u);
    const hero = u.characters.find((c) => c.alias === 'Aegis Prime')!;
    for (const choice of [0, 1]) {
      const world = structuredClone(u);
      const c = createCampaign(world);
      const titles: string[] = [];
      for (let i = 0; i < 4; i++) {
        const m = missionBoard(c, world).find((x) => x.kind === 'story');
        if (!m) break;
        titles.push(m.title);
        resolveMission(c, world, m, { victory: true, defeatedBossIds: [], survivingBossIds: [], outcomes: {}, choice: i === 1 ? choice : null }, hero.id);
      }
      expect(titles[2]).toContain(choice === 0 ? 'The Rift' : 'Avalanche');
      expect(titles[3]).toContain('Long Winter');
    }
  });
});
