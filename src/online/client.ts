// Browser client for the Multiverse Hub API.

import { parseBundle } from '../core/share';
import type {
  AuthResponse, ContentDetail, ContentSummary, HubUser, ListQuery, ListResponse, PublishRequest,
} from './protocol';

export class HubError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export class HubClient {
  /**
   * @param base API root, e.g. "/api" (same origin, the default) or
   *             "https://hub.example.com/api".
   */
  constructor(
    private readonly base: string,
    private readonly getToken: () => string | null,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    const token = this.getToken();
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let res: Response;
    try {
      res = await fetch(`${this.base.replace(/\/$/, '')}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new HubError(0, `Can't reach the hub at ${this.base}. Check your connection or the hub address in Settings.`);
    }
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new HubError(res.status, data.error ?? `The hub returned an error (${res.status}).`);
    return data as T;
  }

  health() {
    return this.call<{ ok: boolean; version: number }>('GET', '/health');
  }

  register(handle: string, password: string) {
    return this.call<AuthResponse>('POST', '/auth/register', { handle, password });
  }

  login(handle: string, password: string) {
    return this.call<AuthResponse>('POST', '/auth/login', { handle, password });
  }

  /** Permanently deletes the signed-in account and everything it published. */
  deleteAccount(password: string) {
    return this.call<{ ok: boolean }>('DELETE', '/me', { password });
  }

  logout() {
    return this.call<{ ok: boolean }>('POST', '/auth/logout');
  }

  me() {
    return this.call<HubUser>('GET', '/me');
  }

  list(q: ListQuery = {}) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') params.set(k, String(v));
    return this.call<ListResponse>('GET', `/content?${params}`);
  }

  /** Fetches a listing; its bundle is re-validated locally before anything uses it. */
  async get(id: string): Promise<ContentDetail> {
    const detail = await this.call<ContentDetail>('GET', `/content/${encodeURIComponent(id)}`);
    return { ...detail, bundle: parseBundle(JSON.stringify(detail.bundle)) };
  }

  publish(req: PublishRequest) {
    return this.call<ContentSummary>('POST', '/content', req);
  }

  update(id: string, req: PublishRequest) {
    return this.call<ContentSummary>('PUT', `/content/${encodeURIComponent(id)}`, req);
  }

  remove(id: string) {
    return this.call<{ ok: boolean }>('DELETE', `/content/${encodeURIComponent(id)}`);
  }

  countDownload(id: string) {
    return this.call<{ downloads: number }>('POST', `/content/${encodeURIComponent(id)}/download`);
  }

  like(id: string) {
    return this.call<{ liked: boolean; likes: number }>('POST', `/content/${encodeURIComponent(id)}/like`);
  }

  report(id: string) {
    return this.call<{ ok: boolean }>('POST', `/content/${encodeURIComponent(id)}/report`);
  }
}
