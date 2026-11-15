/**
 * Google Contacts over the People API (v1) with plain fetch (C3). No Google SDK: two search
 * endpoints, each answer checked with zod. It uses the calendar's Google sign-in (GoogleAuth),
 * so there is one refresh token in the keyring and one `astra calendar-login`.
 *
 * Checked 2026-11-15 against Google's discovery document
 * (https://people.googleapis.com/$discovery/rest?version=v1, revision 20261111):
 * - GET v1/people:searchContacts?query&readMask&pageSize (≤ 30), scope contacts.readonly;
 *   matches names, nicknames, emails, phones and organizations of saved contacts.
 * - GET v1/otherContacts:search?query&readMask&pageSize (≤ 30), scope contacts.other.readonly;
 *   "other contacts" are the people Gmail saved because the user emailed them. readMask may
 *   only hold emailAddresses, metadata, names and phoneNumbers there.
 * - Both say: "Before searching, clients should send a warmup request with an empty query to
 *   update the cache." So each source gets one, then again after WARMUP_MS.
 *
 * Read only: no scope that can change a contact is ever asked for.
 */
import { z } from 'zod';
import { type GoogleAuth, CalendarError } from '../calendar/google.js';

export const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.readonly';
export const OTHER_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts.other.readonly';
export const CONTACTS_SCOPES = [CONTACTS_SCOPE, OTHER_CONTACTS_SCOPE] as const;

export type ContactSource = 'saved' | 'other';

/** A contact as the tool uses it. Every field is checked by code; names are outside text. */
export interface Contact {
  /** "people/c123" or "otherContacts/c123". */
  id: string;
  source: ContactSource;
  name: string;
  organization: string;
  emails: { address: string; label: string | null }[];
  phones: { number: string; label: string | null }[];
}

export type ContactsErrorKind = 'not_allowed' | 'api_disabled';

export class ContactsError extends Error {
  override readonly name = 'ContactsError';
  constructor(
    readonly kind: ContactsErrorKind,
    message: string,
  ) {
    super(message);
  }
}

/** One short reason for the chat. */
export function describeContactsError(err: unknown): string {
  if (err instanceof ContactsError) {
    return err.kind === 'not_allowed'
      ? "Astra isn't allowed to read Google Contacts. Run `astra calendar-login` and tick the contacts boxes on Google's page"
      : 'the People API is not turned on in your Google Cloud project. Enable "People API" there (same project as the calendar), then try again';
  }
  if (err instanceof CalendarError) {
    switch (err.kind) {
      case 'not_signed_in':
        return 'Astra is not signed in to Google yet. Run `astra calendar-login`';
      case 'auth':
        return 'the Google sign-in has expired or was revoked. Run `astra calendar-login` again';
      case 'rate':
        return 'Google Contacts is limiting requests; try again in a minute';
      case 'server':
        return 'Google Contacts had a problem; try again shortly';
      case 'network':
        return "Google Contacts can't be reached. Check the network connection";
      default:
        return `Google Contacts refused the request: ${err.message}`.slice(0, 200);
    }
  }
  if ((err as Error)?.name === 'KeyringError') return "the Google sign-in isn't readable from the keyring (it may still be locked)";
  return ((err as Error)?.message ?? 'unknown error').slice(0, 200);
}

const Field = z.object({ value: z.string().optional(), type: z.string().optional() });
/** What Astra reads of a person. Other fields Google sends are dropped. */
export const GooglePerson = z.object({
  resourceName: z.string(),
  names: z.array(z.object({ displayName: z.string().optional() })).optional(),
  emailAddresses: z.array(Field).optional(),
  phoneNumbers: z.array(Field.extend({ canonicalForm: z.string().optional() })).optional(),
  organizations: z.array(z.object({ name: z.string().optional() })).optional(),
});
export type GooglePerson = z.infer<typeof GooglePerson>;
const SearchResponse = z.object({ results: z.array(z.object({ person: GooglePerson.optional() })).default([]) });

const ApiError = z.object({
  error: z.object({
    message: z.string().optional(),
    status: z.string().optional(),
    details: z.array(z.object({ reason: z.string().optional() })).optional(),
    errors: z.array(z.object({ reason: z.string().optional() })).optional(),
  }),
});

/** A plain address, the shape mail tools accept. Anything else is dropped. */
export const CONTACT_EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*\.[A-Za-z]{2,24}$/;
/** Digits and the usual separators only, so a "number" can't carry words. */
export const CONTACT_PHONE = /^\+?[0-9][0-9 ().-]{2,30}$/;
/** Labels from a fixed list; Google also allows any custom text, which is dropped. */
const LABELS = new Set(['home', 'work', 'mobile', 'other', 'main', 'homefax', 'workfax', 'pager', 'workmobile']);
const label = (t: string | undefined) => (t && LABELS.has(t.toLowerCase()) ? t.toLowerCase() : null);
const RESOURCE = /^(people|otherContacts)\/[A-Za-z0-9_-]{1,100}$/;

/** Null for a person without a usable address or number (nothing to tell the user). */
export function toContact(p: GooglePerson, source: ContactSource): Contact | null {
  if (!RESOURCE.test(p.resourceName)) return null;
  const emails = [...new Map((p.emailAddresses ?? []).flatMap((e) => (e.value && CONTACT_EMAIL.test(e.value.trim()) ? [[e.value.trim().toLowerCase(), { address: e.value.trim(), label: label(e.type) }] as const] : []))).values()];
  const phones = [
    ...new Map(
      (p.phoneNumbers ?? []).flatMap((n) => {
        const v = (n.canonicalForm ?? n.value ?? '').trim();
        return CONTACT_PHONE.test(v) ? [[v.replace(/[^0-9+]/g, ''), { number: v, label: label(n.type) }] as const] : [];
      }),
    ).values(),
  ];
  if (!emails.length && !phones.length) return null;
  return {
    id: p.resourceName,
    source,
    name: p.names?.find((n) => n.displayName)?.displayName ?? '',
    organization: p.organizations?.find((o) => o.name)?.name ?? '',
    emails: emails.slice(0, 5),
    phones: phones.slice(0, 5),
  };
}

export interface ContactsApi {
  /** Saved contacts first, then other contacts; at most `limit`, no address twice. */
  search(query: string, limit: number, signal?: AbortSignal): Promise<Contact[]>;
}

export interface GoogleContactsOptions {
  apiBaseUrl: string;
  auth: Pick<GoogleAuth, 'accessToken' | 'invalidate'>;
  fetch?: typeof fetch;
  clock?: () => number;
  retryDelayMs?: number;
}

const WARMUP_MS = 10 * 60_000;
const ENDPOINT: Record<ContactSource, { path: string; readMask: string }> = {
  saved: { path: 'people:searchContacts', readMask: 'names,emailAddresses,phoneNumbers,organizations' },
  other: { path: 'otherContacts:search', readMask: 'names,emailAddresses,phoneNumbers' },
};

export class GoogleContacts implements ContactsApi {
  private readonly fetch: typeof fetch;
  private readonly clock: () => number;
  private readonly warmed = new Map<ContactSource, number>();

  constructor(private readonly o: GoogleContactsOptions) {
    this.fetch = o.fetch ?? fetch;
    this.clock = o.clock ?? Date.now;
  }

  private async get(source: ContactSource, query: string, pageSize: number, signal: AbortSignal | undefined): Promise<unknown> {
    const { path, readMask } = ENDPOINT[source];
    const qs = new URLSearchParams({ query, readMask, pageSize: String(pageSize) });
    const url = `${this.o.apiBaseUrl.replace(/\/$/, '')}/${path}?${qs.toString()}`;
    for (let attempt = 0; ; attempt++) {
      const token = await this.o.auth.accessToken(signal);
      let res: Response;
      try {
        res = await this.fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000) });
      } catch (err) {
        if (signal?.aborted) throw err;
        throw new CalendarError('network', (err as Error).message);
      }
      const json: unknown = await res.json().catch(() => null);
      if (res.ok) return json;
      if (res.status === 401 && attempt === 0) {
        this.o.auth.invalidate();
        continue;
      }
      if ((res.status === 429 || res.status >= 500) && attempt === 0) {
        await new Promise((r) => setTimeout(r, this.o.retryDelayMs ?? 1000));
        continue;
      }
      const e = ApiError.safeParse(json);
      const reasons = e.success ? [...(e.data.error.details ?? []), ...(e.data.error.errors ?? [])].map((d) => d.reason ?? '') : [];
      const message = (e.success ? e.data.error.message : undefined) ?? `HTTP ${res.status}`;
      if (res.status === 403) {
        if (reasons.some((r) => /SERVICE_DISABLED|accessNotConfigured/.test(r)) || /has not been used|is disabled/i.test(message)) throw new ContactsError('api_disabled', message.slice(0, 200));
        if (reasons.some((r) => /SCOPE_INSUFFICIENT|insufficientPermissions/i.test(r)) || (e.success && e.data.error.status === 'PERMISSION_DENIED')) throw new ContactsError('not_allowed', message.slice(0, 200));
      }
      throw new CalendarError(res.status === 401 ? 'auth' : res.status === 429 ? 'rate' : res.status >= 500 ? 'server' : 'bad_request', message.slice(0, 200), res.status);
    }
  }

  private async searchOne(source: ContactSource, query: string, limit: number, signal: AbortSignal | undefined): Promise<Contact[]> {
    const last = this.warmed.get(source);
    if (last === undefined || this.clock() - last > WARMUP_MS) {
      await this.get(source, '', 1, signal);
      this.warmed.set(source, this.clock());
    }
    const page = SearchResponse.safeParse(await this.get(source, query, Math.min(30, limit), signal));
    if (!page.success) throw new CalendarError('server', 'Google Contacts sent an unexpected answer');
    return page.data.results.flatMap((r) => (r.person ? [toContact(r.person, source)].filter((c): c is Contact => !!c) : []));
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<Contact[]> {
    const [saved, other] = await Promise.allSettled([this.searchOne('saved', query, limit, signal), this.searchOne('other', query, limit, signal)]);
    // One source not allowed (the user unticked it) still leaves the other.
    const failed = [saved, other].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed.length === 2 || failed.some((f) => !(f.reason instanceof ContactsError && f.reason.kind === 'not_allowed'))) throw failed[0]!.reason;
    const out: Contact[] = [];
    const seen = new Set<string>();
    for (const r of [saved, other]) {
      if (r.status !== 'fulfilled') continue;
      for (const c of r.value) {
        const emails = c.emails.filter((e) => !seen.has(e.address.toLowerCase()));
        // An "other contact" that only repeats a saved contact's address adds nothing.
        if (c.source === 'other' && c.emails.length && !emails.length) continue;
        for (const e of c.emails) seen.add(e.address.toLowerCase());
        out.push(c);
      }
    }
    return out.slice(0, limit);
  }
}
