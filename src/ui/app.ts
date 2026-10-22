// Top-level screens: Home (universe library), Editor (The One Above All),
// and the running game session.

import { emptyUniverse, generateUniverse } from '../core/generator';
import { legendsUniverse } from '../core/roster';
import { randomSeed } from '../core/rng';
import { BundleError, bundleUniverse, parseBundle, universeFromBundle, type Bundle } from '../core/share';
import { UniverseLibrary, loadSettings, saveSettings, type KeyValueStore, type Settings } from '../core/storage';
import type { Universe } from '../core/types';
import { bossOptions, planMission, resolveMission, type Mission, type NewsItem } from '../core/campaign';
import { nextChapterIndex, planChapter, type MissionPlan, type MissionResult } from '../core/missions';
import { GameSession, type SessionOptions } from '../game/session';
import type { EditorContext } from './context';
import { checkbox } from './forms';
import { openPublishDialog, showHub } from './hub';
import { clear, downloadText, h, pickFile, slug, toast } from './dom';
import { modelLibrary } from '../game/models';
import { getPreview } from './preview';
import { charactersTab } from './tabs/characters';
import { itemsTab } from './tabs/items';
import { overviewTab } from './tabs/overview';
import { playTab } from './tabs/play';
import { storiesTab } from './tabs/stories';
import { factionsTab, locationsTab } from './tabs/world';

export const GAME_TITLE = 'Omniverse Forge';

const TABS: { id: string; label: string; icon: string; render: (ctx: EditorContext) => HTMLElement }[] = [
  { id: 'overview', label: 'Universe', icon: '◎', render: overviewTab },
  { id: 'characters', label: 'Characters', icon: '♞', render: charactersTab },
  { id: 'stories', label: 'Stories', icon: '✎', render: storiesTab },
  { id: 'locations', label: 'Locations', icon: '⌂', render: locationsTab },
  { id: 'items', label: 'Items', icon: '◆', render: itemsTab },
  { id: 'factions', label: 'Factions', icon: '⚑', render: factionsTab },
  { id: 'play', label: 'War Table', icon: '▶', render: playTab },
];

export class App {
  private readonly library: UniverseLibrary;
  private settings: Settings;
  private session: GameSession | null = null;
  private saveTimer = 0;
  private pendingReport: { title: string; victory: boolean; news: NewsItem[] } | null = null;

  constructor(private readonly root: HTMLElement, private readonly kv: KeyValueStore) {
    this.library = new UniverseLibrary(kv);
    this.settings = loadSettings(kv);
  }

  start() {
    this.showHome();
  }

  private persistSettings() {
    saveSettings(this.kv, this.settings);
  }

  private exportBundle(bundle: Bundle | null) {
    if (!bundle) return;
    downloadText(`${slug(bundle.name)}.${bundle.kind}.json`, JSON.stringify(bundle, null, 2));
    toast(`Exported ${bundle.kind} “${bundle.name}”`);
  }

  // --- Home ----------------------------------------------------------------

  showHome() {
    getPreview().stop();
    clear(this.root);
    const universes = this.library.list();

    const create = (u: Universe) => {
      if (!u.author) u.author = this.settings.author;
      this.library.save(u);
      this.showEditor(u.id);
    };

    const importUniverse = async () => {
      const text = await pickFile();
      if (!text) return;
      try {
        const bundle = parseBundle(text);
        if (bundle.kind !== 'universe') {
          toast(`That's a ${bundle.kind}. Open a universe and import it from the Universe tab.`, 'error');
          return;
        }
        const u = universeFromBundle(bundle);
        this.library.save(u);
        toast(`Imported “${u.name}”`);
        this.showHome();
      } catch (e) {
        toast(e instanceof BundleError ? e.message : 'Import failed.', 'error');
      }
    };

    this.root.append(
      h('div', { class: 'home' },
        h('div', { class: 'home-bg' }),
        h('header', { class: 'home-hero' },
          h('div', { class: 'home-kicker' }, 'You are the One Above All'),
          h('h1', { class: 'home-title' }, GAME_TITLE),
          h('p', { class: 'home-sub' }, 'Forge universes. Create legends. Then step inside and fight as them.'),
          h('div', { class: 'row center wrap' },
            h('button', { class: 'btn primary big', onclick: () => create(generateUniverse(randomSeed())) }, '⚡ Instant Universe'),
            h('button', { class: 'btn big', onclick: () => create(legendsUniverse()) }, '★ Legends Universe'),
            h('button', { class: 'btn big', onclick: () => create(emptyUniverse()) }, '✦ Blank Universe'),
            h('button', { class: 'btn big', onclick: importUniverse }, '⇪ Import'),
          ),
          h('p', { class: 'muted small' }, 'Instant rolls a random universe in one click. Legends starts you with twelve hand-made heroes and villains and their story. Blank gives you total control.'),
        ),
        h('section', { class: 'library' },
          h('h2', { class: 'panel-title' }, 'Your Multiverse'),
          universes.length === 0
            ? h('p', { class: 'muted' }, 'No universes yet. Create your first one above.')
            : h('div', { class: 'universe-grid' },
                ...universes.map((s) =>
                  h('div', { class: 'universe-card', style: `--c:${s.accent}` },
                    h('button', { class: 'universe-open', onclick: () => this.showEditor(s.id) },
                      h('div', { class: 'universe-name' }, s.name),
                      h('div', { class: 'universe-tagline' }, s.tagline || '—'),
                      h('div', { class: 'universe-meta' }, `${s.characterCount} characters · ${s.storyCount} stories · ${new Date(s.updatedAt).toLocaleDateString()}`),
                    ),
                    h('div', { class: 'universe-actions' },
                      h('button', {
                        class: 'icon-btn',
                        title: 'Export',
                        onclick: () => {
                          const u = this.library.load(s.id);
                          if (u) this.exportBundle(bundleUniverse(u));
                        },
                      }, '⇩'),
                      h('button', {
                        class: 'icon-btn',
                        title: 'Delete',
                        onclick: () => {
                          if (!confirm(`Delete “${s.name}” forever?`)) return;
                          this.library.remove(s.id);
                          this.showHome();
                        },
                      }, '✕'),
                    ),
                  ),
                ),
              ),
        ),
        h('section', { class: 'library hub-cta' },
          h('div', null,
            h('h2', { class: 'panel-title' }, 'Multiverse Hub'),
            h('p', { class: 'muted' }, 'Browse universes, heroes, villains, stories, and gear made by other players, and share your own.'),
          ),
          h('button', { class: 'btn primary big', onclick: () => this.showHub() }, 'Enter the Hub'),
        ),
        h('section', { class: 'library' },
          h('h2', { class: 'panel-title' }, 'Settings'),
          checkbox(() => this.settings.bloom, (v) => ((this.settings.bloom = v), this.persistSettings()), 'Glow effects (turn off on slower devices)'),
          h('label', { class: 'field hub-url' },
            h('span', { class: 'field-label' }, 'Hub server'),
            h('input', {
              id: 'hub-url',
              type: 'text',
              value: this.settings.hubUrl,
              placeholder: 'This site (leave blank), or e.g. https://hub.example.com/api',
              onchange: (e: Event) => {
                this.settings.hubUrl = (e.target as HTMLInputElement).value.trim();
                // A session belongs to one server.
                this.settings.hubToken = '';
                this.settings.hubHandle = '';
                this.persistSettings();
                toast('Hub server updated');
              },
            }),
          ),
        ),
      ),
    );
  }

  showHub() {
    getPreview().stop();
    showHub({
      root: this.root,
      kv: this.kv,
      library: this.library,
      settings: this.settings,
      goHome: () => this.showHome(),
      openUniverse: (id) => this.showEditor(id),
    });
  }

  // --- Editor --------------------------------------------------------------

  showEditor(universeId: string, initialTab = 'overview') {
    const universe = this.library.load(universeId);
    if (!universe) {
      toast('Could not load that universe.', 'error');
      return this.showHome();
    }
    clear(this.root);
    let tab = initialTab;
    const content = h('main', { class: 'editor-content' });
    const nav = h('nav', { class: 'tabs' });
    const nameEl = h('div', { class: 'topbar-name' });
    const savedEl = h('span', { class: 'saved' });

    const flush = () => {
      window.clearTimeout(this.saveTimer);
      this.library.save(universe);
      savedEl.textContent = 'Saved';
    };

    const campaign = this.library.loadCampaign(universe);
    const report = this.pendingReport;
    this.pendingReport = null;

    const ctx: EditorContext = {
      universe,
      campaign,
      report,
      saveCampaign: () => {
        flush();
        this.library.saveCampaign(ctx.campaign);
      },
      resetCampaign: () => {
        this.library.removeCampaign(universe.id);
        ctx.campaign = this.library.loadCampaign(universe);
        this.library.saveCampaign(ctx.campaign);
      },
      settings: this.settings,
      get quick() {
        return this.settings.detail === 'quick';
      },
      changed: () => {
        nameEl.textContent = universe.name || 'Untitled Universe';
        savedEl.textContent = 'Saving…';
        window.clearTimeout(this.saveTimer);
        this.saveTimer = window.setTimeout(flush, 400);
      },
      rerender: () => render(),
      selection: {},
      playSandbox: (locationId, characterId) => {
        flush();
        this.startSession(universe, characterId, { plan: null, sandboxLocationId: locationId }, 'characters');
      },
      playStory: (storyId, chapter, characterId) => {
        flush();
        const story = universe.stories.find((s) => s.id === storyId);
        if (!story?.chapters[chapter]) return;
        // Test play keeps its own flags so branching can be tried without touching the campaign.
        const flags: Record<string, string> = {};
        let index = chapter;
        this.startSession(universe, characterId, {
          plan: planChapter(universe, story, index),
          onFinish: (r: MissionResult): MissionPlan | null => {
            if (!r.victory) return null;
            const choice = story.chapters[index].choice;
            if (choice && r.choice !== null && choice.options[r.choice]) flags[choice.flag] = choice.options[r.choice].value;
            const next = nextChapterIndex(story, index + 1, flags);
            if (next === null) return null;
            index = next;
            return planChapter(universe, story, index);
          },
        }, 'stories');
      },
      playMission: (mission: Mission, heroId: string, squadIds: string[]) => {
        flush();
        const c = ctx.campaign;
        this.library.saveCampaign(c);
        this.startSession(universe, heroId, {
          plan: planMission(c, universe, mission, heroId, squadIds),
          bossOptions: (bossId) => bossOptions(c, universe, bossId),
          onFinish: (r) => {
            const news = resolveMission(c, universe, mission, r, heroId);
            this.library.save(universe);
            this.library.saveCampaign(c);
            this.pendingReport = { title: mission.title, victory: r.victory, news };
            return null;
          },
        }, 'play');
      },
      exportBundle: (b) => this.exportBundle(b),
      publishBundle: (b) => {
        flush();
        if (b) void openPublishDialog({ kv: this.kv, settings: this.settings }, b);
      },
      openTab: (id) => {
        tab = id;
        render();
      },
    };

    const detailToggle = h('div', { class: 'detail-toggle', title: 'How much detail do you want to edit?' },
      ...(['quick', 'full'] as const).map((d) =>
        h('button', {
          class: `chip${this.settings.detail === d ? ' active' : ''}`,
          onclick: () => {
            this.settings.detail = d;
            this.persistSettings();
            detailToggle.querySelectorAll('.chip').forEach((el, i) => el.classList.toggle('active', (i === 0) === (d === 'quick')));
            render();
          },
        }, d === 'quick' ? 'Quick' : 'Full detail'),
      ),
    );

    const render = () => {
      const scroll = content.scrollTop;
      nav.replaceChildren(
        ...TABS.map((t) =>
          h('button', { class: `tab${t.id === tab ? ' active' : ''}${t.id === 'play' ? ' tab-play' : ''}`, onclick: () => ctx.openTab(t.id) },
            h('span', { class: 'tab-icon' }, t.icon), h('span', { class: 'tab-label' }, t.label)),
        ),
      );
      const def = TABS.find((t) => t.id === tab) ?? TABS[0];
      content.replaceChildren(def.render(ctx));
      content.scrollTop = scroll;
    };

    nameEl.textContent = universe.name;
    this.root.append(
      h('div', { class: 'editor-shell', style: `--accent:${universe.accent}` },
        h('header', { class: 'topbar' },
          h('button', { class: 'icon-btn', title: 'Back to multiverse', onclick: () => (flush(), this.showHome()) }, '←'),
          nameEl,
          savedEl,
          h('div', { class: 'spacer' }),
          detailToggle,
        ),
        nav,
        content,
      ),
    );
    render();
  }

  // --- Game ----------------------------------------------------------------

  private startSession(
    universe: Universe,
    characterId: string,
    mission: Pick<SessionOptions, 'plan' | 'sandboxLocationId' | 'bossOptions' | 'onFinish'>,
    returnTab: string,
  ) {
    getPreview().stop();
    this.session?.dispose();
    // Imported models load before the fight so actors can use them right away.
    const pending = universe.characters.some((c) => c.appearance.model && !modelLibrary.isReady(c.appearance.model));
    if (pending) {
      clear(this.root);
      this.root.append(h('div', { class: 'loading-screen' }, h('div', { class: 'spinner' }), h('p', null, 'Loading 3D models…')));
      void modelLibrary.preloadUniverse(universe).then((failed) => {
        if (failed.length) toast(`Couldn't load the 3D model for ${failed.join(', ')}; using the built-in body instead.`, 'error');
        this.launch(universe, characterId, mission, returnTab);
      });
      return;
    }
    this.launch(universe, characterId, mission, returnTab);
  }

  private launch(
    universe: Universe,
    characterId: string,
    mission: Pick<SessionOptions, 'plan' | 'sandboxLocationId' | 'bossOptions' | 'onFinish'>,
    returnTab: string,
  ) {
    clear(this.root);
    try {
      this.session = new GameSession({
        container: this.root,
        universe,
        characterId,
        ...mission,
        bloom: this.settings.bloom,
        onSave: () => this.library.save(universe),
        onExit: () => {
          this.session = null;
          this.showEditor(universe.id, returnTab);
        },
      });
    } catch (e) {
      console.error(e);
      toast('Could not start the game (WebGL unavailable?)', 'error');
      this.showEditor(universe.id, returnTab);
    }
  }
}
