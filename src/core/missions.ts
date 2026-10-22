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
  /** Friendly characters fighting alongside the player (up to three), as an autonomous AI squad. */
  allyIds: string[];
  /** Shown when the squad assembles, e.g. "The Vanguard". */
  teamName: string | null;
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
  /** Performance rating for the run. */
  grade?: Grade;
  /** Squad members (not the mission's hero) who fought in the mission. */
  squadIds?: string[];
  /** Team combos triggered. */
  combos?: number;
}

export type Grade = 'S' | 'A' | 'B' | 'C';

export interface RunStats {
  seconds: number;
  /** Expected duration; finishing faster than this scores better. */
  parSeconds: number;
  /** Fraction (0-1+) of the controlled heroes' max health lost over the run. */
  damageTakenRatio: number;
  maxCombo: number;
  /** Times a squad member was downed. */
  downs: number;
}

/** Turns a run into a letter grade. Pure, so it can be tested and reused. */
export function gradeRun(s: RunStats): { grade: Grade; score: number; xpBonus: number } {
  let score = 100;
  score -= Math.max(0, (s.seconds - s.parSeconds) / s.parSeconds) * 30;
  score -= Math.min(1, s.damageTakenRatio) * 35;
  score -= s.downs * 12;
  score += Math.min(15, s.maxCombo / 4);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const grade: Grade = score >= 90 ? 'S' : score >= 75 ? 'A' : score >= 60 ? 'B' : 'C';
  return { grade, score, xpBonus: { S: 0.5, A: 0.25, B: 0.1, C: 0 }[grade] };
}

/** Rough expected time for a plan's phases, used as par for grading. */
export function parTime(phases: Phase[]): number {
  return phases.reduce((t, p) => {
    switch (p.kind) {
      case 'defeat':
        return t + 6 + p.count * 4;
      case 'survive':
        return t + p.seconds;
      case 'bosses':
        return t + 45 * p.bossIds.length;
      case 'patrol':
        return t + 50 * p.events.length;
    }
  }, 0);
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
    allyIds: [],
    teamName: null,
    ambushId: null,
    ambushLine: '',
    decideBosses: false,
    bossPower: {},
    ambient: null,
  };
}
