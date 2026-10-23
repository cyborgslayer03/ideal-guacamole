// Game runtime: owns the renderer, camera, and game loop, and executes
// mission plans phase by phase (waves, survival, boss fights, patrols) or
// runs the free-play Omni Sandbox.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { randomLocation } from '../core/generator';
import { gradeRun, parTime, type BossOption, type BossOutcome, type MissionPlan, type MissionResult, type PatrolEvent, type Phase } from '../core/missions';
import { Rng } from '../core/rng';
import {
  ELEMENT_COLORS, RARITY_COLORS, THREAT_TIERS, rankBonus, travelRange, basicDamage, effectiveStats, grantXp, maxHealth, minionHealth, minionStats, resolveRules, tierById, xpReward,
  type RuleKey, type ThreatTier,
} from '../core/rules';
import type { Appearance, Character, Element, Location, Universe, UniverseRules } from '../core/types';
import { AmbientDirector, type AmbientHost } from './ambient';
import { h, saveFile } from '../ui/dom';
import { updateAlly, updateEnemy, type SquadContext, type SquadOrder } from './ai';
import { ARENA_RADIUS, aimPoint, buildArena, type AimResult, type Arena } from './arena';
import { Actor, Combat } from './combat';
import { audio, type Intensity, type Sfx } from './audio';
import { BossDirector } from './bossphase';
import { scatterProps } from './props';
import { CrowdSim, CrowdView, speciesFor, type Species, type Threat } from './crowd';
import { Traffic } from './traffic';
import { banterLine, type BanterEvent } from '../core/banter';
import { loadoutFor, masteryUnlocked } from '../core/progression';
import { Effects } from './effects';
import { Hud } from './hud';
import { AIM_HOLD, Input } from './input';

export interface SessionOptions {
  container: HTMLElement;
  universe: Universe;
  characterId: string;
  /** Mission to run, or null for the Omni Sandbox. */
  plan: MissionPlan | null;
  sandboxLocationId?: string | null;
  bloom: boolean;
  /** Labels for the fate of a defeated boss (campaign only). */
  bossOptions?: (bossId: string) => BossOption[];
  /** Called when a mission ends; return a plan to continue straight into it. */
  onFinish?: (result: MissionResult) => MissionPlan | null;
  /** Called whenever progress (XP, levels, rewards) should be persisted. */
  onSave: () => void;
  onExit: () => void;
  /** Relationship scores by character id (campaign), which set the tone of squad banter. */
  bonds?: Record<string, number>;
  /** Free Roam: an open world with ambient events and no Omni controls. */
  freeRoam?: boolean;
  /** Sandbox and Free Roam: teammates who start alongside the hero. */
  squadIds?: string[];
}

type Minion = 'grunt' | 'gunner' | 'brute';

interface Stage {
  arena: Arena;
  combat: Combat;
  fx: Effects;
  /** The hero the player is controlling right now (changes with tag-switching). */
  player: Actor;
  /** AI teammates (everyone in the squad except the controlled hero). */
  allies: Actor[];
  hud: Hud;
  location: Location;
  bosses: BossDirector;
}

interface Beacon {
  pos: THREE.Vector3;
  event: PatrolEvent;
  state: 'idle' | 'active' | 'done';
  group: THREE.Group;
  actors: Set<Actor>;
  timer: number;
}

interface Run {
  plan: MissionPlan;
  phase: number;
  killed: number;
  spawned: number;
  elapsed: number;
  spawnTimer: number;
  bosses: Actor[];
  defeated: string[];
  beacons: Beacon[];
  ambush: 'none' | 'pending' | 'active' | 'done';
  transitioning: boolean;
  done: boolean;
  /** Game time when the first phase began (for grading). */
  startedAt: number;
  damageTaken: number;
  downs: number;
  combos: number;
}

export class GameSession {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(60, 1, 0.1, 500);
  private readonly composer: EffectComposer | null = null;
  private readonly input: Input;
  private readonly root: HTMLElement;
  private stage: Stage | null = null;
  private run: Run | null = null;
  private frame = 0;
  private last = performance.now();
  private time = 0;
  private paused = false;
  private timeScale = 1;
  private slowmo = 0;
  private hitstop = 0;
  private camYaw = Math.PI;
  private camPitch = 0.35;
  private camDist = 9;
  private readonly camTarget = new THREE.Vector3();
  private godMode = false;
  private spawnLevel: number;
  private disposed = false;
  private readonly character: Character;
  private readonly onResize = () => this.resize();
  /** Effective rules for the current stage (universe → location → session layers). */
  private rules: UniverseRules;
  private ruleSource: Record<RuleKey, string> = { powerScale: 'Universe', gravity: 'Universe', enemyDensity: 'Universe' };
  /** Sandbox overrides: the top rule layer. */
  private sessionRules: Partial<UniverseRules> = {};
  /** Sandbox threat tier. Missions always play at their own level. */
  private tier: ThreatTier = tierById('city');
  private ambient: AmbientDirector | null = null;
  private ambientInSandbox = false;
  /** Friendly characters fighting alongside for a while (ambient distress calls). */
  private helpers: Actor[] = [];
  private musicTimer = 0;
  // The living world: civilians, traffic, and short-lived danger zones from explosions.
  private crowd: CrowdSim | null = null;
  private crowdView: CrowdView | null = null;
  private traffic: Traffic | null = null;
  private blasts: { pos: THREE.Vector3; ttl: number }[] = [];
  private aiming = false;
  /** Finisher camera: a slow orbit around the last blow. */
  private cine: { focus: THREE.Vector3; t: number; duration: number; yaw: number } | null = null;
  private finisherCooldown = 0;
  private banterCooldown = 0;
  private lowHpCooldown = 0;
  private photo: { bar: HTMLElement; caption: HTMLElement; halftone: HTMLElement; filter: PhotoFilter; text: string } | null = null;
  private aimAt: AimResult | null = null;
  private aimMarker: { group: THREE.Group; ring: THREE.Mesh; arc: THREE.Line; mat: THREE.MeshBasicMaterial } | null = null;
  private portals: { group: THREE.Group; pos: THREE.Vector3; location: Location }[] = [];
  private travelling = false;
  private feedTimer = 0;
  private order: SquadOrder = 'free';
  /** Sandbox: heroes recruited into the squad from the Omni panel. */
  private sandboxSquad: string[] = [];
  private holdAt: THREE.Vector3 | null = null;
  /** The enemy the controlled hero last hit (for the Focus order). */
  private focusTarget: Actor | null = null;

  constructor(private readonly opts: SessionOptions) {
    const character = opts.universe.characters.find((c) => c.id === opts.characterId);
    if (!character) throw new Error('Character not found');
    this.character = character;
    this.spawnLevel = character.level;
    this.rules = { ...opts.universe.rules };

    this.root = h('div', { class: 'game' });
    opts.container.appendChild(this.root);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.root.appendChild(this.renderer.domElement);
    this.input = new Input(this.renderer.domElement);

    if (opts.bloom) {
      this.composer = new EffectComposer(this.renderer);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.composer.addPass(new UnrealBloomPass(new THREE.Vector2(256, 256), 0.55, 0.4, 0.88));
      this.composer.addPass(new OutputPass());
    }
    window.addEventListener('resize', this.onResize);
    this.resize();

    this.loop = this.loop.bind(this);
    this.frame = requestAnimationFrame(this.loop);

    if (opts.plan) void this.runPlan(opts.plan);
    else {
      this.sandboxSquad = (opts.squadIds ?? []).filter((id) => id !== opts.characterId).slice(0, 3);
      this.startSandbox(opts.sandboxLocationId ?? null);
    }
  }

  // --- Setup ---------------------------------------------------------------

  private resize() {
    const w = this.root.clientWidth || window.innerWidth;
    const hgt = this.root.clientHeight || window.innerHeight;
    this.renderer.setSize(w, hgt);
    this.composer?.setSize(w, hgt);
    this.camera.aspect = w / hgt;
    this.camera.updateProjectionMatrix();
  }

  private resolveLocation(id: string | null): Location {
    const u = this.opts.universe;
    return u.locations.find((l) => l.id === id) ?? u.locations[0] ?? randomLocation(new Rng(u.seed), 'metropolis');
  }

  private buildStage(location: Location, allyIds: string[]) {
    this.teardownStage();
    const u = this.opts.universe;
    const sky = new THREE.Color(location.skyColor);
    this.scene.background = sky;
    this.scene.fog = new THREE.Fog(sky, 40, 150);

    const arena = buildArena(location, u.seed ^ hashString(location.id));
    this.scene.add(arena.group);
    const fx = new Effects(this.scene);
    const combat = new Combat(this.scene, fx, arena.obstacles);
    this.resolveStageRules(location);
    combat.powerScale = this.rules.powerScale;
    combat.gravityScale = this.rules.gravity;
    combat.hazards = arena.hazards;
    // People (or aliens, or demons) going about their day, and traffic.
    this.crowd = new CrowdSim(arena.obstacles, arena.hazards);
    this.crowd.spawn(Math.round(14 + location.density * 18), speciesFor(location.biome));
    this.crowdView = new CrowdView(this.scene);
    this.traffic = new Traffic(this.scene, location.biome, new Rng(u.seed ^ hashString(location.id) ^ 0x7aff1c), arena.road);
    this.blasts = [];
    audio().setEnvironment(location.biome);
    audio().startAmbience(location.biome);
    // Smashable scenery: cars, crates, and fuel barrels.
    for (const prop of scatterProps(u.seed ^ hashString(location.id) ^ 0x5eed, location.biome, arena.obstacles, 16, arena.hazards, arena.road)) combat.add(prop);

    const c = this.character;
    const player = new Actor(c.alias, 'player', 'hero', effectiveStats(c, u.items), c.level, c.appearance, c.powers, undefined, c, loadoutFor(c, u.items));
    combat.add(player);

    // The AI squad forms up behind the hero.
    const allies: Actor[] = [];
    allyIds.forEach((id, i) => {
      const ch = u.characters.find((x) => x.id === id);
      if (!ch) return;
      const a = new Actor(ch.alias, 'player', 'ally', effectiveStats(ch, u.items), ch.level, ch.appearance, ch.powers, undefined, ch, loadoutFor(ch, u.items));
      a.pos.set((i - (allyIds.length - 1) / 2) * 3, 0, 3);
      combat.add(a);
      allies.push(a);
    });
    combat.downedEnabled = allies.length > 0;

    const hud = new Hud(player, this.input, () => this.togglePause());
    this.root.appendChild(hud.root);

    combat.onDamage = (e) => {
      const st = this.stage;
      if (!st) return;
      const controlled = st.player;
      const kind = e.heal ? 'heal' : e.target === controlled ? 'taken' : e.crit ? 'crit' : 'normal';
      if (e.target.archetype === 'prop') {
        if (e.source === controlled) hud.addCombo();
        return;
      }
      hud.damageNumber(e.target.center.add(new THREE.Vector3(0, 0.6, 0)), this.camera, e.amount, kind);
      if (e.heal) return;
      if (e.source === controlled) {
        hud.addCombo();
        if (e.crit) this.hitstop = Math.max(this.hitstop, 0.035);
        if (e.target.team === 'enemy') this.focusTarget = e.target;
      }
      if (e.target === controlled) fx.shake(0.15);
      if (e.target.team === 'player' && this.run) this.run.damageTaken += e.amount;
      // The squad's combined damage charges Team Assault.
      if (e.source?.team === 'player' && e.target.team === 'enemy' && st.allies.length) {
        hud.teamGauge = Math.min(100, hud.teamGauge + (e.amount / (basicDamage(controlled.stats, controlled.level) * 0.9)));
      }
    };
    combat.onKill = (target, killer) => this.onKill(target, killer);
    combat.onPropBroken = (_prop, by) => {
      if (by === this.stage?.player && Math.random() < 0.25) this.say('prop');
    };
    combat.onDowned = (a) => this.onDowned(a);
    combat.onRevived = (a, by) => {
      this.stage?.hud.banner(`${a.name} is back up`, by ? `Revived by ${by.name}` : '', 1.6);
      if (by && by !== this.stage?.player) this.say('revive', a, by);
    };
    combat.onSound = (name, pos, element) => this.playSound(name, pos, element);
    combat.onCombo = (recipe, first, second) => {
      if (this.run) this.run.combos++;
      hud.teamGauge = Math.min(100, hud.teamGauge + 25);
      this.hitstop = Math.max(this.hitstop, 0.08);
      if (first.team === 'player') {
        hud.banner(`Combo! ${recipe.name}`, `${first.name} + ${second.name}`, 1.4);
        const st = this.stage;
        const speaker = [first, second].find((x) => st?.allies.includes(x));
        if (speaker) this.say('combo', speaker === first ? second : first, speaker);
      }
    };
    combat.onPerfectDodge = (a) => {
      if (a !== this.stage?.player) return;
      audio().play('perfect');
      this.slowmo = Math.max(this.slowmo, 0.8);
      a.ultimate = Math.min(100, a.ultimate + 15);
      hud.banner('Perfect Dodge', '+15 ultimate charge', 1);
    };

    // Bosses fight in acts: enrage at 60%, last stand at 25%.
    const bosses = new BossDirector(combat, {
      spawnMinions: (count, near, boss) => {
        for (let i = 0; i < count; i++) this.spawnMinion(this.pickMinion(boss.level), boss.level, boss.character?.factionId ?? this.run?.plan.factionId ?? null, near);
      },
      announce: (boss, phase, piece) => {
        const st = this.stage;
        if (!st) return;
        const detail = { echoes: 'Echoes join the fight', giant: 'They grow to giant size', reinforcements: 'Reinforcements arrive', shield: 'Shielded, with backup on the way' }[piece];
        st.hud.banner(`${boss.name} ${phase.subtitle}`, `${detail} · Watch for the warning circles!`, 2.2);
        st.hud.refreshBoss(boss);
        this.slowmo = Math.max(this.slowmo, 0.7);
        audio().play('stinger');
        this.say('enrage');
      },
    });
    this.stage = { arena, combat, fx, player, allies, hud, location, bosses };
    hud.setSquad([player, ...allies]);
    hud.setOrder(ORDER_LABELS[this.order]);
    this.camYaw = Math.PI;
    this.camTarget.copy(player.center);
  }

  /** Universe rules, then the location's local laws, then (sandbox only) session overrides. */
  private resolveStageRules(location: Location) {
    const layers = [{ label: location.name, rules: location.rules }];
    if (!this.opts.plan) layers.push({ label: 'Session', rules: this.sessionRules });
    const resolved = resolveRules(this.opts.universe.rules, layers);
    this.rules = resolved.rules;
    this.ruleSource = resolved.source;
  }

  private teardownStage() {
    if (!this.stage) return;
    const s = this.stage;
    this.stopAmbient();
    this.helpers = [];
    for (const p of this.portals) this.disposeGroup(p.group);
    this.portals = [];
    for (const b of this.run?.beacons ?? []) if (b.state !== 'done') this.retireBeacon(b, false);
    s.combat.clear();
    s.fx.clear();
    this.scene.remove(s.arena.group);
    s.arena.dispose();
    this.crowdView?.dispose();
    this.traffic?.dispose();
    this.crowd = this.crowdView = this.traffic = null;
    s.hud.root.remove();
    this.stage = null;
  }

  // --- Spawning ------------------------------------------------------------

  private factionColor(factionId: string | null): string {
    return this.opts.universe.factions.find((f) => f.id === factionId)?.color ?? '#c02838';
  }

  private spawnMinion(type: Minion, level: number, factionId: string | null, around?: THREE.Vector3): Actor | null {
    const s = this.stage;
    if (!s) return null;
    const color = this.factionColor(factionId);
    // Threat tiers scale the sandbox; missions play at their own level.
    const t = this.opts.plan ? null : this.tier;
    const lvl = Math.max(1, level + (t?.levelBonus ?? 0));
    const elite = !!t && Math.random() < t.eliteChance;
    const appearance: Appearance = {
      primary: color,
      secondary: '#1a1c24',
      accent: elite ? '#ffc23e' : type === 'gunner' ? '#ff4040' : '#30343c',
      build: type === 'brute' ? 'heavy' : 'athletic',
      height: type === 'brute' ? 1.1 : elite ? 1.05 : 0.95,
      head: type === 'gunner' ? 'visor' : 'helmet',
      emblem: elite ? 'star' : 'none',
      cape: elite,
      aura: elite,
      model: null,
    };
    const stats = minionStats(lvl, type);
    const name = `${elite ? 'Elite ' : ''}${type === 'brute' ? 'Brute' : type === 'gunner' ? 'Gunner' : 'Trooper'}`;
    const health = Math.round(minionHealth(stats, lvl, type) * (t?.health ?? 1) * (elite ? 2.5 : 1));
    const e = new Actor(name, 'enemy', type, stats, lvl, appearance, [], health);
    e.damageMult = (t?.damage ?? 1) * (elite ? 1.5 : 1);
    // Some gunners take the high ground: rooftops, ledges, and the skydeck.
    const perch = !around && type === 'gunner' && Math.random() < 0.4 ? this.perchNear(s.player.pos, 10, 35) : null;
    if (perch) e.pos.copy(perch);
    else {
      const a = Math.random() * Math.PI * 2;
      const d = around ? 5 + Math.random() * 6 : 18 + Math.random() * 12;
      const center = around ?? s.player.pos;
      e.pos.set(center.x + Math.cos(a) * d, 0, center.z + Math.sin(a) * d);
      clampToArena(e.pos, 3);
    }
    e.ai.spawn = 0.8;
    s.combat.add(e);
    s.fx.flare(e.center, color, 2.5, 0.4);
    s.fx.ring(e.pos, color, 2.5);
    return e;
  }

  private spawnBoss(character: Character, level: number, power = 1, at?: THREE.Vector3): Actor | null {
    const s = this.stage;
    if (!s) return null;
    const stats = effectiveStats(character, this.opts.universe.items);
    const t = this.opts.plan ? null : this.tier;
    const lvl = Math.max(1, Math.max(character.level, level) + (t?.levelBonus ?? 0));
    const boss = new Actor(character.alias, 'enemy', 'boss', stats, lvl, character.appearance, character.powers, Math.round(maxHealth(stats, lvl) * 4 * power * (t?.health ?? 1)), character, loadoutFor(character, this.opts.universe.items));
    boss.damageMult = t?.damage ?? 1;
    if (power > 1) boss.title = 'Nemesis';
    if (at) boss.pos.copy(at);
    else boss.pos.set(s.player.pos.x, 0, s.player.pos.z - 16);
    clampToArena(boss.pos, 3);
    boss.faceToward(s.player.pos);
    boss.ai.spawn = 1.5;
    boss.ai.slam = 4;
    s.combat.add(boss);
    s.fx.flare(boss.center, character.appearance.accent, 5, 0.6);
    s.fx.ring(boss.pos, character.appearance.accent, 6, 0.6);
    s.fx.shake(0.5);
    return boss;
  }

  /** A random raised spot (rooftop, ledge, platform) at a horizontal distance from p. */
  private perchNear(p: THREE.Vector3, minDist: number, maxDist: number): THREE.Vector3 | null {
    const options = (this.stage?.arena.perches ?? []).filter((q) => {
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      return q.y > 2 && d >= minDist && d <= maxDist;
    });
    return options.length ? options[Math.floor(Math.random() * options.length)].clone() : null;
  }

  private pickMinion(level: number): Minion {
    const r = Math.random();
    if (level >= 3 && r < 0.15) return 'brute';
    if (r < 0.45) return 'gunner';
    return 'grunt';
  }

  private refreshBossBar() {
    const r = this.run;
    const s = this.stage;
    if (!r || !s) return;
    s.hud.setBoss(r.bosses.find((b) => b.alive) ?? null);
  }

  // --- Mission flow --------------------------------------------------------

  private async runPlan(plan: MissionPlan) {
    this.buildStage(this.resolveLocation(plan.locationId), plan.allyIds);
    const s = this.stage!;
    this.run = {
      plan, phase: -1, killed: 0, spawned: 0, elapsed: 0, spawnTimer: 0, bosses: [], defeated: [], beacons: [],
      ambush: plan.ambushId ? 'pending' : 'none', transitioning: true, done: false,
      startedAt: 0, damageTaken: 0, downs: 0, combos: 0,
    };
    const run = this.run;
    s.hud.setObjective('');
    audio().play('banner');
    s.combat.schedule(6, () => this.say(plan.title.startsWith('Stop the') ? 'scheme' : 'start'));
    s.hud.banner(plan.title, plan.teamName ? `${plan.teamName} assemble!` : plan.subtitle, 2.6);
    this.paused = true;
    await wait(1200);
    if (this.disposed || this.run !== run) return;
    await s.hud.dialogue(plan.intro, this.opts.universe.accent);
    if (this.disposed || this.run !== run) return;
    this.paused = false;
    run.startedAt = this.time;
    this.startPhase(0);
  }

  private startPhase(index: number) {
    const r = this.run;
    const s = this.stage;
    if (!r || !s) return;
    const phase = r.plan.phases[index];
    if (!phase) {
      void this.complete();
      return;
    }
    Object.assign(r, { phase: index, killed: 0, spawned: 0, elapsed: 0, spawnTimer: 0, bosses: [], transitioning: false });
    const label = phase.label ?? phaseLabel(phase, this.opts.universe);
    s.hud.banner(r.plan.phases.length > 1 ? `Phase ${index + 1}` : 'Mission Start', label, 1.8);

    if (phase.kind === 'bosses') {
      phase.bossIds.forEach((id, i) => {
        const ch = this.opts.universe.characters.find((c) => c.id === id);
        if (!ch) return;
        const angle = (i - (phase.bossIds.length - 1) / 2) * 0.9;
        const at = new THREE.Vector3(s.player.pos.x + Math.sin(angle) * 16, 0, s.player.pos.z - Math.cos(angle) * 16);
        const boss = this.spawnBoss(ch, phase.level ?? r.plan.level, phase.power ?? r.plan.bossPower[id] ?? 1, at);
        if (boss) r.bosses.push(boss);
      });
      this.refreshBossBar();
    } else if (phase.kind === 'patrol') {
      r.beacons = phase.events.map((event, i) => this.makeBeacon(event, i, phase.events.length));
      if (r.plan.ambient) this.startAmbient(r.plan.ambient.villainIds, r.plan.ambient.allyIds);
    }
  }

  private makeBeacon(event: PatrolEvent, i: number, total: number): Beacon {
    const angle = (i / total) * Math.PI * 2 + 0.6;
    const dist = 20 + (i % 2) * 12;
    const pos = new THREE.Vector3(Math.cos(angle) * dist, 0, Math.sin(angle) * dist);
    const color = event.kind === 'elite' ? '#ff3e5c' : event.kind === 'rescue' ? '#3eff8b' : '#ffc23e';
    const radius = event.kind === 'rescue' ? 9 : 5;
    const group = new THREE.Group();
    const pillar = new THREE.Mesh(
      new THREE.CylinderGeometry(0.6, 0.6, 40, 12, 1, true),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    );
    pillar.position.y = 20;
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(radius - 0.5, radius, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.y = 0.1;
    group.add(pillar, ring);
    group.position.copy(pos);
    this.scene.add(group);
    return { pos, event, state: 'idle', group, actors: new Set(), timer: 0 };
  }

  private retireBeacon(b: Beacon, flash = true) {
    b.state = 'done';
    this.scene.remove(b.group);
    b.group.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    if (flash) this.stage?.fx.ring(b.pos, '#ffffff', 6);
  }

  private updateRun(dt: number) {
    const r = this.run;
    const s = this.stage;
    if (!r || !s || r.done || r.transitioning || r.phase < 0) return;
    const phase = r.plan.phases[r.phase];
    const density = this.rules.enemyDensity;
    const level = phase.kind === 'patrol' ? r.plan.level : phase.level ?? r.plan.level;
    const factionId = r.plan.factionId;
    const alive = s.combat.actors.filter((a) => isFoe(a) && a.alive && a.archetype !== 'boss').length;
    r.elapsed += dt;
    r.spawnTimer -= dt;
    const canSpawn = (max: number) => r.spawnTimer <= 0 && alive < Math.round(max * density);
    let complete = false;

    switch (phase.kind) {
      case 'defeat': {
        const goal = Math.max(1, Math.round(phase.count * density));
        if (canSpawn(6) && r.spawned < goal) {
          this.spawnMinion(this.pickMinion(level), level, factionId);
          r.spawned++;
          r.spawnTimer = 0.6;
        }
        s.hud.setObjective(`${phase.label ?? 'Defeat enemies'}  ${Math.min(r.killed, goal)} / ${goal}`);
        complete = r.killed >= goal;
        break;
      }
      case 'survive': {
        const left = Math.max(0, phase.seconds - r.elapsed);
        if (canSpawn(6)) {
          this.spawnMinion(this.pickMinion(level), level, factionId, s.allies[0]?.alive ? s.allies[0].pos : undefined);
          r.spawnTimer = 1.2;
        }
        s.hud.setObjective(`${phase.label ?? 'Survive'}  ${formatTime(left)}`);
        complete = left <= 0;
        break;
      }
      case 'bosses': {
        if (phase.minions && canSpawn(3) && r.elapsed > 8) {
          this.spawnMinion('grunt', level, factionId);
          r.spawnTimer = 6;
        }
        const left = r.bosses.filter((b) => b.alive);
        s.hud.setObjective(left.length ? `Defeat ${left.map((b) => b.name).join(' & ')}` : '');
        complete = left.length === 0;
        break;
      }
      case 'patrol':
        complete = this.updatePatrol(dt, canSpawn(4));
        break;
    }

    if (complete) {
      r.transitioning = true;
      if (r.phase + 1 < r.plan.phases.length) {
        s.hud.banner('Phase Complete', '', 1.4);
        setTimeout(() => this.run === r && this.startPhase(r.phase + 1), 1600);
      } else void this.complete();
    }
  }

  /** Patrol: walk to beacons to trigger events; a nemesis may ambush partway. Returns true when done. */
  private updatePatrol(dt: number, canSpawn: boolean): boolean {
    const r = this.run!;
    const s = this.stage!;
    const level = r.plan.level;
    const p = s.player.pos;
    const active = r.beacons.find((b) => b.state === 'active');

    if (!active) {
      const idle = r.beacons.filter((b) => b.state === 'idle').sort((a, b) => a.pos.distanceTo(p) - b.pos.distanceTo(p));
      const next = idle[0];
      if (next && next.pos.distanceTo(p) < (next.event.kind === 'rescue' ? 9 : 5)) this.activateBeacon(next);
      else if (next) s.hud.setObjective(`Patrol ${r.beacons.length - idle.length} / ${r.beacons.length}  ·  ${eventLabel(next.event, this.opts.universe)}  ${Math.round(next.pos.distanceTo(p))}m`);
    } else {
      switch (active.event.kind) {
        case 'squad': {
          const left = [...active.actors].filter((a) => a.alive).length;
          s.hud.setObjective(`Squad: ${left} remaining`);
          if (left === 0) this.retireBeacon(active);
          break;
        }
        case 'rescue': {
          const inside = p.distanceTo(active.pos) < 9;
          if (inside) active.timer += dt;
          if (canSpawn) {
            this.spawnMinion(this.pickMinion(level), level, r.plan.factionId, active.pos);
            r.spawnTimer = 1.6;
          }
          const left = Math.max(0, active.event.seconds - active.timer);
          s.hud.setObjective(inside ? `Protect civilians  ${formatTime(left)}` : 'Return to the civilians!');
          if (left <= 0) {
            this.retireBeacon(active);
            for (const e of s.combat.actors.filter((a) => isFoe(a) && a.alive && a.archetype !== 'boss' && a.pos.distanceTo(active.pos) < 25)) {
              s.combat.damage(e, 1e6, s.player, null);
            }
            s.hud.banner('Civilians Saved', '', 1.4);
            this.crowd?.release(active.pos, 12);
            audio().play('cheer', { voice: voiceOf(speciesFor(s.location.biome)) });
          }
          break;
        }
        case 'elite': {
          const boss = [...active.actors][0];
          s.hud.setObjective(boss ? `Defeat ${boss.name}` : '');
          if (!boss || !boss.alive) this.retireBeacon(active);
          break;
        }
      }
    }

    const done = r.beacons.filter((b) => b.state === 'done').length;
    if (r.ambush === 'pending' && done >= 1 && r.plan.ambushId) {
      const nemesis = this.opts.universe.characters.find((c) => c.id === r.plan.ambushId);
      const at = p.clone().add(new THREE.Vector3(10, 0, -10));
      const boss = nemesis ? this.spawnBoss(nemesis, level, r.plan.bossPower[nemesis.id] ?? 1, at) : null;
      if (boss) {
        r.bosses.push(boss);
        r.ambush = 'active';
        this.refreshBossBar();
        s.hud.banner('Ambush!', `${boss.name}: “${r.plan.ambushLine}”`, 3);
      } else r.ambush = 'done';
    }
    if (r.ambush === 'active' && r.bosses.every((b) => !b.alive)) r.ambush = 'done';
    if (r.ambush === 'active') s.hud.setObjective(`Defeat ${r.bosses.find((b) => b.alive)?.name ?? 'the ambusher'}`);
    return done === r.beacons.length && r.ambush !== 'active' && r.ambush !== 'pending';
  }

  private activateBeacon(b: Beacon) {
    const r = this.run!;
    const s = this.stage!;
    b.state = 'active';
    s.hud.banner(eventLabel(b.event, this.opts.universe), '', 1.6);
    // Civilians trapped at the scene: they cower until the area is safe.
    if (b.event.kind === 'rescue') this.crowd?.spawn(6, speciesFor(s.location.biome), b.pos, 4, 'cower');
    if (b.event.kind === 'squad') {
      for (let i = 0; i < Math.round(b.event.count * this.rules.enemyDensity); i++) {
        const e = this.spawnMinion(this.pickMinion(r.plan.level), r.plan.level, r.plan.factionId, b.pos);
        if (e) b.actors.add(e);
      }
    } else if (b.event.kind === 'elite') {
      const bossId = b.event.bossId;
      const ch = this.opts.universe.characters.find((c) => c.id === bossId);
      const boss = ch ? this.spawnBoss(ch, r.plan.level, r.plan.bossPower[ch.id] ?? 1, b.pos.clone()) : null;
      if (boss) {
        b.actors.add(boss);
        r.bosses.push(boss);
        this.refreshBossBar();
      }
    }
  }

  private async complete() {
    const r = this.run;
    const s = this.stage;
    if (!r || !s || r.done) return;
    r.done = true;
    const ambient = this.ambient?.results;
    this.stopAmbient();
    s.hud.setObjective('');
    s.hud.setBoss(null);
    this.slowmo = 1.2;
    for (const a of s.combat.actors) {
      if ((a.team === 'enemy' || a.homeTeam === 'enemy') && a.alive) {
        s.fx.flare(a.center, '#ffffff', 2, 0.4);
        a.alive = false;
      }
    }
    s.hud.banner('Mission Complete', r.plan.title, 2.4);
    audio().play('victory');
    await wait(2200);
    if (this.disposed || this.run !== r) return;
    this.paused = true;
    await s.hud.dialogue(r.plan.outro, this.opts.universe.accent);
    if (this.disposed || this.run !== r) return;

    let choice: number | null = null;
    if (r.plan.choice) {
      const c = r.plan.choice;
      choice = await s.hud.choose('Your Choice', c.prompt, c.options.map((o) => ({ label: o.label })));
    }

    const outcomes: Record<string, BossOutcome> = {};
    if (r.plan.decideBosses && this.opts.bossOptions) {
      for (const id of r.defeated) {
        const ch = this.opts.universe.characters.find((c) => c.id === id);
        if (!ch) continue;
        const options = this.opts.bossOptions(id);
        const pick = await s.hud.choose(`${ch.alias} is defeated`, 'Decide their fate. The world will remember.', options);
        outcomes[id] = options[pick]?.id ?? 'arrest';
      }
    }

    // Grade the run, then hand out rewards (bonus XP for a good grade).
    const totalHp = [s.player, ...s.allies].reduce((t, a) => t + a.maxHp, 0) || 1;
    const graded = gradeRun({
      seconds: this.time - r.startedAt,
      parSeconds: parTime(r.plan.phases),
      damageTakenRatio: r.damageTaken / totalHp,
      maxCombo: s.hud.maxCombo,
      downs: r.downs,
    });
    const xp = Math.round(r.plan.xp * (1 + graded.xpBonus));
    const u = this.opts.universe;
    const before = this.character.level;
    this.grantSquadXp(xp);
    const levels = this.character.level - before;
    const reward = u.items.find((i) => i.id === r.plan.rewardItemId);
    let rewardNote = '';
    if (reward) {
      if (this.character.itemIds.includes(reward.id)) rewardNote = `${reward.name} (already equipped)`;
      else if (this.character.itemIds.length < 4) {
        this.character.itemIds.push(reward.id);
        rewardNote = `${reward.name} — equipped!`;
      } else rewardNote = `${reward.name} (gear slots full)`;
    }
    this.opts.onSave();

    const squadIds = [s.player, ...s.allies].map((a) => a.character?.id).filter((id): id is string => !!id && id !== this.character.id);
    const result: MissionResult = { victory: true, defeatedBossIds: r.defeated, survivingBossIds: [], outcomes, choice, ambient, grade: graded.grade, squadIds, combos: r.combos, score: graded.score, phasesCleared: r.plan.phases.length };
    s.hud.modal(
      'Mission Complete',
      h('div', { class: 'rewards' },
        h('div', { class: 'row' }, h('span', { class: `grade grade-${graded.grade}` }, graded.grade), h('span', { class: 'muted small' }, `Score ${graded.score} · ${formatTime(this.time - r.startedAt)} · best combo ${s.hud.maxCombo} · ${r.combos} team combos · ${r.downs} downs`)),
        h('div', null, `+${xp} XP${graded.xpBonus ? ` (grade bonus +${Math.round(graded.xpBonus * 100)}%)` : ''}${s.allies.length ? ' for the whole squad' : ''}`),
        levels > 0 && h('div', { class: 'reward-level' }, `LEVEL UP! Now level ${this.character.level}`),
        reward && h('div', { style: `color:${RARITY_COLORS[reward.rarity]}` }, `Reward: ${rewardNote}`),
        ambient && ambient.completed > 0 && h('div', null, `Side events handled: ${ambient.completed}`),
      ),
      [{ label: 'Continue', primary: true, onClick: () => this.finish(result) }],
    );
  }

  private finish(result: MissionResult) {
    const next = this.opts.onFinish?.(result) ?? null;
    this.stage?.hud.modal('', null, []);
    if (next && !this.disposed) void this.runPlan(next);
    else this.exit();
  }

  private onKill(target: Actor, killer: Actor | null = null) {
    const s = this.stage;
    const r = this.run;
    if (!s) return;
    this.maybeFinisher(s, target, killer);
    const inSquad = target === s.player || s.allies.includes(target);
    if (inSquad) {
      // A squad member bled out. The mission goes on while anyone can still fight.
      const standing = [s.player, ...s.allies].filter((a) => a.alive || a.downed);
      if (standing.length) {
        s.hud.banner(`${target.name} is out`, 'Keep fighting', 1.6);
        if (target === s.player) this.swapHero();
        return;
      }
      this.squadWiped();
      return;
    }
    if (this.helpers.includes(target)) {
      s.hud.banner(`${target.name} is down!`, '', 1.6);
      return;
    }
    if (target.archetype === 'boss') {
      this.slowmo = 1;
      this.say('bossDown');
      if (r && target.character && !r.defeated.includes(target.character.id)) r.defeated.push(target.character.id);
      this.refreshBossBar();
    } else if (r) r.killed++;
    this.grantSquadXp(xpReward(target.level, target.archetype === 'boss') * (this.opts.plan ? 1 : this.tier.xp));
    s.combat.schedule(1.4, () => {
      if (this.stage === s) s.combat.remove(target);
    });
  }

  /** A squad member went down (revivable). Hands control to someone still standing. */
  private onDowned(a: Actor) {
    const s = this.stage;
    if (!s) return;
    if (this.run) this.run.downs++;
    s.hud.banner(`${a.name} is down!`, 'A teammate can revive them', 1.6);
    this.say('down', a, s.allies.find((x) => x !== a && x.alive));
    if (a !== s.player) return;
    const next = s.allies.find((x) => x.alive);
    if (next) setTimeout(() => this.stage === s && s.player === a && !a.alive && this.swapHero(next), 900);
    else this.squadWiped();
  }

  /** Everyone is down: fail the mission (or, in the sandbox, respawn the squad). */
  private squadWiped() {
    const s = this.stage;
    const r = this.run;
    if (!s) return;
    if (!r) {
      s.hud.banner('Down!', 'Respawning...', 1.6);
      setTimeout(() => this.respawnPlayer(), 1500);
      return;
    }
    {
      this.slowmo = 1.5;
      setTimeout(() => {
        if (this.disposed || this.stage !== s || this.run !== r) return;
        this.paused = true;
        const standing = r.bosses.filter((b) => b.alive && b.character);
        const surviving = standing.map((b) => b.character!.id);
        const note = standing.length ? `${standing.map((b) => b.name).join(' & ')} will remember this victory.` : 'Even legends fall. Get back up?';
        s.hud.modal('Defeated', note, [
          { label: 'Retry', primary: true, onClick: () => (s.hud.modal('', null, []), void this.runPlan(r.plan)) },
          { label: 'Retreat', onClick: () => this.finishFailure(r, surviving) },
        ]);
      }, 1400);
    }
  }

  // --- Squad -------------------------------------------------------------------

  /** Hands control to another squad member (Tab), or to `to` if given. */
  private swapHero(to?: Actor) {
    const s = this.stage;
    if (!s || !s.allies.length) return;
    const squad = [s.player, ...s.allies];
    const start = squad.indexOf(s.player);
    const next = to ?? squad.slice(start + 1).concat(squad.slice(0, start)).find((a) => a.alive);
    if (!next || next === s.player) return;
    const prev = s.player;
    prev.archetype = 'ally';
    prev.moveIntent.set(0, 0, 0);
    prev.squadRole = null;
    next.archetype = 'hero';
    next.moveIntent.set(0, 0, 0);
    s.player = next;
    s.allies = squad.filter((a) => a !== next);
    s.hud.setPlayer(next);
    s.hud.banner(next.name, 'You are in control', 1.1);
    this.focusTarget = null;
  }

  private cycleOrder() {
    const s = this.stage;
    if (!s || !s.allies.length) return;
    const orders: SquadOrder[] = ['free', 'focus', 'follow', 'hold'];
    this.order = orders[(orders.indexOf(this.order) + 1) % orders.length];
    this.holdAt = this.order === 'hold' ? s.player.pos.clone() : null;
    s.hud.setOrder(ORDER_LABELS[this.order]);
    s.hud.banner('Squad order', ORDER_LABELS[this.order], 1.1);
  }

  private teamAssault() {
    const s = this.stage;
    if (!s || !s.allies.length) return;
    if (s.hud.teamGauge < 100) {
      s.hud.banner('Team Assault charging', `${Math.floor(s.hud.teamGauge)}%`, 0.9);
      return;
    }
    const n = s.combat.teamAssault(s.player);
    if (n < 2) {
      s.hud.banner('Team Assault', 'Get closer to your team', 1.1);
      return;
    }
    s.hud.teamGauge = 0;
    this.slowmo = 1;
    s.hud.banner('Team Assault!', [s.player, ...s.allies].filter((a) => a.alive).map((a) => a.name).join(' · '), 1.8);
  }

  /** XP is shared by the whole squad (so tag-switching never costs progress). */
  private grantSquadXp(amount: number) {
    const s = this.stage;
    if (!s) return;
    const members = [s.player, ...s.allies].filter((a) => a.character);
    for (const a of members) {
      const levels = grantXp(a.character!, amount);
      if (levels > 0) {
        if (a === s.player) this.applyLevelUp();
        else {
          a.level = a.character!.level;
          a.maxHp = Math.round(maxHealth(a.stats, a.level) * rankBonus(a.character!.stars).health);
          a.hp = a.alive ? a.maxHp : a.hp;
        }
      }
    }
    if (!members.some((a) => a.character === this.character)) grantXp(this.character, amount);
  }

  private finishFailure(r: Run, surviving: string[]) {
    this.opts.onFinish?.({ victory: false, defeatedBossIds: r.defeated, survivingBossIds: surviving, outcomes: {}, choice: null, phasesCleared: Math.max(0, r.phase) });
    this.exit();
  }

  private applyLevelUp() {
    const s = this.stage;
    if (!s) return;
    const p = s.player;
    const before = p.level;
    p.level = p.character?.level ?? this.character.level;
    p.maxHp = Math.round(maxHealth(p.stats, p.level) * rankBonus(p.character?.stars ?? 1).health);
    p.hp = p.maxHp;
    p.energy = p.maxEnergy;
    // New mastery tiers are chosen in the creator and apply from the next fight.
    const unlocked = masteryUnlocked(before, p.level);
    s.hud.banner('Level Up!', unlocked.length ? `Level ${p.level} · Mastery tier unlocked: choose it in Characters` : `Level ${p.level}`, unlocked.length ? 2.6 : 1.8);
    audio().play('levelup');
    s.fx.flare(p.center, '#ffd23e', 4, 0.6);
    s.fx.ring(p.pos, '#ffd23e', 5, 0.6);
    this.opts.onSave();
  }

  /** Sandbox: bring the whole squad back to the center at full strength. */
  private respawnPlayer() {
    const s = this.stage;
    if (!s || this.disposed) return;
    [s.player, ...s.allies].forEach((p, i) => {
      p.alive = true;
      p.downed = false;
      p.hp = p.maxHp;
      p.energy = p.maxEnergy;
      p.invuln = 2;
      p.model.root.rotation.x = 0;
      p.pos.set(i * 2.5, 0, i ? 3 : 0);
      s.fx.flare(p.center, '#ffffff', 3, 0.5);
    });
  }

  /** Sandbox: recruit a hero into the AI squad on the spot. */
  private addToSquad(ch: Character) {
    const s = this.stage;
    if (!s || s.allies.length >= 3 || [s.player, ...s.allies].some((a) => a.character?.id === ch.id)) return;
    const u = this.opts.universe;
    const a = new Actor(ch.alias, 'player', 'ally', effectiveStats(ch, u.items), ch.level, ch.appearance, ch.powers, undefined, ch, loadoutFor(ch, u.items));
    a.pos.copy(s.player.pos).add(new THREE.Vector3(2.5, 0, 2.5));
    s.combat.add(a);
    s.allies.push(a);
    s.combat.downedEnabled = true;
    s.fx.flare(a.center, ch.appearance.accent, 3, 0.5);
    this.sandboxSquad = [s.player, ...s.allies].map((x) => x.character!.id).filter((id) => id !== this.character.id);
    s.hud.setSquad([s.player, ...s.allies]);
    s.hud.setOrder(ORDER_LABELS[this.order]);
  }

  private dismissSquad() {
    const s = this.stage;
    if (!s) return;
    // Take back control of the original hero first.
    const hero = [s.player, ...s.allies].find((a) => a.character?.id === this.character.id);
    if (hero && hero !== s.player) this.swapHero(hero);
    for (const a of s.allies) {
      s.fx.flare(a.center, '#ffffff', 2, 0.3);
      s.combat.remove(a);
    }
    s.allies = [];
    s.combat.downedEnabled = false;
    this.sandboxSquad = [];
    s.hud.setSquad([s.player]);
  }

  // --- Ambient events ---------------------------------------------------------

  /** Starts side events. Ids narrow who can appear; null means anyone suitable in the universe. */
  private startAmbient(villainIds: string[] | null, allyIds: string[] | null) {
    this.stopAmbient();
    const s = this.stage;
    if (!s) return;
    const u = this.opts.universe;
    const busy = new Set([this.character.id, ...[s.player, ...s.allies].map((a) => a.character?.id)]);
    const cast = (ids: string[] | null, fallback: (c: Character) => boolean) =>
      (ids ? ids.map((id) => u.characters.find((c) => c.id === id)).filter((c): c is Character => !!c) : u.characters.filter(fallback)).filter((c) => !busy.has(c.id));
    const level = () => this.run?.plan.level ?? this.spawnLevel;
    const host: AmbientHost = {
      player: () => s.player,
      spawnMinion: (type, around) => this.spawnMinion(type, level(), this.run?.plan.factionId ?? null, around),
      spawnFugitive: (ch, at) => {
        const b = this.spawnBoss(ch, level(), 0.5, at);
        if (b) {
          b.ai.flee = 1;
          b.title = 'Fugitive';
          if (!this.run?.bosses.some((x) => x.alive)) s.hud.setBoss(b);
        }
        return b;
      },
      spawnHelper: (ch, at) => {
        const a = new Actor(ch.alias, 'player', 'ally', effectiveStats(ch, u.items), ch.level, ch.appearance, ch.powers, undefined, ch, loadoutFor(ch, u.items));
        a.pos.copy(at);
        s.combat.add(a);
        s.fx.flare(a.center, ch.appearance.accent, 2.5, 0.4);
        this.helpers.push(a);
        return a;
      },
      dismiss: (a) => {
        s.fx.flare(a.center, '#ffffff', 2.5, 0.4);
        s.combat.remove(a);
        this.helpers = this.helpers.filter((x) => x !== a);
        if (this.run) this.refreshBossBar();
        else s.hud.setBoss(null);
      },
      perchNear: (p, min, max) => this.perchNear(p, min, max),
      floorAt: () => 0,
      reward: (xp, note) => {
        const gained = Math.round(xp * (this.opts.plan ? 1 : this.tier.xp));
        const levels = grantXp(this.character, gained);
        s.hud.banner('Event complete', `${note} · +${gained} XP`, 2.2);
        if (levels > 0) this.applyLevelUp();
        this.opts.onSave();
      },
      restore: () => {
        const p = s.player;
        p.hp = Math.min(p.maxHp, p.hp + p.maxHp * 0.4);
        p.energy = p.maxEnergy;
        p.ultimate = Math.min(100, p.ultimate + 40);
        s.fx.flare(p.center, '#3ee8ff', 3, 0.5);
      },
      banner: (title, sub) => s.hud.banner(title, sub, 2),
      villains: cast(villainIds, (c) => c.role === 'villain'),
      allies: cast(allyIds, (c) => c.role !== 'villain'),
    };
    this.ambient = new AmbientDirector(host, this.scene);
  }

  private stopAmbient() {
    this.ambient?.dispose();
    this.ambient = null;
    this.stage?.hud.setFeed([]);
  }

  // --- Sandbox -------------------------------------------------------------

  private startSandbox(locationId: string | null) {
    const location = this.resolveLocation(locationId);
    this.buildStage(location, this.sandboxSquad);
    const s = this.stage!;
    if (this.opts.freeRoam) {
      // Free Roam: explore, help people, and take on whatever happens.
      s.hud.banner(location.name, 'Free Roam · events appear as you explore', 2.6);
      s.hud.setObjective(`Free Roam · ${location.name}`);
      this.buildPortals(location);
      this.ambientInSandbox = true;
      this.startAmbient(null, null);
      return;
    }
    s.hud.banner(locationId ? `Entering ${location.name}` : 'Omni Sandbox', locationId ? `${this.tier.label} threat` : 'You are the One Above All', 2.4);
    s.hud.setObjective(`Free play · ${location.name}`);
    this.buildPortals(location);
    if (this.ambientInSandbox) this.startAmbient(null, null);
    this.buildOmniPanel(s);
  }

  /** Gates at the arena edge to every other location in the universe. */
  private buildPortals(current: Location) {
    const s = this.stage!;
    const others = this.opts.universe.locations.filter((l) => l.id !== current.id).slice(0, 6);
    others.forEach((loc, i) => {
      const a = (i / others.length) * Math.PI * 2 + 0.35;
      const pos = new THREE.Vector3(Math.cos(a) * 47, 0, Math.sin(a) * 47);
      const group = new THREE.Group();
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(2.4, 0.22, 10, 40),
        new THREE.MeshStandardMaterial({ color: loc.glowColor, emissive: loc.glowColor, emissiveIntensity: 2 }),
      );
      const veil = new THREE.Mesh(
        new THREE.CircleGeometry(2.3, 32),
        new THREE.MeshBasicMaterial({ color: loc.skyColor, transparent: true, opacity: 0.85, side: THREE.DoubleSide }),
      );
      const glow = new THREE.Mesh(
        new THREE.CircleGeometry(2.3, 32),
        new THREE.MeshBasicMaterial({ color: loc.glowColor, transparent: true, opacity: 0.25, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
      );
      glow.position.z = 0.05;
      group.add(ring, veil, glow);
      group.position.set(pos.x, 2.6, pos.z);
      group.lookAt(0, 2.6, 0);
      this.scene.add(group);
      this.portals.push({ group, pos, location: loc });
      s.hud.worldLabels.push({ id: `portal-${loc.id}`, pos: pos.clone().setY(5.8), text: `⇢ ${loc.name}`, color: loc.glowColor });
    });
  }

  private checkPortals(s: Stage) {
    if (this.travelling) return;
    const p = s.player.pos;
    const gate = this.portals.find((g) => Math.hypot(g.pos.x - p.x, g.pos.z - p.z) < 2.8 && p.y < 5);
    if (gate) this.travelTo(gate.location.id);
  }

  /** Moves the sandbox to another location without leaving the session. */
  private travelTo(locationId: string) {
    if (this.travelling || this.run) return;
    this.travelling = true;
    this.stage?.fx.flare(this.stage.player.center, '#ffffff', 4, 0.4);
    this.startSandbox(locationId);
    this.travelling = false;
  }

  private disposeGroup(g: THREE.Group) {
    this.scene.remove(g);
    g.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
  }

  private applySessionRules() {
    const s = this.stage;
    if (!s) return;
    this.resolveStageRules(s.location);
    s.combat.powerScale = this.rules.powerScale;
    s.combat.gravityScale = this.rules.gravity;
  }

  private buildOmniPanel(s: Stage) {
    const u = this.opts.universe;
    const panel = s.hud.sidePanel;
    panel.classList.remove('hidden');
    const levelLabel = h('span', null, String(this.spawnLevel));
    const bosses = u.characters.filter((c) => c.id !== this.character.id);
    const bossSelect = h('select', null, ...bosses.map((c) => h('option', { value: c.id }, `${c.alias} (${c.role})`)));
    const heroes = u.characters.filter((c) => c.id !== this.character.id && c.role !== 'villain');
    const squadSelect = h('select', null, ...heroes.map((c) => h('option', { value: c.id }, c.alias)));

    const tierHint = h('div', { class: 'omni-hint' });
    const tierChips = h('div', { class: 'omni-tiers' });
    const renderTiers = () => {
      const t = this.tier;
      tierHint.textContent = `Enemy Lv ${t.levelBonus >= 0 ? '+' : ''}${t.levelBonus} · HP ×${t.health} · DMG ×${t.damage} · XP ×${t.xp} · Elites ${Math.round(t.eliteChance * 100)}%`;
      tierChips.replaceChildren(...THREAT_TIERS.map((x) => h('button', { class: `chip${x.id === t.id ? ' active' : ''}`, onclick: () => ((this.tier = x), renderTiers()) }, x.label)));
    };
    renderTiers();

    const ruleRow = (key: RuleKey, label: string, min: number, max: number) => {
      const out = h('span', null);
      const src = h('div', { class: 'omni-src' });
      const input = h('input', {
        type: 'range', min, max, step: 0.05, value: this.rules[key],
        oninput: (e: Event) => {
          this.sessionRules[key] = Number((e.target as HTMLInputElement).value);
          this.applySessionRules();
          refresh();
        },
      });
      const reset = h('button', {
        class: 'icon-btn mini',
        title: 'Remove the session override',
        onclick: () => {
          delete this.sessionRules[key];
          this.applySessionRules();
          input.value = String(this.rules[key]);
          refresh();
        },
      }, '↺');
      const refresh = () => {
        out.textContent = this.rules[key].toFixed(2);
        const layers = [`Universe ${u.rules[key].toFixed(2)}`];
        const local = s.location.rules[key];
        if (local !== undefined) layers.push(`${s.location.name} ${local.toFixed(2)}`);
        if (this.sessionRules[key] !== undefined) layers.push(`Session ${this.sessionRules[key]!.toFixed(2)}`);
        src.textContent = `${layers.join(' → ')} · using ${this.ruleSource[key]}`;
        reset.disabled = this.sessionRules[key] === undefined;
      };
      refresh();
      return h('div', null, h('label', { class: 'omni-row' }, h('span', null, label), input, out, reset), src);
    };

    const zoneSelect = h('select', null, ...u.locations.map((l) => h('option', { value: l.id, selected: l.id === s.location.id }, l.name)));
    const timeOut = h('span', null, this.timeScale.toFixed(2));

    const body = h('div', { class: 'omni-body' },
      h('div', { class: 'omni-section' }, 'Threat tier'),
      tierChips,
      tierHint,
      h('div', { class: 'omni-section' }, 'Spawn'),
      h('label', { class: 'omni-row' }, h('span', null, 'Level'),
        h('input', {
          type: 'range', min: 1, max: 60, step: 1, value: this.spawnLevel,
          oninput: (e: Event) => {
            this.spawnLevel = Number((e.target as HTMLInputElement).value);
            levelLabel.textContent = String(this.spawnLevel);
          },
        }), levelLabel),
      h('div', { class: 'omni-grid' },
        h('button', { class: 'btn', onclick: () => this.spawnMinion('grunt', this.spawnLevel, null) }, '+ Trooper'),
        h('button', { class: 'btn', onclick: () => this.spawnMinion('gunner', this.spawnLevel, null) }, '+ Gunner'),
        h('button', { class: 'btn', onclick: () => this.spawnMinion('brute', this.spawnLevel, null) }, '+ Brute'),
        h('button', { class: 'btn', onclick: () => { for (let i = 0; i < Math.round(8 * this.rules.enemyDensity); i++) this.spawnMinion(this.pickMinion(this.spawnLevel), this.spawnLevel, null); } }, '+ Wave'),
      ),
      bosses.length > 0 && h('div', { class: 'omni-row' }, bossSelect,
        h('button', {
          class: 'btn primary',
          onclick: () => {
            const c = bosses.find((b) => b.id === bossSelect.value);
            const boss = c ? this.spawnBoss(c, this.spawnLevel) : null;
            if (boss) s.hud.setBoss(boss);
          },
        }, 'Summon')),
      h('button', { class: 'btn', onclick: () => this.clearEnemies() }, 'Clear enemies'),
      h('div', { class: 'omni-section' }, 'Squad'),
      heroes.length > 0 && h('div', { class: 'omni-row' }, squadSelect,
        h('button', {
          class: 'btn primary',
          onclick: () => {
            const ch = heroes.find((c) => c.id === squadSelect.value);
            if (ch) this.addToSquad(ch);
          },
        }, 'Recruit')),
      h('div', { class: 'omni-hint' }, 'Up to 3 AI teammates. Tab switches hero, G gives orders, T fires a Team Assault.'),
      h('button', { class: 'btn', onclick: () => this.dismissSquad() }, 'Dismiss squad'),
      h('div', { class: 'omni-section' }, 'Ambient events'),
      h('label', { class: 'omni-row' },
        h('input', {
          type: 'checkbox', checked: this.ambientInSandbox,
          onchange: (e: Event) => {
            this.ambientInSandbox = (e.target as HTMLInputElement).checked;
            if (this.ambientInSandbox) this.startAmbient(null, null);
            else this.stopAmbient();
          },
        }),
        h('span', null, 'Street crime, snipers, fugitives, rifts…')),
      h('button', {
        class: 'btn',
        onclick: () => {
          if (!this.ambient) {
            this.ambientInSandbox = true;
            this.startAmbient(null, null);
            this.buildOmniPanel(s);
          }
          this.ambient?.trigger();
        },
      }, 'Trigger an event now'),
      h('div', { class: 'omni-section' }, 'Zones'),
      h('div', { class: 'omni-row' }, zoneSelect, h('button', { class: 'btn primary', onclick: () => zoneSelect.value !== s.location.id && this.travelTo(zoneSelect.value) }, 'Travel')),
      h('div', { class: 'omni-hint' }, 'Or walk through a portal at the arena edge.'),
      h('div', { class: 'omni-section' }, 'Laws of reality'),
      h('label', { class: 'omni-row' }, h('span', null, 'Time'),
        h('input', {
          type: 'range', min: 0.1, max: 2, step: 0.05, value: this.timeScale,
          oninput: (e: Event) => {
            this.timeScale = Number((e.target as HTMLInputElement).value);
            timeOut.textContent = this.timeScale.toFixed(2);
          },
        }), timeOut),
      ruleRow('gravity', 'Gravity', 0.2, 2),
      ruleRow('powerScale', 'Power', 0.5, 3),
      ruleRow('enemyDensity', 'Crowds', 0.5, 2),
      h('label', { class: 'omni-row' },
        h('input', { type: 'checkbox', checked: this.godMode, onchange: (e: Event) => (this.godMode = (e.target as HTMLInputElement).checked) }),
        h('span', null, 'Invincible')),
      h('button', { class: 'btn', onclick: () => { s.player.hp = s.player.maxHp; s.player.energy = s.player.maxEnergy; s.player.ultimate = 100; } }, 'Restore & charge ultimate'),
    );
    const wasCollapsed = panel.classList.contains('collapsed');
    const toggle = h('button', { class: 'omni-toggle', onclick: () => panel.classList.toggle('collapsed') }, '⚙ OMNI');
    panel.replaceChildren(toggle, body);
    if (wasCollapsed || window.innerWidth < 800 || window.innerHeight < 600) panel.classList.add('collapsed');
  }

  private clearEnemies() {
    const s = this.stage;
    if (!s) return;
    for (const a of [...s.combat.actors]) {
      if (a.team === 'enemy' || a.homeTeam === 'enemy' || a.summoned) {
        s.fx.flare(a.center, '#ffffff', 2, 0.3);
        s.combat.remove(a);
      }
    }
    s.hud.setBoss(null);
  }

  // --- Loop ----------------------------------------------------------------

  /** Android back button: leave photo mode, close the pause menu, or pause. Always handled. */
  handleBack(): boolean {
    if (this.photo) this.togglePhoto();
    else if (!this.run?.done) this.togglePause();
    return true;
  }

  private togglePause() {
    const s = this.stage;
    if (!s || this.run?.done) return;
    this.input.cancelTravel();
    if (this.paused) {
      this.paused = false;
      s.hud.modal('', null, []);
      return;
    }
    this.paused = true;
    s.hud.modal('Paused', h('div', { class: 'pause-help' },
      h('p', null, 'WASD / joystick — move · Space — jump (double jump)'),
      h('p', null, 'J / click — combo attack · Shift — dodge'),
      h('p', null, 'Q E R F — powers · X — ultimate'),
      h('p', null, 'V — movement power: toggle flight (Space/C rise/fall), teleport, super leap, or web swing'),
      h('p', null, 'Right-drag or arrow keys — camera · Wheel — zoom · M — mute · O — photo mode'),
      h('p', null, 'Hold V to aim your movement power, release to go'),
      this.run && h('p', null, 'Abandoning a mission leaves the world unchanged.'),
    ), [
      { label: 'Resume', primary: true, onClick: () => this.togglePause() },
      { label: '📷 Photo mode', onClick: () => this.togglePhoto() },
      { label: this.run ? 'Abandon' : 'Exit', onClick: () => this.exit() },
    ]);
  }

  private loop(now: number) {
    if (this.disposed) return;
    this.frame = requestAnimationFrame(this.loop);
    const realDt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    if (this.input.consume('pause')) this.togglePause();
    if (this.input.consume('photo')) this.togglePhoto();
    if (this.input.consume('mute')) {
      const muted = audio().toggleMute();
      this.stage?.hud.banner(muted ? 'Sound off' : 'Sound on', 'M to toggle', 0.9);
    }

    const s = this.stage;
    if (!s) return;

    // Aiming a movement power slows time, like a focus mode.
    let dt = this.paused || this.photo ? 0 : realDt * this.timeScale * (this.aiming ? 0.35 : 1);
    this.finisherCooldown -= realDt;
    this.banterCooldown -= realDt;
    this.lowHpCooldown -= realDt;
    if (!this.paused && s.player.alive && s.player.hp < s.player.maxHp * 0.3 && this.lowHpCooldown <= 0) {
      this.lowHpCooldown = 40;
      this.say('lowHp');
    }
    if (this.slowmo > 0) {
      this.slowmo -= realDt;
      dt *= 0.3;
    }
    if (this.hitstop > 0) {
      this.hitstop -= realDt;
      dt *= 0.05;
    }
    this.time += dt;

    if (!this.paused && !this.photo) {
      this.controlPlayer(s, dt);
      // Everyone outside the squad runs on enemy brains, including mind-controlled foes and summoned echoes.
      for (const a of s.combat.actors) if (a.archetype !== 'prop' && a !== s.player && !s.allies.includes(a) && !this.helpers.includes(a)) updateEnemy(a, s.combat, dt);
      const ctx: SquadContext = { order: this.order, focus: this.focusTarget, holdAt: this.holdAt };
      for (const ally of s.allies) updateAlly(ally, s.combat, dt, s.player, ctx);
      for (const helper of this.helpers) updateAlly(helper, s.combat, dt, s.player);
      this.ambient?.update(dt);
      if (!this.run) this.checkPortals(s);
      s.combat.update(dt);
      s.bosses.update(dt);
      this.updateWorld(s, dt);
      if (this.godMode) s.player.hp = s.player.maxHp;
      this.updateRun(dt);
      // Dead actors topple and sink.
      for (const a of s.combat.actors) {
        if (!a.alive && !a.model.animatesDeath) {
          a.model.root.rotation.x = Math.max(-Math.PI / 2, a.model.root.rotation.x - dt * 5);
          if (a.model.root.rotation.x <= -Math.PI / 2 + 0.01 && a.team !== 'player') a.model.root.position.y -= dt * 0.8;
        }
      }
    }
    for (const b of this.run?.beacons ?? []) b.group.rotation.y += realDt;
    for (const p of this.portals) p.group.children[0].rotation.z += realDt * 0.8;
    // The feed is DOM; refresh it a few times a second rather than every frame.
    this.feedTimer -= realDt;
    if (this.feedTimer <= 0) {
      this.feedTimer = 0.25;
      s.hud.setFeed(this.ambient?.feed() ?? []);
    }
    s.arena.update(this.time);
    this.updateMusic(s, realDt);
    const shake = s.fx.update(dt);
    this.updateCamera(s, realDt, shake);
    s.hud.update(realDt, this.camera, s.combat.actors.filter((a) => a.team === 'enemy'));

    this.renderFrame();
  }

  private renderFrame() {
    if (this.composer) this.composer.render();
    else this.renderer.render(this.scene, this.camera);
  }

  // --- Finishers, banter, photo mode -------------------------------------------------

  /** The blow that ends a boss, or the last enemy standing in a mission, plays in cinematic slow motion. */
  private maybeFinisher(s: Stage, target: Actor, killer: Actor | null) {
    if (!killer || killer.team !== 'player' || target.homeTeam !== 'enemy' || target.summoned || this.finisherCooldown > 0) return;
    const lastOne = !!this.run && !s.combat.actors.some((a) => a !== target && a.alive && a.homeTeam === 'enemy' && !a.summoned);
    if (target.archetype !== 'boss' && !lastOne) return;
    this.finisherCooldown = 6;
    this.slowmo = Math.max(this.slowmo, 1.6);
    const color = ELEMENT_COLORS[killer.skills[0]?.power.element ?? 'energy'];
    s.fx.flare(target.center, color, 3.5, 0.6);
    s.fx.ring(target.pos, '#ffffff', 6, 0.8);
    s.fx.burst(target.center, color, 50, 16, 0.2);
    audio().play('ultimate');
    s.hud.banner('Finisher!', `${killer.name} ends it`, 1.4);
    const side = Math.atan2(this.camera.position.x - target.pos.x, this.camera.position.z - target.pos.z);
    this.cine = { focus: target.center, t: 0, duration: 1.8, yaw: side };
  }

  /** A teammate says something (throttled so it never gets chatty). */
  private say(event: BanterEvent, about: Actor | null = null, speaker: Actor | null = null) {
    const s = this.stage;
    if (!s || this.banterCooldown > 0 || this.photo) return;
    const pool = [...s.allies, ...this.helpers].filter((a) => a.alive && a.character);
    const who = speaker && speaker.alive && speaker.character ? speaker : pool[Math.floor(Math.random() * pool.length)];
    if (!who || who === s.player) return;
    const target = about ?? s.player;
    const score = this.opts.bonds?.[who.character!.id] ?? 20;
    s.hud.bark(who.name, banterLine(event, score, target === who ? 'everyone' : target.name, Math.random()), who.character!.appearance.primary);
    this.banterCooldown = 7;
  }

  private togglePhoto() {
    const s = this.stage;
    if (!s) return;
    if (this.photo) {
      this.photo.bar.remove();
      this.photo.caption.remove();
      this.photo.halftone.remove();
      this.renderer.domElement.style.filter = '';
      s.hud.root.style.display = '';
      this.photo = null;
      return;
    }
    if (this.paused) this.togglePause();
    this.input.cancelTravel();
    this.hideAim();
    s.hud.root.style.display = 'none';
    const caption = h('div', { class: 'photo-caption hidden' });
    const halftone = h('div', { class: 'photo-halftone hidden' });
    const filterChips = h('div', { class: 'chips' });
    const state = { bar: h('div'), caption, halftone, filter: 'none' as PhotoFilter, text: '' };
    const setFilter = (f: PhotoFilter) => {
      state.filter = f;
      this.renderer.domElement.style.filter = PHOTO_FILTERS[f].css;
      halftone.classList.toggle('hidden', f !== 'comic');
      filterChips.replaceChildren(...(Object.keys(PHOTO_FILTERS) as PhotoFilter[]).map((k) =>
        h('button', { class: `chip${k === f ? ' active' : ''}`, onclick: () => setFilter(k) }, PHOTO_FILTERS[k].label)));
    };
    setFilter('none');
    state.bar = h('div', { class: 'photo-bar' },
      h('div', { class: 'photo-title' }, '📷 Photo mode', h('span', { class: 'muted small' }, ' · drag to orbit, wheel to zoom')),
      filterChips,
      h('input', {
        type: 'text', placeholder: 'Caption (optional)', maxLength: 80, class: 'photo-text',
        oninput: (e: Event) => {
          state.text = (e.target as HTMLInputElement).value;
          caption.textContent = state.text;
          caption.classList.toggle('hidden', !state.text);
        },
      }),
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: () => this.savePhoto() }, '⇩ Save image'),
        h('button', { class: 'btn', onclick: () => this.togglePhoto() }, 'Exit (O)'),
      ),
    );
    this.root.append(halftone, caption, state.bar);
    this.photo = state;
  }

  /** Renders the current view with the filter, halftone, and caption baked in, and downloads it. */
  private savePhoto() {
    const ph = this.photo;
    if (!ph) return;
    this.renderFrame();
    const src = this.renderer.domElement;
    const out = document.createElement('canvas');
    out.width = src.width;
    out.height = src.height;
    const ctx = out.getContext('2d');
    if (!ctx) return;
    ctx.filter = PHOTO_FILTERS[ph.filter].css === 'none' ? 'none' : PHOTO_FILTERS[ph.filter].css;
    ctx.drawImage(src, 0, 0);
    ctx.filter = 'none';
    if (ph.filter === 'comic') {
      ctx.fillStyle = 'rgba(0, 0, 0, 0.18)';
      const step = Math.max(6, Math.round(out.width / 160));
      for (let y = 0; y < out.height; y += step) {
        for (let x = (y / step) % 2 ? step / 2 : 0; x < out.width; x += step) {
          ctx.beginPath();
          ctx.arc(x, y, step * 0.22, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    if (ph.text) {
      const size = Math.round(out.width / 40);
      ctx.font = `800 ${size}px Oxanium, Rajdhani, sans-serif`;
      const w = ctx.measureText(ph.text.toUpperCase()).width + size * 1.4;
      const x = size;
      const y = size;
      ctx.fillStyle = '#ffe14a';
      ctx.strokeStyle = '#000';
      ctx.lineWidth = Math.max(3, size / 6);
      ctx.fillRect(x, y, w, size * 1.9);
      ctx.strokeRect(x, y, w, size * 1.9);
      ctx.fillStyle = '#000';
      ctx.fillText(ph.text.toUpperCase(), x + size * 0.7, y + size * 1.3);
    }
    out.toBlob((blob) => {
      if (blob) void saveFile(`omniverse-${Date.now()}.png`, blob);
    }, 'image/png');
  }

  private controlPlayer(s: Stage, dt: number) {
    const p = s.player;
    const input = this.input;
    input.keyOrbit(dt);
    const move = input.movement();
    const fwd = new THREE.Vector3(-Math.sin(this.camYaw), 0, -Math.cos(this.camYaw));
    const right = new THREE.Vector3(Math.cos(this.camYaw), 0, -Math.sin(this.camYaw));
    p.moveIntent.copy(fwd.multiplyScalar(move.y)).addScaledVector(right, move.x);
    p.flyIntent = input.held('Space') ? 1 : input.held('KeyC') || input.held('ControlLeft') ? -1 : 0;

    if (!p.alive) {
      // Drain queued presses so nothing fires on respawn.
      for (const a of ['attack', 'dodge', 'jump', 'swap', 'order', 'assault', 'ultimate', 'skill0', 'skill1', 'skill2', 'skill3'] as const) input.consume(a);
      input.cancelTravel();
      this.hideAim();
      p.moveIntent.set(0, 0, 0);
      return;
    }
    if (input.consume('jump')) {
      if (p.flying) p.vel.y = 9;
      else s.combat.jump(p);
    }
    // Tap the travel button to auto-target; hold it to aim by hand.
    const aimable = !!p.travel && p.travel.kind !== 'flight';
    this.aiming = aimable && input.travelHeld() >= AIM_HOLD;
    if (this.aiming) this.updateAim(s, p);
    const release = input.consumeTravel();
    if (release === 'tap' || (release === 'aim' && !aimable)) s.combat.travel(p);
    else if (release === 'aim' && this.aimAt) s.combat.travel(p, null, this.aimAt.point.clone());
    if (!this.aiming) this.hideAim();
    if (input.consume('swap')) this.swapHero();
    if (input.consume('order')) this.cycleOrder();
    if (input.consume('assault')) this.teamAssault();
    if (input.consume('dodge')) s.combat.dodge(p);
    if (input.consume('ultimate') && s.combat.ultimate(p)) this.slowmo = 0.5;
    for (let i = 0; i < 4; i++) if (input.consume(`skill${i}` as 'skill0')) s.combat.castPower(p, i);
    if (input.consume('attack')) s.combat.basicAttack(p);
  }

  /** Free aim: a landing marker and flight arc under the cursor (or the screen center on touch). */
  private updateAim(s: Stage, p: Actor) {
    if (!p.travel) return;
    const ndc = this.input.pointer.touch ? new THREE.Vector2(0, 0.1) : new THREE.Vector2(this.input.pointer.x, this.input.pointer.y);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    this.aimAt = aimPoint(s.arena.obstacles, p.pos, ray.ray, travelRange(p.travel));
    const color = new THREE.Color(this.aimAt.clamped ? '#ffaa3e' : ELEMENT_COLORS[p.travel.element]);
    if (!this.aimMarker) {
      const group = new THREE.Group();
      const mat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9, depthTest: false, blending: THREE.AdditiveBlending });
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1, 0.07, 6, 40), mat);
      ring.rotation.x = Math.PI / 2;
      const pillar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 3, 6), mat);
      pillar.position.y = 1.5;
      const arc = new THREE.Line(new THREE.BufferGeometry().setFromPoints(Array.from({ length: 25 }, () => new THREE.Vector3())),
        new THREE.LineDashedMaterial({ dashSize: 0.5, gapSize: 0.3, transparent: true, opacity: 0.85, depthTest: false }));
      group.add(ring, pillar, arc);
      group.renderOrder = 10;
      this.scene.add(group);
      this.aimMarker = { group, ring, arc, mat };
    }
    const m = this.aimMarker;
    m.group.visible = true;
    m.mat.color.copy(color);
    (m.arc.material as THREE.LineDashedMaterial).color.copy(color);
    m.ring.position.copy(this.aimAt.point).add(new THREE.Vector3(0, 0.08, 0));
    m.ring.scale.setScalar(1 + Math.sin(this.time * 8) * 0.12);
    m.group.children[1].position.set(this.aimAt.point.x, this.aimAt.point.y + 1.5, this.aimAt.point.z);
    // The path: an arc for leaps and swings, a straight line for blinks and portals.
    const from = p.center;
    const to = this.aimAt.point.clone().setY(this.aimAt.point.y + 0.5);
    const lift = p.travel.kind === 'leap' || p.travel.kind === 'swing' ? 3 + from.distanceTo(to) * 0.25 : 0;
    const pts = Array.from({ length: 25 }, (_, i) => {
      const t = i / 24;
      return from.clone().lerp(to, t).setY(from.y + (to.y - from.y) * t + Math.sin(t * Math.PI) * lift);
    });
    m.arc.geometry.setFromPoints(pts);
    m.arc.computeLineDistances();
    s.hud.setReticle(this.input.pointer.touch);
  }

  private hideAim() {
    if (this.aimMarker) this.aimMarker.group.visible = false;
    this.aimAt = null;
    this.stage?.hud.setReticle(false);
  }

  private updateCamera(s: Stage, dt: number, shake: THREE.Vector3) {
    const input = this.input;
    this.camYaw -= input.orbitX;
    this.camPitch = THREE.MathUtils.clamp(this.camPitch + input.orbitY, this.photo ? -0.3 : 0.05, this.photo ? 1.5 : 1.2);
    this.camDist = THREE.MathUtils.clamp(this.camDist + input.zoom * 0.8, this.photo ? 2.5 : 5, this.photo ? 32 : 18);
    input.orbitX = input.orbitY = input.zoom = 0;

    // Finisher: sweep around the final blow, then hand the camera back.
    if (this.cine) {
      const c = this.cine;
      c.t += dt;
      const k = c.t / c.duration;
      const yaw = c.yaw + k * 1.3;
      this.camera.position.set(c.focus.x + Math.sin(yaw) * 5.5, c.focus.y + 1.2 + k * 0.8, c.focus.z + Math.cos(yaw) * 5.5).add(shake);
      this.camera.position.y = Math.max(0.5, this.camera.position.y);
      this.camera.lookAt(c.focus);
      if (k >= 1) this.cine = null;
      return;
    }

    const target = s.player.center;
    this.camTarget.lerp(target, Math.min(1, dt * 10));
    const offset = new THREE.Vector3(
      Math.sin(this.camYaw) * Math.cos(this.camPitch),
      Math.sin(this.camPitch),
      Math.cos(this.camYaw) * Math.cos(this.camPitch),
    ).multiplyScalar(this.camDist);
    this.camera.position.copy(this.camTarget).add(offset).add(shake);
    this.camera.position.y = Math.max(0.5, this.camera.position.y);
    this.camera.lookAt(this.camTarget.clone().add(new THREE.Vector3(0, 0.6, 0)));
  }

  private exit() {
    this.opts.onSave();
    this.dispose();
    this.opts.onExit();
  }

  /** Plays a combat sound panned by where it is on screen and quieter with distance. */
  private playSound(name: Sfx, pos: THREE.Vector3, element?: Element) {
    const s = this.stage;
    if (!s) return;
    if (name === 'explosion' || name === 'ultimate' || name === 'thunder' || name === 'smash') this.blasts.push({ pos: pos.clone(), ttl: 1.2 });
    const local = pos.clone().applyMatrix4(this.camera.matrixWorldInverse);
    const dist = pos.distanceTo(s.player.pos);
    const gain = Math.max(0.12, Math.min(1, 1.15 - dist / 40));
    audio().play(name, { element, pan: Math.max(-0.8, Math.min(0.8, local.x / Math.max(4, -local.z))), gain });
  }

  /** Civilians react to danger and to the hero; traffic brakes for fights and heroes in the road. */
  private updateWorld(s: Stage, dt: number) {
    if (!this.crowd) return;
    this.blasts = this.blasts.filter((b) => (b.ttl -= dt) > 0);
    const threats: Threat[] = [];
    for (const a of s.combat.actors) {
      if (!a.alive || a.homeTeam !== 'enemy' || a.archetype === 'prop') continue;
      threats.push({ pos: a.pos, radius: a.archetype === 'boss' ? 20 : 12, power: 1 });
    }
    for (const b of this.blasts) threats.push({ pos: b.pos, radius: 9, power: 2 });
    const hero = s.player.alive ? s.player.pos : null;
    for (const e of this.crowd.update(dt, threats, hero)) {
      const voice = voiceOf(e.species);
      if (e.kind === 'photo') {
        s.fx.flare(e.pos, '#ffffff', 0.5, 0.12);
        this.playSound('photo', e.pos);
      } else this.playCrowd(e.kind, e.pos, voice);
    }
    this.crowdView?.update(this.crowd, this.time);
    if (this.traffic) {
      const blockers = s.combat.actors.filter((a) => a.alive && a.archetype !== 'prop').map((a) => a.pos);
      const danger = threats.map((t) => t.pos);
      for (const e of this.traffic.update(dt, this.time, blockers, danger)) this.playSound('honk', e.pos);
    }
  }

  private playCrowd(kind: 'scream' | 'cheer' | 'gasp', pos: THREE.Vector3, voice: ReturnType<typeof voiceOf>) {
    const s = this.stage;
    if (!s) return;
    const dist = pos.distanceTo(s.player.pos);
    if (dist > 45) return;
    const local = pos.clone().applyMatrix4(this.camera.matrixWorldInverse);
    audio().play(kind, { voice, gain: Math.max(0.15, 1 - dist / 45) * 0.8, pan: Math.max(-0.8, Math.min(0.8, local.x / Math.max(4, -local.z))) });
  }

  /** Music follows the action: calm when exploring, drums in a fight, a lead line for bosses. */
  private updateMusic(s: Stage, realDt: number) {
    this.musicTimer -= realDt;
    if (this.musicTimer > 0) return;
    this.musicTimer = 0.5;
    const sfx = audio();
    sfx.startMusic();
    const foes = s.combat.actors.filter((a) => a.alive && a.team === 'enemy');
    const near = (a: { pos: THREE.Vector3 }, r: number) => a.pos.distanceTo(s.player.pos) < r;
    const level: Intensity = foes.some((a) => a.archetype === 'boss' && near(a, 45)) ? 2 : foes.some((a) => near(a, 30)) ? 1 : 0;
    sfx.setIntensity(level);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    audio().stopMusic();
    cancelAnimationFrame(this.frame);
    window.removeEventListener('resize', this.onResize);
    this.teardownStage();
    this.run = null;
    this.input.dispose();
    this.composer?.dispose();
    this.renderer.dispose();
    this.root.remove();
  }
}

const ORDER_LABELS: Record<SquadOrder, string> = {
  free: 'Free fight',
  focus: 'Focus my target',
  follow: 'Follow me',
  hold: 'Hold position',
};

function phaseLabel(p: Phase, u: Universe): string {
  switch (p.kind) {
    case 'defeat':
      return `Defeat ${p.count} enemies`;
    case 'survive':
      return `Survive for ${formatTime(p.seconds)}`;
    case 'bosses':
      return `Defeat ${p.bossIds.map((id) => u.characters.find((c) => c.id === id)?.alias ?? 'the boss').join(' & ')}`;
    case 'patrol':
      return 'Respond to incidents across the area';
  }
}

function eventLabel(e: PatrolEvent, u: Universe): string {
  switch (e.kind) {
    case 'squad':
      return 'Enemy squad sighted';
    case 'rescue':
      return 'Civilians in danger';
    case 'elite':
      return `Elite: ${u.characters.find((c) => c.id === e.bossId)?.alias ?? 'Lieutenant'}`;
  }
}

function clampToArena(pos: THREE.Vector3, margin: number) {
  const r = Math.hypot(pos.x, pos.z);
  const max = ARENA_RADIUS - margin;
  if (r > max) pos.multiplyScalar(max / r);
}

function formatTime(seconds: number): string {
  const s = Math.ceil(seconds);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function wait(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Counts toward objectives: started on the enemy side (mind control doesn't hide it) and isn't a summoned echo. */
function isFoe(a: Actor): boolean {
  return a.homeTeam === 'enemy' && !a.summoned;
}

type PhotoFilter = 'none' | 'comic' | 'noir' | 'pop' | 'vintage' | 'cosmic';

const PHOTO_FILTERS: Record<PhotoFilter, { label: string; css: string }> = {
  none: { label: 'Natural', css: 'none' },
  comic: { label: 'Comic', css: 'contrast(1.35) saturate(1.6)' },
  noir: { label: 'Noir', css: 'grayscale(1) contrast(1.45) brightness(0.92)' },
  pop: { label: 'Pop', css: 'saturate(2.1) contrast(1.15)' },
  vintage: { label: 'Golden Age', css: 'sepia(0.65) contrast(1.1) saturate(0.85)' },
  cosmic: { label: 'Cosmic', css: 'hue-rotate(70deg) saturate(1.6) contrast(1.1)' },
};

/** Which synthesized voice a civilian species screams and cheers with. */
function voiceOf(species: Species): 'human' | 'alien' | 'demon' | 'spirit' {
  return species === 'alien' ? 'alien' : species === 'demon' ? 'demon' : species === 'spirit' ? 'spirit' : 'human';
}
