import { describe, expect, it } from 'vitest';
import { createCampaign, missionBoard, planMission, playableHeroes, resolveMission } from '../src/core/campaign';
import { generateUniverse } from '../src/core/generator';
import type { BossOutcome } from '../src/core/missions';
import { Rng } from '../src/core/rng';

describe('campaign fuzz', () => {
  it('keeps the world consistent through long random campaigns', () => {
    const outcomes: BossOutcome[] = ['arrest', 'spare', 'recruit', 'finish'];
    for (let seed = 1; seed <= 60; seed++) {
      const u = generateUniverse(seed);
      const c = createCampaign(u);
      const rng = new Rng(seed * 31);
      for (let turn = 0; turn < 40; turn++) {
        const heroes = playableHeroes(c, u);
        const board = missionBoard(c, u);
        if (!heroes.length || !board.length) break;
        const hero = rng.pick(heroes);
        const m = rng.pick(board);
        const plan = planMission(c, u, m, hero.id, null);
        expect(plan.phases.length).toBeGreaterThan(0);
        const victory = rng.chance(0.75);
        const bosses = [...m.targetIds, ...(m.ambushId ? [m.ambushId] : [])];
        resolveMission(c, u, m, {
          victory,
          defeatedBossIds: victory ? bosses : [],
          survivingBossIds: victory ? [] : bosses,
          outcomes: Object.fromEntries(bosses.map((id) => [id, rng.pick(outcomes)])),
          choice: plan.choice ? rng.int(0, plan.choice.options.length - 1) : null,
        }, hero.id);

        for (const fs of Object.values(c.factions)) {
          if (fs.leaderId) {
            expect(fs.lieutenantIds).not.toContain(fs.leaderId);
            expect(c.relations[fs.leaderId].state).not.toBe('dead');
          }
          expect(new Set(fs.lieutenantIds).size).toBe(fs.lieutenantIds.length);
          for (const id of fs.lieutenantIds) expect(u.characters.some((x) => x.id === id)).toBe(true);
        }
        for (const ch of u.characters) {
          expect(c.relations[ch.id]).toBeDefined();
          const memberships = Object.values(c.factions).filter((f) => f.leaderId === ch.id || f.lieutenantIds.includes(ch.id));
          expect(memberships.length).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
