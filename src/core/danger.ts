// The Danger Room: an endless training simulation. Waves of minions grow
// stronger as you go, and every fifth wave a villain from the universe steps
// in. Score is how many waves you clear.

import type { MissionPlan, Phase } from './missions';
import type { Universe } from './types';

/** Waves generated per run (more than anyone should be able to clear). */
export const DANGER_WAVES = 60;

export function dangerRoomPhases(u: Universe, startLevel: number): Phase[] {
  const villains = u.characters.filter((c) => c.role === 'villain' || c.role === 'antihero');
  const phases: Phase[] = [];
  for (let wave = 1; wave <= DANGER_WAVES; wave++) {
    const level = startLevel + Math.floor((wave - 1) / 2);
    if (wave % 5 === 0 && villains.length) {
      const boss = villains[(wave / 5 - 1) % villains.length];
      phases.push({ kind: 'bosses', bossIds: [boss.id], minions: true, label: `Wave ${wave}: ${boss.alias}`, level, power: 0.8 + wave * 0.04 });
    } else {
      phases.push({ kind: 'defeat', count: 5 + wave * 2, label: `Wave ${wave}`, level });
    }
  }
  return phases;
}

export function dangerRoomPlan(u: Universe, heroLevel: number, allyIds: string[]): MissionPlan {
  const location = u.locations[0];
  return {
    title: 'Danger Room',
    subtitle: 'Survive as many waves as you can',
    locationId: location?.id ?? '',
    factionId: null,
    level: Math.max(1, heroLevel - 2),
    intro: [{ speaker: 'Danger Room', text: 'Simulation online. Waves escalate without limit. A villain joins every fifth wave. How long can you last?' }],
    phases: dangerRoomPhases(u, Math.max(1, heroLevel - 2)),
    outro: [{ speaker: 'Danger Room', text: 'Simulation complete. Impressive.' }],
    choice: null,
    rewardItemId: null,
    xp: 0,
    allyIds,
    teamName: null,
    ambushId: null,
    ambushLine: '',
    decideBosses: false,
    bossPower: {},
    ambient: null,
  };
}
