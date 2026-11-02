/**
 * The link between a built app's "Change this app" button (change-button.ts) and aios-core (S5).
 *
 * A built app is a file:// page in its own Chromium window. Its policy lets it reach exactly
 * one place on the network, http://127.0.0.1:<port>/app-link/, and only two things are there:
 *
 * - change: the user's words about what should change. This only posts a Change card in the
 *   chat, the same card build_app shows; the build runs from a click on that card in AI OS,
 *   never from the app. The app's own code shares the page with the button, so whatever comes
 *   from it is treated as coming from the app: it's shown on the card for the user to read.
 *   It never reaches the chat model, memory or config.
 * - status: where the card it posted is (waiting, running, done), so the app can reload itself.
 *
 * Each request carries the app's slug and a token (an HMAC of the slug with a key kept in AI OS's
 * data folder), so other pages, which don't know the token, can't post cards; and the token
 * only ever names that app, so one app can't ask to change another. Requests are rate limited,
 * one card per app waits at a time, and each change request is audited (its length, never its
 * words).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { AuditLog } from '../audit.js';
import { APP_SLUG } from './builder.js';

export const MAX_REQUEST_CHARS = 2000;
/** At most this many change requests a minute, from all apps together. */
const PER_MINUTE = 6;

/** The link key: 32 random bytes in a file only this user can read, made on first use. */
export function linkKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length === 32) return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(32);
  writeFileSync(path, key, { mode: 0o600 });
  return key;
}

export function linkToken(key: Buffer, slug: string): string {
  return createHmac('sha256', key).update(`aios-app-link\n${slug}`).digest('hex');
}

const Change = z.object({
  slug: z.string().regex(APP_SLUG),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  request: z.string().max(MAX_REQUEST_CHARS * 2),
});
const Status = z.object({
  slug: z.string().regex(APP_SLUG),
  token: z.string().regex(/^[0-9a-f]{64}$/),
  card: z.string().max(100),
});

export type CardState = 'pending' | 'running' | 'done' | 'failed' | 'cancelled';

export interface LinkReply {
  ok: boolean;
  message: string;
  card?: string;
  state?: CardState | 'unknown';
}

export interface AppLinkOptions {
  key: Buffer;
  /** The launcher name of an app AI OS built, or null when there's no such app. */
  appName: (slug: string) => Promise<string | null>;
  /** Whether a Change card for this app is already waiting. */
  waiting: (slug: string) => boolean;
  /** Posts a Change card; the card's id, or why it couldn't. */
  offer: (a: { name: string; slug: string; request: string }) => Promise<{ card: string } | { error: string }>;
  /** A Build card's app and state. */
  card: (id: string) => { slug: string; state: CardState; step?: string | undefined; result?: string | undefined } | null;
  /** Brings the chat forward so the card can be clicked, and says so on the desktop. */
  showCard: (name: string) => void;
  audit: Pick<AuditLog, 'append'>;
  clock?: () => number;
}

const parse = (raw: unknown): unknown => {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

export class AppLink {
  private readonly clock: () => number;
  private recent: number[] = [];

  constructor(private readonly o: AppLinkOptions) {
    this.clock = o.clock ?? Date.now;
  }

  token(slug: string): string {
    return linkToken(this.o.key, slug);
  }

  private valid(slug: string, token: string): boolean {
    const want = Buffer.from(this.token(slug), 'hex');
    const got = Buffer.from(token, 'hex');
    return got.length === want.length && timingSafeEqual(got, want);
  }

  /** The button's Send. Posts a Change card at most; never builds. */
  async change(raw: unknown): Promise<LinkReply> {
    const p = Change.safeParse(parse(raw));
    if (!p.success || !this.valid(p.data.slug, p.data.token)) {
      this.o.audit.append({ kind: 'tool', tool: 'build_app', tier: 'write', via: 'app', decision: 'denied', reason: 'bad link request' });
      return { ok: false, message: "AI OS didn't recognise this app. Ask for the change in the chat instead." };
    }
    const { slug } = p.data;
    const audit = (entry: Record<string, unknown>) => this.o.audit.append({ kind: 'tool', tool: 'build_app', tier: 'write', via: 'app', app: slug, ...entry });
    // No control or invisible characters; line breaks kept, at most one blank line in a row.
    const request = p.data.request
      .split(/\r?\n/)
      .map((l) => l.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
      .slice(0, MAX_REQUEST_CHARS);
    if (!request) return { ok: false, message: 'Say what should change first.' };
    const now = this.clock();
    this.recent = this.recent.filter((t) => now - t < 60_000);
    if (this.recent.length >= PER_MINUTE) {
      audit({ decision: 'denied', reason: 'rate limited', requestChars: request.length });
      return { ok: false, message: 'Too many requests just now. Wait a minute and try again.' };
    }
    const name = await this.o.appName(slug);
    if (!name) {
      audit({ decision: 'denied', reason: 'not a built app', requestChars: request.length });
      return { ok: false, message: "AI OS can't find this app any more. Ask for the change in the chat instead." };
    }
    if (this.o.waiting(slug)) {
      audit({ decision: 'denied', reason: 'a card is already waiting', requestChars: request.length });
      return { ok: false, message: `A Change card for ${name} is already waiting in the AI OS chat. Click it or Cancel it there first.` };
    }
    this.recent.push(now);
    const r = await this.o.offer({ name, slug, request });
    if ('error' in r) {
      audit({ decision: 'denied', reason: r.error.slice(0, 200), requestChars: request.length });
      return { ok: false, message: r.error };
    }
    audit({ decision: 'proposed', actionId: r.card, requestChars: request.length });
    this.o.showCard(name);
    return { ok: true, card: r.card, state: 'pending', message: 'Sent. Click Change on the card in the AI OS chat to start; this app reloads when it is done.' };
  }

  /** Where the card this app posted is. Only that app's own cards answer. */
  status(raw: unknown): LinkReply {
    const p = Status.safeParse(parse(raw));
    if (!p.success || !this.valid(p.data.slug, p.data.token)) return { ok: false, state: 'unknown', message: '' };
    const c = this.o.card(p.data.card);
    if (!c || c.slug !== p.data.slug) return { ok: false, state: 'unknown', message: '' };
    const message = {
      pending: 'Waiting for you to click Change on the card in the AI OS chat.',
      running: `Changing the app${c.step ? `: ${c.step}` : '…'}`,
      done: 'Done.',
      failed: c.result ?? "The change didn't work.",
      cancelled: c.result ?? 'The change was cancelled; nothing was changed.',
    }[c.state];
    return { ok: true, state: c.state, message };
  }
}
