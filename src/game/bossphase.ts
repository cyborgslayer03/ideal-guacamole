// Boss fights in acts: at 60% health a boss enrages and unleashes a set piece
// (summoned echoes, giant growth, or reinforcements) and starts calling down
// telegraphed hazards; at 25% it makes a last stand with faster hazards.

import * as THREE from 'three';
import { ELEMENT_COLORS, basicDamage } from '../core/rules';
import type { Actor, Combat } from './combat';

export interface BossPhase {
  /** Health fraction that triggers it. */
  at: number;
  title: string;
  subtitle: string;
  /** Damage multiplier added on entry. */
  damage: number;
  /** Cooldown multiplier on entry. */
  cooldown: number;
  /** Seconds between telegraphed hazards. */
  hazardEvery: number;
}

export const BOSS_PHASES: readonly BossPhase[] = [
  { at: 0.6, title: 'Enraged', subtitle: 'unleashes their true power!', damage: 1.25, cooldown: 0.7, hazardEvery: 4 },
  { at: 0.25, title: 'Last Stand', subtitle: 'makes a desperate last stand!', damage: 1.15, cooldown: 0.8, hazardEvery: 2.4 },
];

export type SetPiece = 'echoes' | 'giant' | 'reinforcements' | 'shield';

export interface PhaseHost {
  spawnMinions(count: number, near: THREE.Vector3, boss: Actor): void;
  /** A boss entered a new phase (banner, boss bar, camera). */
  announce(boss: Actor, phase: BossPhase, setPiece: SetPiece): void;
}

/** What a boss does when it enrages, read from its kit. */
export function setPieceFor(boss: Actor, phaseIndex: number): SetPiece {
  const kinds = boss.skills.map((s) => s.power.kind);
  if (phaseIndex >= 1) return 'shield';
  if (kinds.includes('summon') || kinds.includes('mindcontrol') || kinds.includes('reality')) return 'echoes';
  if (kinds.includes('grow')) return 'giant';
  return 'reinforcements';
}

export class BossDirector {
  constructor(private readonly combat: Combat, private readonly host: PhaseHost) {}

  update(dt: number) {
    for (const boss of this.combat.actors) {
      if (boss.archetype !== 'boss' || !boss.alive || boss.ai.flee || boss.summoned) continue;
      const stage = boss.ai.bossPhase ?? 0;
      const next = BOSS_PHASES[stage];
      if (next && boss.hp / boss.maxHp <= next.at) this.enter(boss, stage);
      if (boss.ai.bossPhase) this.hazards(boss, dt);
    }
  }

  private enter(boss: Actor, index: number) {
    const phase = BOSS_PHASES[index];
    boss.ai.bossPhase = index + 1;
    boss.ai.hazard = 2;
    boss.title = phase.title;
    boss.damageMult *= phase.damage;
    for (const s of boss.skills) {
      s.cooldown = Math.round(s.cooldown * phase.cooldown * 10) / 10;
      s.remaining = 0;
    }
    boss.invuln = Math.max(boss.invuln, 1.2);
    boss.stun = 0;
    boss.frozen = 0;
    // A shockwave that clears space around the boss.
    const element = boss.skills[0]?.power.element ?? 'kinetic';
    const color = ELEMENT_COLORS[element];
    const fx = this.combat.effects;
    fx.flare(boss.center, color, 6, 0.6);
    fx.ring(boss.pos, color, 9, 0.7);
    fx.ring(boss.pos, '#ffffff', 5, 0.5);
    fx.shake(0.9);
    this.combat.emitSound('ultimate', boss.pos, element);
    for (const e of this.combat.enemiesOf(boss)) {
      if (e.pos.distanceTo(boss.pos) < 8) this.combat.damage(e, basicDamage(boss.stats, boss.level) * 0.8, boss, element, 16);
    }

    const piece = setPieceFor(boss, index);
    switch (piece) {
      case 'echoes':
        for (let i = 0; i < 2; i++) {
          const angle = boss.facing + (i ? 1.2 : -1.2);
          this.combat.summon(boss, boss.pos.clone().add(new THREE.Vector3(Math.sin(angle) * 3, 0, Math.cos(angle) * 3)), 25);
        }
        break;
      case 'giant':
        boss.growth = 9999;
        break;
      case 'reinforcements':
        this.host.spawnMinions(3, boss.pos, boss);
        break;
      case 'shield':
        boss.shield = 5;
        this.host.spawnMinions(2, boss.pos, boss);
        break;
    }
    this.host.announce(boss, phase, piece);
  }

  /** Telegraphed strikes of the boss's element at the heroes' feet: keep moving. */
  private hazards(boss: Actor, dt: number) {
    boss.ai.hazard = (boss.ai.hazard ?? 0) - dt;
    if (boss.ai.hazard > 0) return;
    const phase = BOSS_PHASES[Math.max(0, (boss.ai.bossPhase ?? 1) - 1)];
    boss.ai.hazard = phase.hazardEvery;
    const targets = this.combat.enemiesOf(boss).filter((e) => e.pos.distanceTo(boss.pos) < 45);
    if (!targets.length) return;
    const victim = targets[Math.floor(Math.random() * targets.length)];
    const element = boss.skills[0]?.power.element ?? 'kinetic';
    // Aim slightly ahead of a moving target.
    const at = victim.pos.clone().addScaledVector(victim.vel.clone().setY(0), 0.35);
    this.combat.strike(boss, at, 3.2, 1.1, basicDamage(boss.stats, boss.level) * 1.2, element);
  }
}
