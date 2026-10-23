// Ambient events: optional side activity that pops up around the player during
// patrols (and in the sandbox) — street crime, rooftop snipers, supply drops,
// villains on the run, allies calling for help, and unstable rifts.

import * as THREE from 'three';
import type { AmbientSummary } from '../core/missions';
import type { Character } from '../core/types';
import { ARENA_RADIUS } from './arena';
import type { Actor } from './combat';

export type AmbientKind = 'mugging' | 'sniper' | 'supply' | 'fugitive' | 'distress' | 'rift';
type Minion = 'grunt' | 'gunner' | 'brute';

/** What the director needs from the game session. */
export interface AmbientHost {
  player(): Actor;
  spawnMinion(type: Minion, around: THREE.Vector3): Actor | null;
  /** A villain who runs from the fight; counted as a defeated boss if caught. */
  spawnFugitive(character: Character, at: THREE.Vector3): Actor | null;
  /** A friendly character fighting on the player's side for this event. */
  spawnHelper(character: Character, at: THREE.Vector3): Actor | null;
  /** Removes an actor with a flash (escaped villains, departing allies). */
  dismiss(actor: Actor): void;
  /** A raised spot (rooftop, ledge) near a point, if the arena has one. */
  perchNear(p: THREE.Vector3, minDist: number, maxDist: number): THREE.Vector3 | null;
  floorAt(x: number, z: number): number;
  reward(xp: number, note: string): void;
  restore(): void;
  banner(title: string, subtitle: string): void;
  villains: Character[];
  allies: Character[];
}

export interface FeedEntry {
  label: string;
  detail: string;
  color: string;
  distance: number;
}

interface AmbientEvent {
  kind: AmbientKind;
  label: string;
  pos: THREE.Vector3;
  /** Seconds before an untouched event resolves itself without the player. */
  expires: number;
  engaged: boolean;
  actors: Actor[];
  helper: Actor | null;
  progress: number;
  marker: THREE.Group;
  character?: Character;
}

const META: Record<AmbientKind, { label: string; color: string; xp: number; life: number; weight: number }> = {
  mugging: { label: 'Street crime', color: '#ffc23e', xp: 80, life: 50, weight: 3 },
  sniper: { label: 'Rooftop snipers', color: '#ff8a3e', xp: 110, life: 70, weight: 2 },
  supply: { label: 'Supply drop', color: '#3ee8ff', xp: 60, life: 40, weight: 2 },
  fugitive: { label: 'Villain on the run', color: '#ff3e5c', xp: 200, life: 40, weight: 1.5 },
  distress: { label: 'Ally in distress', color: '#3eff8b', xp: 140, life: 55, weight: 1.5 },
  rift: { label: 'Unstable rift', color: '#b06bff', xp: 120, life: 60, weight: 1.5 },
};

const ENGAGE_RANGE = 20;
const MAX_ACTIVE = 2;

export class AmbientDirector {
  private events: AmbientEvent[] = [];
  private nextIn = 10;
  /** Allies who leave a moment after their event ends. */
  private departing: { actor: Actor; in: number }[] = [];
  private readonly summary: AmbientSummary = { completed: 0, helpedAllyIds: [] };

  constructor(
    private readonly host: AmbientHost,
    private readonly scene: THREE.Scene,
    private readonly random: () => number = Math.random,
  ) {}

  get results(): AmbientSummary {
    return { completed: this.summary.completed, helpedAllyIds: [...this.summary.helpedAllyIds] };
  }

  /** Active events for the HUD, nearest first. */
  feed(): FeedEntry[] {
    const p = this.host.player().pos;
    return this.events
      .map((e) => ({
        label: e.character ? `${e.label}: ${e.character.alias}` : e.label,
        detail: this.detail(e),
        color: META[e.kind].color,
        distance: Math.round(Math.hypot(e.pos.x - p.x, e.pos.z - p.z)),
      }))
      .sort((a, b) => a.distance - b.distance);
  }

  /** Starts an event right away (sandbox "Trigger event" button). */
  trigger(kind?: AmbientKind): boolean {
    return this.spawn(kind ?? this.pickKind());
  }

  update(dt: number) {
    for (const d of [...this.departing]) {
      d.in -= dt;
      if (d.in <= 0) {
        this.departing = this.departing.filter((x) => x !== d);
        if (d.actor.alive) this.host.dismiss(d.actor);
      }
    }
    this.nextIn -= dt;
    if (this.nextIn <= 0 && this.events.length < MAX_ACTIVE) {
      this.spawn(this.pickKind());
      this.nextIn = 20 + this.random() * 15;
    }
    const player = this.host.player();
    for (const e of [...this.events]) {
      e.marker.rotation.y += dt;
      const dist = Math.hypot(e.pos.x - player.pos.x, e.pos.z - player.pos.z);
      if (!e.engaged) {
        e.expires -= dt;
        if (dist < ENGAGE_RANGE) this.engage(e);
        else if (e.expires <= 0) {
          this.finish(e, false, this.expiredNote(e));
          continue;
        }
      }
      if (e.engaged) this.tick(e, dt, dist);
    }
  }

  dispose() {
    for (const e of this.events) this.removeMarker(e);
    this.events = [];
  }

  // --- Lifecycle ---------------------------------------------------------------

  private pickKind(): AmbientKind {
    const kinds = (Object.keys(META) as AmbientKind[]).filter((k) => {
      if (k === 'fugitive') return this.host.villains.length > 0;
      if (k === 'distress') return this.host.allies.length > 0;
      return true;
    });
    const total = kinds.reduce((s, k) => s + META[k].weight, 0);
    let roll = this.random() * total;
    for (const k of kinds) {
      roll -= META[k].weight;
      if (roll <= 0) return k;
    }
    return kinds[0];
  }

  private spawn(kind: AmbientKind): boolean {
    const player = this.host.player().pos;
    let pos: THREE.Vector3 | null = null;
    if (kind === 'sniper') pos = this.host.perchNear(player, 14, 40);
    if (!pos) {
      const a = this.random() * Math.PI * 2;
      const d = 22 + this.random() * 16;
      pos = new THREE.Vector3(player.x + Math.cos(a) * d, 0, player.z + Math.sin(a) * d);
      const r = Math.hypot(pos.x, pos.z);
      if (r > ARENA_RADIUS - 6) pos.multiplyScalar((ARENA_RADIUS - 6) / r);
      pos.y = this.host.floorAt(pos.x, pos.z);
    }
    if (kind === 'sniper' && pos.y < 2) kind = 'mugging';
    const meta = META[kind];
    const pick = <T>(list: T[]) => list[Math.floor(this.random() * list.length)];
    const e: AmbientEvent = {
      kind,
      label: meta.label,
      pos,
      expires: meta.life,
      engaged: false,
      actors: [],
      helper: null,
      progress: 0,
      marker: this.makeMarker(pos, meta.color, kind === 'rift' ? 8 : 4),
      character: kind === 'fugitive' ? pick(this.host.villains) : kind === 'distress' ? pick(this.host.allies) : undefined,
    };
    this.events.push(e);
    this.host.banner(e.character ? `${meta.label}` : meta.label, e.character ? `${e.character.alias} spotted nearby` : 'Optional · check the event feed');
    return true;
  }

  /** Enemies appear once the player is close, so events don't empty themselves into the main fight. */
  private engage(e: AmbientEvent) {
    e.engaged = true;
    const h = this.host;
    switch (e.kind) {
      case 'mugging':
        for (let i = 0; i < 3; i++) this.track(e, h.spawnMinion(i === 2 ? 'gunner' : 'grunt', e.pos));
        break;
      case 'sniper':
        for (let i = 0; i < 3; i++) {
          const a = h.spawnMinion('gunner', e.pos);
          if (a) a.pos.set(e.pos.x + (i - 1) * 1.2, e.pos.y, e.pos.z + (i % 2) * 1.2);
          this.track(e, a);
        }
        break;
      case 'supply':
        for (let i = 0; i < 2; i++) this.track(e, h.spawnMinion('grunt', e.pos));
        break;
      case 'fugitive':
        if (e.character) this.track(e, h.spawnFugitive(e.character, e.pos.clone()));
        e.expires = 35; // reused as the escape timer
        break;
      case 'distress':
        if (e.character) e.helper = h.spawnHelper(e.character, e.pos.clone());
        for (let i = 0; i < 4; i++) this.track(e, h.spawnMinion(i === 3 ? 'brute' : 'grunt', e.pos));
        break;
      case 'rift':
        break;
    }
  }

  private track(e: AmbientEvent, a: Actor | null) {
    if (a) e.actors.push(a);
  }

  private tick(e: AmbientEvent, dt: number, dist: number) {
    const alive = e.actors.filter((a) => a.alive).length;
    switch (e.kind) {
      case 'mugging':
      case 'sniper':
        if (alive === 0) this.finish(e, true, 'Area secured');
        break;
      case 'supply':
        if (dist < 3 && Math.abs(this.host.player().pos.y - e.pos.y) < 2.5) {
          this.host.restore();
          this.finish(e, true, 'Supplies recovered: health, energy, and ultimate charge');
        }
        break;
      case 'fugitive': {
        e.expires -= dt;
        if (alive === 0) this.finish(e, true, `${e.character?.alias ?? 'The fugitive'} was caught`);
        else if (e.expires <= 0) {
          for (const a of e.actors) if (a.alive) this.host.dismiss(a);
          this.finish(e, false, `${e.character?.alias ?? 'The fugitive'} escaped`);
        }
        break;
      }
      case 'distress':
        if (e.helper && !e.helper.alive) this.finish(e, false, `${e.character?.alias ?? 'Your ally'} went down`);
        else if (alive === 0) {
          if (e.character) this.summary.helpedAllyIds.push(e.character.id);
          if (e.helper) this.departing.push({ actor: e.helper, in: 2.5 });
          this.finish(e, true, `${e.character?.alias ?? 'Your ally'} is safe and owes you one`);
        }
        break;
      case 'rift': {
        const inside = dist < 8;
        if (inside) e.progress += dt;
        e.expires -= dt * 0.25;
        if (this.random() < dt * 0.6 && alive < 4) this.track(e, this.host.spawnMinion(this.random() < 0.3 ? 'gunner' : 'grunt', e.pos));
        if (e.progress >= 15) {
          for (const a of e.actors) if (a.alive) this.host.dismiss(a);
          this.finish(e, true, 'Rift sealed');
        } else if (e.expires <= 0) this.finish(e, false, 'The rift collapsed on its own');
        break;
      }
    }
  }

  private finish(e: AmbientEvent, success: boolean, note: string) {
    this.events = this.events.filter((x) => x !== e);
    this.removeMarker(e);
    if (success) {
      this.summary.completed++;
      this.host.reward(META[e.kind].xp, note);
    } else this.host.banner(e.label, note);
  }

  private detail(e: AmbientEvent): string {
    if (!e.engaged) return `${Math.ceil(e.expires)}s`;
    const alive = e.actors.filter((a) => a.alive).length;
    switch (e.kind) {
      case 'supply':
        return 'Grab the crate';
      case 'fugitive':
        return `Escapes in ${Math.ceil(e.expires)}s`;
      case 'rift':
        return `Hold the zone ${Math.floor(e.progress)}/15s`;
      default:
        return `${alive} hostile${alive === 1 ? '' : 's'}`;
    }
  }

  private expiredNote(e: AmbientEvent): string {
    return e.kind === 'supply' ? 'Someone else got to the crate' : e.kind === 'distress' ? `${e.character?.alias ?? 'Your ally'} had to fall back` : 'The trail went cold';
  }

  // --- Visuals -----------------------------------------------------------------

  private makeMarker(pos: THREE.Vector3, color: string, radius: number): THREE.Group {
    const g = new THREE.Group();
    const beam = new THREE.Mesh(
      new THREE.CylinderGeometry(0.25, 0.25, 24, 8, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    beam.position.y = 12;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.3, radius, 40),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.6, side: THREE.DoubleSide, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    const diamond = new THREE.Mesh(new THREE.OctahedronGeometry(0.6), new THREE.MeshBasicMaterial({ color }));
    diamond.position.y = 4;
    g.add(beam, ring, diamond);
    g.position.copy(pos);
    this.scene.add(g);
    return g;
  }

  private removeMarker(e: AmbientEvent) {
    this.scene.remove(e.marker);
    e.marker.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }
}
