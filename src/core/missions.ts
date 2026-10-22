// Mission plans: a renderer-agnostic script the game session executes.
// Story chapters, patrols, raids, and hunts all compile down to a plan.

import type { Chapter, DialogueLine, Story, StoryChoice, Universe } from './types';

export type PatrolEvent =
  | { kind: 'squad'; count: number }
  | { kind: 'rescue'; seconds: number }
  | { kind: 'elite'; bossId: string };

export type Phase =
  | { kind: 'defeat'; count: number; label?: string }
  | { kind: 'survive'; seconds: number; label?: string }
  | { kind: 'bosses'; bossIds: string[]; minions: boolean; label?: string }
  | { kind: 'patrol'; events: PatrolEvent[]; label?: string };

export interface MissionPlan {
  title: string;
  subtitle: string;
  locationId: string;
  factionId: string | null;
  level: number;
  intro: DialogueLine[];
  phases: Phase[];
  outro: DialogueLine[];
  choice: StoryChoice | null;
  rewardItemId: string | null;
  xp: number;
  /** A friendly character fighting alongside the player. */
  allyId: string | null;
  /** A nemesis who crashes a patrol partway through. */
  ambushId: string | null;
  ambushLine: string;
  /** Whether defeated bosses get an arrest / spare / recruit / finish decision. */
  decideBosses: boolean;
  /** Health multiplier per boss (nemeses grow stronger every time they win). */
  bossPower: Record<string, number>;
  /** Patrols: who can show up in ambient events (fleeing villains, allies calling for help). */
  ambient: AmbientCast | null;
}

export interface AmbientCast {
  villainIds: string[];
  allyIds: string[];
}

/** Optional side activity during a patrol or sandbox session. */
export interface AmbientSummary {
  completed: number;
  /** Allies whose distress calls the player answered successfully. */
  helpedAllyIds: string[];
}

export type BossOutcome = 'arrest' | 'spare' | 'recruit' | 'finish';

export interface BossOption {
  id: BossOutcome;
  label: string;
  detail: string;
  disabled: boolean;
}

export interface MissionResult {
  victory: boolean;
  /** Bosses beaten during the mission. */
  defeatedBossIds: string[];
  /** Bosses still standing when the player fell. */
  survivingBossIds: string[];
  outcomes: Record<string, BossOutcome>;
  /** Index of the story choice option picked, if any. */
  choice: number | null;
  ambient?: AmbientSummary;
}

/** First chapter at or after `start` whose condition is met by the flags. */
export function nextChapterIndex(story: Story, start: number, flags: Record<string, string>): number | null {
  for (let i = start; i < story.chapters.length; i++) {
    const req = story.chapters[i].requires;
    if (!req || flags[req.flag] === req.value) return i;
  }
  return null;
}

export function chapterPhase(ch: Chapter, bossId: string | null = ch.objective.type === 'boss' ? ch.objective.characterId : null): Phase {
  switch (ch.objective.type) {
    case 'defeat':
      return { kind: 'defeat', count: ch.objective.count };
    case 'survive':
      return { kind: 'survive', seconds: ch.objective.seconds };
    case 'boss':
      return bossId ? { kind: 'bosses', bossIds: [bossId], minions: true } : { kind: 'defeat', count: 10 };
  }
}

/** Plan for playing a chapter outside a campaign (creator test play). */
export function planChapter(u: Universe, story: Story, index: number): MissionPlan {
  const ch = story.chapters[index];
  return {
    title: `Chapter ${index + 1}`,
    subtitle: ch.title,
    locationId: ch.locationId,
    factionId: ch.enemyFactionId,
    level: ch.enemyLevel,
    intro: ch.intro,
    phases: [chapterPhase(ch)],
    outro: ch.outro,
    choice: ch.choice,
    rewardItemId: u.items.some((i) => i.id === ch.rewardItemId) ? ch.rewardItemId : null,
    xp: 100 + ch.enemyLevel * 40,
    allyId: null,
    ambushId: null,
    ambushLine: '',
    decideBosses: false,
    bossPower: {},
    ambient: null,
  };
}
