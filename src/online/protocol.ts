// Multiverse Hub API contract, shared by the game client and the hub server.

import type { Bundle, BundleKind } from '../core/share';
import type { Role } from '../core/types';

export const HUB_API_VERSION = 1;

export interface HubUser {
  id: string;
  handle: string;
  createdAt: number;
}

export interface AuthResponse {
  token: string;
  user: HubUser;
}

/** A small peek at what's inside a bundle, for cards and detail pages. */
export interface ContentPreview {
  accent: string;
  characters: { alias: string; role: Role; primary: string; accent: string; level: number }[];
  counts: { characters: number; stories: number; items: number; locations: number; factions: number };
}

export interface ContentSummary {
  id: string;
  kind: BundleKind;
  name: string;
  description: string;
  tags: string[];
  author: { id: string; handle: string };
  version: number;
  downloads: number;
  likes: number;
  /** Whether the signed-in user liked it (false when signed out). */
  liked: boolean;
  preview: ContentPreview;
  createdAt: number;
  updatedAt: number;
}

export interface ContentDetail extends ContentSummary {
  bundle: Bundle;
}

export type SortOrder = 'new' | 'top' | 'downloads';

export interface ListQuery {
  kind?: BundleKind;
  q?: string;
  sort?: SortOrder;
  author?: string;
  page?: number;
}

export interface ListResponse {
  items: ContentSummary[];
  page: number;
  pageSize: number;
  total: number;
}

export interface PublishRequest {
  bundle: Bundle;
  description: string;
  tags: string[];
}

export interface ApiError {
  error: string;
}

export const LIMITS = {
  handle: /^[A-Za-z0-9_-]{3,24}$/,
  passwordMin: 8,
  description: 600,
  tags: 6,
  tag: /^[a-z0-9-]{1,20}$/,
  /** Max request body in bytes (a large universe is well under this). */
  body: 2_000_000,
  pageSize: 24,
  /** Content with this many reports is hidden pending review. */
  reportsToHide: 3,
} as const;

export function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const tags = raw
    .filter((t): t is string => typeof t === 'string')
    .map((t) => t.trim().toLowerCase().replace(/\s+/g, '-'))
    .filter((t) => LIMITS.tag.test(t));
  return [...new Set(tags)].slice(0, LIMITS.tags);
}
