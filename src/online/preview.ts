import type { Bundle } from '../core/share';
import type { ContentPreview } from './protocol';

/** Summarizes a bundle's contents for hub cards without shipping the whole thing. */
export function previewBundle(bundle: Bundle): ContentPreview {
  const u = bundle.payload;
  return {
    accent: u.characters[0]?.appearance.accent ?? u.accent,
    characters: u.characters.slice(0, 6).map((c) => ({
      alias: c.alias,
      role: c.role,
      primary: c.appearance.primary,
      accent: c.appearance.accent,
      level: c.level,
    })),
    counts: {
      characters: u.characters.length,
      stories: u.stories.length,
      items: u.items.length,
      locations: u.locations.length,
      factions: u.factions.length,
    },
  };
}
