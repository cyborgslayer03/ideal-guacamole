import { describe, expect, it } from 'vitest';
import {
  availableAllies, bond, createCampaign, loadCampaign, missionBoard, passTime, planMission, playableHeroes, resolveMission,
  type Campaign, type Mission,
} from '../src/core/campaign';
import { generateUniverse } from '../src/core/generator';
import type { MissionResult } from '../src/core/missions';
import type { Universe } from '../src/core/types';

function world(seed = 42) {
  const u = generateUniverse(seed);
  const c = createCampaign(u);
  const hero = u.characters.find((x) => x.role === 'hero')!;
  const villainFaction = u.factions.find((f) => f.alignment === 'villain')!;
  return { u, c, hero, villainFaction };
}

const win = (bossIds: string[], outcome: MissionResult['outcomes'][string], choice: number | null = null): MissionResult => ({
  victory: true,
  defeatedBossIds: bossIds,
  survivingBossIds: [],
  outcomes: Object.fromEntries(bossIds.map((id) => [id, outcome])),
  choice,
});

const loss = (bossIds: string[]): MissionResult => ({ victory: false, defeatedBossIds: [], survivingBossIds: bossIds, outcomes: {}, choice: null });

function huntFor(c: Campaign, u: Universe, id: string): Mission {
  const m = missionBoard(c, u).find((x) => (x.kind === 'hunt' || x.kind === 'vendetta') && x.targetIds.includes(id));
  if (!m) throw new Error('no hunt for target');
  return m;
}

describe('campaign setup', () => {
  it('builds faction hierarchies with a leader and lieutenants', () => {
    const { u, c, villainFaction } = world();
    const fs = c.factions[villainFaction.id];
    expect(fs.leaderId).not.toBeNull();
    expect(fs.lieutenantIds.length).toBeGreaterThan(0);
    expect(u.characters.find((x) => x.id === fs.leaderId)?.factionId).toBe(villainFaction.id);
  });

  it('respects a leader chosen in the creator', () => {
    const u = generateUniverse(42);
    const f = u.factions.find((x) => x.alignment === 'villain')!;
    const members = u.characters.filter((x) => x.factionId === f.id);
    f.leaderId = members[members.length - 1].id;
    expect(createCampaign(u).factions[f.id].leaderId).toBe(f.leaderId);
  });

  it('survives a JSON round trip and picks up characters added later', () => {
    const { u, c } = world();
    const restored = loadCampaign(JSON.parse(JSON.stringify(c)), u);
    expect(restored).toEqual(c);
    u.characters.push({ ...structuredClone(u.characters[0]), id: 'chr_new' });
    expect(loadCampaign(JSON.parse(JSON.stringify(c)), u).relations.chr_new).toBeDefined();
    expect(loadCampaign('garbage', u).turn).toBe(1);
  });
});

describe('mission board', () => {
  it('offers story, patrol, hunt, and raid missions', () => {
    const { u, c } = world();
    const kinds = new Set(missionBoard(c, u).map((m) => m.kind));
    for (const k of ['story', 'patrol', 'hunt', 'raid'] as const) expect(kinds).toContain(k);
  });

  it('is deterministic for the same world state', () => {
    const a = world(7);
    const b = world(7);
    const strip = (ms: Mission[]) => ms.map((m) => [m.kind, m.title, m.level, m.difficulty]);
    expect(strip(missionBoard(a.c, a.u))).toEqual(strip(missionBoard(b.c, b.u)));
  });

  it('plans a raid as waves, then lieutenants, then the leader', () => {
    const { u, c, hero } = world();
    const raid = missionBoard(c, u).find((m) => m.kind === 'raid')!;
    const plan = planMission(c, u, raid, hero.id, null);
    expect(plan.phases[0].kind).toBe('defeat');
    const last = plan.phases[plan.phases.length - 1];
    expect(last.kind === 'bosses' && last.bossIds).toEqual([raid.targetIds[raid.targetIds.length - 1]]);
  });
});

describe('boss succession', () => {
  it('fills the throne when the leader is arrested', () => {
    const { u, c, hero, villainFaction } = world();
    const leaderId = c.factions[villainFaction.id].leaderId!;
    const news = resolveMission(c, u, huntFor(c, u, leaderId), win([leaderId], 'arrest'), hero.id);
    expect(c.relations[leaderId].state === 'imprisoned' || c.relations[leaderId].state === 'free').toBe(true); // may escape on the same tick
    const newLeader = c.factions[villainFaction.id].leaderId;
    expect(newLeader).not.toBeNull();
    expect(newLeader).not.toBe(leaderId);
    expect(news.some((n) => n.kind === 'succession')).toBe(true);
  });

  it('creates a brand-new villain when nobody is left to step up', () => {
    const { u, c, hero, villainFaction } = world();
    const fs = c.factions[villainFaction.id];
    const before = u.characters.length;
    // Take out every lieutenant first, then the leader.
    for (const lt of [...fs.lieutenantIds]) resolveMission(c, u, huntFor(c, u, lt), win([lt], 'finish'), hero.id);
    let guard = 0;
    while (fs.leaderId && guard++ < 10) resolveMission(c, u, huntFor(c, u, fs.leaderId), win([fs.leaderId], 'finish'), hero.id);
    expect(u.characters.length).toBeGreaterThan(before);
    expect(fs.leaderId).not.toBeNull();
  });

  it('swaps in the successor when a story calls for a fallen boss', () => {
    const { u, c, hero } = world(3);
    const story = u.stories[0];
    const bossChapter = story.chapters.find((ch) => ch.objective.type === 'boss')!;
    const bossId = bossChapter.objective.type === 'boss' ? bossChapter.objective.characterId : '';
    resolveMission(c, u, huntFor(c, u, bossId), win([bossId], 'finish'), hero.id);
    c.stories[story.id].chapter = story.chapters.indexOf(bossChapter);
    const m = missionBoard(c, u).find((x) => x.kind === 'story')!;
    expect(m.targetIds[0]).toBeDefined();
    expect(m.targetIds[0]).not.toBe(bossId);
    const plan = planMission(c, u, m, hero.id, null);
    expect(plan.intro.some((l) => l.text.includes('taken their place'))).toBe(true);
  });
});

describe('ally / nemesis system', () => {
  it('turns a boss who keeps beating you into a stronger nemesis with a vendetta', () => {
    const { u, c, hero, villainFaction } = world();
    const bossId = c.factions[villainFaction.id].leaderId!;
    const boss = u.characters.find((x) => x.id === bossId)!;
    const startLevel = boss.level;
    const m = huntFor(c, u, bossId);
    resolveMission(c, u, m, loss([bossId]), hero.id);
    resolveMission(c, u, huntFor(c, u, bossId), loss([bossId]), hero.id);
    expect(bond(c.relations[bossId])).toBe('nemesis');
    expect(boss.level).toBe(startLevel + 2);
    const vendetta = missionBoard(c, u).find((x) => x.kind === 'vendetta');
    expect(vendetta?.targetIds).toEqual([bossId]);
    expect(planMission(c, u, vendetta!, hero.id, null).bossPower[bossId]).toBeGreaterThan(1);
  });

  it('finishing a boss makes their faction swear revenge and heroes disapprove', () => {
    const { u, c, hero, villainFaction } = world();
    const fs = c.factions[villainFaction.id];
    const lt = fs.lieutenantIds[0];
    const otherHero = u.characters.find((x) => x.role === 'hero' && x.id !== hero.id)!;
    const ltScore = c.relations[lt].score;
    const heroScore = c.relations[otherHero.id].score;
    resolveMission(c, u, huntFor(c, u, fs.leaderId!), win([fs.leaderId!], 'finish'), hero.id);
    expect(c.relations[lt].score).toBeLessThan(ltScore);
    expect(c.relations[lt].grudgeHeroId).toBe(hero.id);
    expect(c.relations[otherHero.id].score).toBeLessThan(heroScore);
  });

  it('a spared and then recruited boss becomes a playable ally', () => {
    const { u, c, hero, villainFaction } = world();
    const lt = c.factions[villainFaction.id].lieutenantIds[0];
    resolveMission(c, u, huntFor(c, u, lt), win([lt], 'spare'), hero.id);
    if (c.relations[lt].state === 'free' && missionBoard(c, u).some((m) => m.targetIds.includes(lt))) {
      resolveMission(c, u, huntFor(c, u, lt), win([lt], 'recruit'), hero.id);
    }
    // Either the spare alone made them friendly, or the recruit landed.
    expect(playableHeroes(c, u).some((x) => x.id === lt)).toBe(true);
  });

  it('helping a friend on an ally mission turns them into a companion', () => {
    const { u, c, hero } = world();
    let guard = 0;
    while (guard++ < 6) {
      const m = missionBoard(c, u).find((x) => x.kind === 'ally');
      if (!m) break;
      resolveMission(c, u, m, win([], 'arrest'), hero.id);
    }
    expect(availableAllies(c, u, hero.id).length).toBeGreaterThan(0);
  });
});

describe('story choices', () => {
  function playTo(choice: number) {
    const { u, c, hero } = world(11);
    const story = u.stories[0];
    for (let i = 0; i < 2; i++) {
      const m = missionBoard(c, u).find((x) => x.kind === 'story')!;
      resolveMission(c, u, m, win([], 'arrest', i === 1 ? choice : null), hero.id);
    }
    return story.chapters[c.stories[story.id].chapter].title;
  }

  it('branches deterministically on the player’s choice', () => {
    expect(playTo(0)).toMatch(/^Showdown/);
    expect(playTo(1)).toBe('Last Stand');
  });
});

describe('determinism', () => {
  it('identical choices produce identical worlds', () => {
    const run = () => {
      const { u, c, hero, villainFaction } = world(99);
      const leader = c.factions[villainFaction.id].leaderId!;
      const news = [
        ...resolveMission(c, u, huntFor(c, u, leader), win([leader], 'finish'), hero.id),
        ...passTime(c, u),
        ...passTime(c, u),
      ];
      return { news: news.map((n) => n.text), leader: u.characters.find((x) => x.id === c.factions[villainFaction.id].leaderId)?.alias };
    };
    expect(run()).toEqual(run());
  });
});
