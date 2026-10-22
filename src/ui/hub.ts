// Multiverse Hub screens: browse and download other players' creations,
// sign in, and publish your own.

import { emptyUniverse } from '../core/generator';
import { mergeBundle, universeFromBundle, type Bundle, type BundleKind } from '../core/share';
import { saveSettings, type KeyValueStore, type Settings, type UniverseLibrary } from '../core/storage';
import { HubClient, HubError } from '../online/client';
import { normalizeTags, type ContentDetail, type ContentSummary, type ListQuery, type SortOrder } from '../online/protocol';
import { clear, h, setChildren, toast } from './dom';
import { capitalize } from './forms';
import { overlay } from './overlay';
import { BUILT_IN_HUB_URL } from '../native';

export interface HubDeps {
  root: HTMLElement;
  kv: KeyValueStore;
  library: UniverseLibrary;
  settings: Settings;
  goHome(): void;
  openUniverse(id: string): void;
}

const KIND_COLORS: Record<BundleKind, string> = {
  universe: '#3ee8ff',
  character: '#ffc23e',
  story: '#b05cff',
  item: '#3eff8b',
};

const KIND_LABELS: Record<BundleKind, string> = { universe: 'Universe', character: 'Character', story: 'Story', item: 'Item' };

export function hubClient(settings: Settings): HubClient {
  return new HubClient(settings.hubUrl.trim() || BUILT_IN_HUB_URL || './api', () => settings.hubToken || null);
}

function persist(deps: Pick<HubDeps, 'kv' | 'settings'>) {
  saveSettings(deps.kv, deps.settings);
}

function signOutLocally(deps: Pick<HubDeps, 'kv' | 'settings'>) {
  deps.settings.hubToken = '';
  deps.settings.hubHandle = '';
  persist(deps);
}

/** Opens the sign-in dialog if needed. Resolves true once the player is signed in. */
export function ensureSignedIn(deps: Pick<HubDeps, 'kv' | 'settings'>): Promise<boolean> {
  if (deps.settings.hubToken) return Promise.resolve(true);
  return new Promise((resolve) => {
    const client = hubClient(deps.settings);
    const handle = h('input', { id: 'hub-handle', type: 'text', placeholder: 'Handle', autocomplete: 'username', maxLength: 24 });
    const password = h('input', { id: 'hub-password', type: 'password', placeholder: 'Password (8+ characters)', autocomplete: 'current-password' });
    const submit = (create: boolean) => async () => {
      const res = create ? await client.register(handle.value.trim(), password.value) : await client.login(handle.value.trim(), password.value);
      deps.settings.hubToken = res.token;
      deps.settings.hubHandle = res.user.handle;
      persist(deps);
      toast(create ? `Welcome to the hub, ${res.user.handle}` : `Signed in as ${res.user.handle}`);
    };
    overlay('Multiverse Hub account', h('div', { class: 'auth-form' },
      h('p', { class: 'muted' }, 'An account lets you publish creations, like others’ work, and manage your uploads. Browsing and downloading need no account.'),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Handle'), handle),
      h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Password'), password),
    ), [
      { label: 'Create account', onClick: submit(true) },
      { label: 'Sign in', primary: true, onClick: submit(false) },
    ], { onClose: () => resolve(!!deps.settings.hubToken) });
  });
}

// --- Browse ------------------------------------------------------------------

export function showHub(deps: HubDeps) {
  clear(deps.root);
  const client = hubClient(deps.settings);
  const state: { kind: BundleKind | ''; q: string; sort: SortOrder; mine: boolean; page: number; myId: string | null } = {
    kind: '', q: '', sort: 'new', mine: false, page: 1, myId: null,
  };
  const grid = h('div', { class: 'hub-grid' });
  const status = h('div', { class: 'hub-status' });
  const pager = h('div', { class: 'row center hub-pager' });
  const account = h('div', { class: 'row' });
  const kindChips = h('div', { class: 'chips' });
  let searchTimer = 0;

  const renderAccount = () => {
    setChildren(account,
      deps.settings.hubHandle
        ? h('span', { class: 'muted small' }, `@${deps.settings.hubHandle}`)
        : h('button', { class: 'btn small', onclick: async () => (await ensureSignedIn(deps)) && (renderAccount(), load()) }, 'Sign in'),
      deps.settings.hubHandle && h('button', {
        class: 'btn small',
        onclick: async () => {
          await client.logout().catch(() => {});
          signOutLocally(deps);
          state.mine = false;
          renderAccount();
          renderKinds();
          void load();
        },
      }, 'Sign out'),
      deps.settings.hubHandle && h('button', {
        class: 'btn small danger',
        onclick: () => {
          const pw = h('input', { type: 'password', placeholder: 'Password', autocomplete: 'current-password' });
          overlay('Delete account', h('div', null,
            h('p', null, `This permanently deletes @${deps.settings.hubHandle}, everything you've published, and your likes and reports. Your universes on this device are not affected.`),
            h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Confirm with your password'), pw),
          ), [
            { label: 'Cancel', onClick: () => {} },
            {
              label: 'Delete forever',
              danger: true,
              onClick: async () => {
                await client.deleteAccount(pw.value);
                signOutLocally(deps);
                state.mine = false;
                toast('Your account was deleted.');
                renderAccount();
                renderKinds();
                void load();
              },
            },
          ]);
        },
      }, 'Delete account'),
    );
  };

  const renderKinds = () => {
    const opts: { value: BundleKind | ''; label: string }[] = [
      { value: '', label: 'All' },
      { value: 'universe', label: 'Universes' },
      { value: 'character', label: 'Characters' },
      { value: 'story', label: 'Stories' },
      { value: 'item', label: 'Items' },
    ];
    setChildren(kindChips,
      ...opts.map((o) => h('button', { class: `chip${state.kind === o.value && !state.mine ? ' active' : ''}`, onclick: () => ((state.kind = o.value), (state.mine = false), (state.page = 1), renderKinds(), void load()) }, o.label)),
      deps.settings.hubHandle && h('button', {
        class: `chip${state.mine ? ' active' : ''}`,
        onclick: async () => {
          state.mine = !state.mine;
          state.page = 1;
          renderKinds();
          void load();
        },
      }, 'My uploads'),
    );
  };

  async function load() {
    status.textContent = 'Loading…';
    status.className = 'hub-status';
    try {
      if (state.mine && !state.myId) state.myId = (await client.me()).id;
      const query: ListQuery = { sort: state.sort, page: state.page, q: state.q || undefined, kind: state.kind || undefined, author: state.mine ? state.myId ?? undefined : undefined };
      const res = await client.list(query);
      grid.replaceChildren(...res.items.map((item) => card(item)));
      status.textContent = res.total ? '' : state.q ? `Nothing matches “${state.q}”.` : state.mine ? 'You haven’t published anything yet. Use Publish next to any Export button in the creator.' : 'Nothing here yet. Be the first to publish!';
      const pages = Math.ceil(res.total / res.pageSize);
      setChildren(pager,
        pages > 1 && h('button', { class: 'btn small', disabled: state.page <= 1, onclick: () => (state.page--, void load()) }, '‹ Prev'),
        pages > 1 && h('span', { class: 'muted small' }, `Page ${state.page} of ${pages}`),
        pages > 1 && h('button', { class: 'btn small', disabled: state.page >= pages, onclick: () => (state.page++, void load()) }, 'Next ›'),
      );
    } catch (e) {
      if (e instanceof HubError && e.status === 401) {
        signOutLocally(deps);
        renderAccount();
        state.mine = false;
        renderKinds();
      }
      grid.replaceChildren();
      pager.replaceChildren();
      status.className = 'hub-status error';
      status.textContent = e instanceof Error ? e.message : 'Could not load the hub.';
    }
  }

  const card = (item: ContentSummary) =>
    h('button', { class: 'hub-card', style: `--c:${KIND_COLORS[item.kind]}; --a:${item.preview.accent}`, onclick: () => void openDetail(deps, item.id, () => void load()) },
      h('div', { class: 'hub-card-top' },
        h('span', { class: 'hub-kind' }, KIND_LABELS[item.kind]),
        item.version > 1 && h('span', { class: 'muted small' }, `v${item.version}`),
      ),
      h('div', { class: 'hub-card-name' }, item.name),
      h('div', { class: 'muted small' }, `by @${item.author.handle}`),
      item.description && h('div', { class: 'hub-card-desc' }, item.description),
      item.preview.characters.length > 0 && h('div', { class: 'hub-faces' },
        ...item.preview.characters.slice(0, 5).map((c) => h('span', { class: 'hub-face', title: `${c.alias} · ${c.role}`, style: `--p:${c.primary}; --a:${c.accent}` }, c.alias.slice(0, 1))),
      ),
      h('div', { class: 'hub-card-foot' },
        h('span', null, contentsLine(item)),
        h('span', { class: item.liked ? 'liked' : '' }, `♥ ${item.likes}`),
        h('span', null, `⇩ ${item.downloads}`),
      ),
    );

  const search = h('input', {
    id: 'hub-search',
    type: 'search',
    placeholder: 'Search names, heroes, tags, creators…',
    oninput: (e: Event) => {
      window.clearTimeout(searchTimer);
      searchTimer = window.setTimeout(() => {
        state.q = (e.target as HTMLInputElement).value.trim();
        state.page = 1;
        void load();
      }, 300);
    },
  });
  const sort = h('select', { id: 'hub-sort', onchange: (e: Event) => ((state.sort = (e.target as HTMLSelectElement).value as SortOrder), (state.page = 1), void load()) },
    h('option', { value: 'new' }, 'Newest'),
    h('option', { value: 'top' }, 'Top rated'),
    h('option', { value: 'downloads' }, 'Most downloaded'),
  );

  deps.root.append(
    h('div', { class: 'hub' },
      h('header', { class: 'topbar' },
        h('button', { class: 'icon-btn', title: 'Back to your multiverse', onclick: deps.goHome }, '←'),
        h('div', { class: 'topbar-name' }, 'Multiverse Hub'),
        h('div', { class: 'spacer' }),
        account,
      ),
      h('main', { class: 'hub-main' },
        h('div', { class: 'hub-intro' },
          h('h1', null, 'Multiverse Hub'),
          h('p', { class: 'muted' }, 'Universes, heroes, villains, stories, and gear forged by other players. Download anything into your own multiverse.'),
        ),
        h('div', { class: 'hub-toolbar' }, kindChips, h('div', { class: 'hub-search' }, search, sort)),
        status,
        grid,
        pager,
      ),
    ),
  );
  renderAccount();
  renderKinds();
  void load();
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function contentsLine(item: ContentSummary): string {
  const c = item.preview.counts;
  const parts: string[] = [];
  if (c.characters) parts.push(plural(c.characters, 'character'));
  if (c.stories) parts.push(plural(c.stories, 'story', 'stories'));
  if (item.kind === 'universe' && c.locations) parts.push(plural(c.locations, 'location'));
  if (item.kind === 'item' || (!parts.length && c.items)) parts.push(plural(c.items, 'item'));
  return parts.slice(0, 2).join(' · ');
}

// --- Detail & download -----------------------------------------------------------

async function openDetail(deps: HubDeps, id: string, refresh: () => void) {
  const client = hubClient(deps.settings);
  let detail: ContentDetail;
  try {
    detail = await client.get(id);
  } catch (e) {
    toast(e instanceof Error ? e.message : 'Could not open that listing.', 'error');
    return;
  }
  const u = detail.bundle.payload;
  const isMine = deps.settings.hubHandle && detail.author.handle.toLowerCase() === deps.settings.hubHandle.toLowerCase();
  const library = deps.library.list();
  const target = h('select', { id: 'hub-target' },
    h('option', { value: '' }, '+ A new universe'),
    ...library.map((s) => h('option', { value: s.id }, s.name)),
  );

  const install = async () => {
    let universeId: string;
    if (detail.kind === 'universe') {
      const copy = universeFromBundle(detail.bundle);
      deps.library.save(copy);
      universeId = copy.id;
    } else {
      const dest = (target.value && deps.library.load(target.value)) || emptyUniverse(`${detail.name}'s Universe`);
      mergeBundle(dest, detail.bundle);
      deps.library.save(dest);
      universeId = dest.id;
    }
    await client.countDownload(id).catch(() => {});
    toast(`Added “${detail.name}” to your multiverse`);
    refresh();
    overlay('Downloaded', h('p', null, `“${detail.name}” is in your multiverse now.`), [
      { label: 'Keep browsing', onClick: () => {} },
      { label: 'Open it', primary: true, onClick: () => deps.openUniverse(universeId) },
    ]);
  };

  const body = h('div', { class: 'hub-detail', style: `--c:${KIND_COLORS[detail.kind]}` },
    h('div', { class: 'hub-kind' }, `${KIND_LABELS[detail.kind]} · v${detail.version}`),
    h('div', { class: 'muted' }, `by @${detail.author.handle} · ♥ ${detail.likes} · ⇩ ${detail.downloads} · updated ${new Date(detail.updatedAt).toLocaleDateString()}`),
    detail.description && h('p', null, detail.description),
    detail.tags.length > 0 && h('div', { class: 'tags' }, ...detail.tags.map((t) => h('span', { class: 'tag', style: '--c:var(--line)' }, `#${t}`))),
    u.characters.length > 0 && h('div', null,
      h('div', { class: 'field-label' }, 'Characters'),
      h('div', { class: 'hub-roster' }, ...u.characters.slice(0, 24).map((c) =>
        h('div', { class: 'hub-roster-row', style: `--p:${c.appearance.primary}; --a:${c.appearance.accent}` },
          h('span', { class: 'hub-face' }, c.alias.slice(0, 1)),
          h('span', null, h('b', null, c.alias), h('span', { class: 'muted small' }, ` ${capitalize(c.role)} · Lv ${c.level} · ${c.powers.length} powers`)),
        ))),
    ),
    u.stories.length > 0 && h('div', null,
      h('div', { class: 'field-label' }, 'Stories'),
      ...u.stories.map((s) => h('div', null, h('b', null, s.title), h('span', { class: 'muted small' }, ` · ${s.chapters.length} chapters`))),
    ),
    u.items.length > 0 && h('div', null,
      h('div', { class: 'field-label' }, 'Items'),
      h('div', { class: 'muted' }, u.items.map((i) => `${i.name} (${i.rarity})`).join(', ')),
    ),
    detail.kind !== 'universe' && h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Add to'), target),
  );

  overlay(detail.name, body, [
    ...(isMine
      ? [{
          label: 'Delete listing',
          danger: true,
          onClick: async () => {
            await client.remove(id);
            toast('Listing deleted');
            refresh();
          },
        }]
      : deps.settings.hubToken
        ? [{
            label: 'Report',
            onClick: async () => {
              await client.report(id);
              toast('Thanks. A listing with several reports is hidden for review.');
            },
          }]
        : []),
    {
      label: detail.liked ? '♥ Liked' : '♡ Like',
      onClick: async (button) => {
        if (await ensureSignedIn(deps)) {
          const r = await hubClient(deps.settings).like(id);
          button.textContent = r.liked ? '♥ Liked' : '♡ Like';
          toast(r.liked ? 'Liked' : 'Like removed');
          refresh();
        }
        return false;
      },
    },
    { label: detail.kind === 'universe' ? 'Download universe' : 'Download', primary: true, onClick: install },
  ], { wide: true });
}

// --- Publish -----------------------------------------------------------------

/** Publish a bundle as a new listing, or as a new version of one of your listings. */
export async function openPublishDialog(deps: Pick<HubDeps, 'kv' | 'settings'>, bundle: Bundle) {
  if (!(await ensureSignedIn(deps))) return;
  const client = hubClient(deps.settings);
  let mine: ContentSummary[] = [];
  try {
    const me = await client.me();
    mine = (await client.list({ author: me.id, kind: bundle.kind })).items;
  } catch (e) {
    if (e instanceof HubError && e.status === 401) {
      signOutLocally(deps);
      toast('Your hub session expired. Sign in again.', 'error');
    } else toast(e instanceof Error ? e.message : 'Could not reach the hub.', 'error');
    return;
  }
  const description = h('textarea', { id: 'publish-description', rows: 4, maxLength: 600, placeholder: 'What makes it special? Who are the heroes? What should players try first?' });
  const tags = h('input', { id: 'publish-tags', type: 'text', placeholder: 'e.g. cosmic, dark, beginner-friendly' });
  const sameName = mine.find((m) => m.name === bundle.name);
  const mode = h('select', { id: 'publish-mode' },
    h('option', { value: '' }, 'Publish as a new listing'),
    ...mine.map((m) => h('option', { value: m.id, selected: m === sameName }, `Update “${m.name}” (v${m.version} → v${m.version + 1})`)),
  );
  const counts = bundle.payload;
  overlay(`Publish ${bundle.kind}: ${bundle.name}`, h('div', { class: 'auth-form' },
    h('p', { class: 'muted' }, `Publishing shares a copy as @${deps.settings.hubHandle}: ${[
      plural(counts.characters.length, 'character'),
      plural(counts.stories.length, 'story', 'stories'),
      plural(counts.items.length, 'item'),
      plural(counts.locations.length, 'location'),
    ].join(', ')}. Your campaign progress stays private.`),
    mine.length > 0 && h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Listing'), mode),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Description'), description),
    h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Tags'), tags, h('span', { class: 'field-hint' }, 'Up to 6, separated by commas.')),
  ), [
    {
      label: 'Publish',
      primary: true,
      onClick: async () => {
        const req = { bundle, description: description.value.trim(), tags: normalizeTags(tags.value.split(',')) };
        const res = mode.value ? await client.update(mode.value, req) : await client.publish(req);
        toast(res.version > 1 ? `Published version ${res.version} of “${res.name}”` : `Published “${res.name}” to the Multiverse Hub`);
      },
    },
  ]);
}
