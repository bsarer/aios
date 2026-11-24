/**
 * Routines: the user's own saved instructions, one Markdown file each in the config folder's
 * `routines/` (`~/.config/astra/routines/weekly-review.md`). A short header names the routine,
 * the phrases that start it and, optionally, when it runs by itself:
 *
 *   ---
 *   name: Weekly review
 *   say: weekly review, review my week
 *   schedule: fri 16:00
 *   ---
 *   Look at my calendar for the past week and the coming week. …
 *
 * The folder is outside `[files] roots`, so no tool can write it: only the user edits these
 * files. Code decides when one runs (a phrase the user's whole message matches, `/run`, or its
 * schedule, in `scheduler.ts`); there is no tool that runs a routine. The body then goes to the
 * chat agent as the user's own turn, so every gate still applies, and a scheduled run is
 * stricter still (ToolContext.unattended): nothing changes this computer without a click.
 */
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { utcToLocal, zonedToUtc, nextDay } from '../calendar/time.js';

/** Bigger files are not read. */
export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_BODY_CHARS = 4000;
const MAX_ROUTINES = 50;

/** Starts the turn the agent saves for a routine, so the knowledge base can leave routine text out (it is not something the user said that day). */
export const ROUTINE_TURN_PREFIX = 'Routine run: ';

export const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
const FULL_DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_WORDS: Record<string, number[]> = {
  daily: [0, 1, 2, 3, 4, 5, 6],
  everyday: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};

export interface Schedule {
  /** 0 = Sunday … 6 = Saturday, sorted. */
  days: number[];
  /** HH:MM, local time. */
  time: string;
}

export interface Routine {
  /** The file name without `.md`: letters, digits and dashes. */
  slug: string;
  name: string;
  /** Normalized phrases (see normalizePhrase). */
  say: string[];
  schedule?: Schedule;
  body: string;
}

export interface RoutineProblem {
  file: string;
  error: string;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
// Control and direction characters never belong in a routine's name or phrases.
// eslint-disable-next-line no-control-regex
const BAD_CHARS = /[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/;

/** Lower case, single spaces, no punctuation at the ends: how a typed or dictated message is compared with a phrase. */
export function normalizePhrase(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s ]+/g, ' ')
    .replace(/^[\s"'“”‘’.,!?;:…-]+|[\s"'“”‘’.,!?;:…-]+$/g, '')
    .trim();
}

/** "fri 16:00", "weekdays 08:30", "mon,wed 9:00", "daily 18:00". */
export function parseSchedule(text: string): Schedule | { error: string } {
  const m = /^\s*([a-z, ]+?)\s+(\d{1,2}):(\d{2})\s*$/i.exec(text);
  const usage = 'must be days then a time, like "fri 16:00", "weekdays 08:30", "mon,wed 09:00" or "daily 18:00"';
  if (!m) return { error: `schedule ${usage}` };
  const hour = Number(m[2]);
  const minute = Number(m[3]);
  if (hour > 23 || minute > 59) return { error: `schedule time ${m[2]}:${m[3]} is not a time of day` };
  const days = new Set<number>();
  for (const word of m[1]!.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    const group = DAY_WORDS[word];
    const one = DAY_NAMES.findIndex((d, i) => word === d || word === FULL_DAYS[i]);
    if (group) group.forEach((d) => days.add(d));
    else if (one >= 0) days.add(one);
    else return { error: `schedule day "${word}" is not one of ${DAY_NAMES.join(', ')}, daily, weekdays or weekends` };
  }
  if (!days.size) return { error: `schedule ${usage}` };
  return { days: [...days].sort((a, b) => a - b), time: `${String(hour).padStart(2, '0')}:${m[3]}` };
}

const Header = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1, 'name is empty')
    .max(60, 'name is longer than 60 characters')
    .refine((s) => !BAD_CHARS.test(s), 'name has control characters'),
  say: z
    .array(
      z
        .string()
        .refine((s) => !BAD_CHARS.test(s), 'a phrase has control characters')
        .transform(normalizePhrase)
        .refine((s) => s.length >= 3 && s.length <= 80, 'each phrase must be 3 to 80 characters')
        .refine((s) => !s.startsWith('/'), 'a phrase can\'t start with /'),
    )
    .max(10, 'at most 10 phrases')
    .default([]),
  schedule: z.string().optional(),
});

/** Reads one routine file's text. The header is `key: value` lines between `---` lines; `say` takes phrases separated by commas. */
export function parseRoutine(text: string, slug: string): { ok: true; routine: Routine } | { ok: false; error: string } {
  if (!SLUG.test(slug)) return { ok: false, error: 'the file name must be letters, digits and dashes, like weekly-review.md' };
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { ok: false, error: 'it must start with a header between two --- lines (name, say, schedule)' };
  const raw: Record<string, unknown> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const kv = /^([a-z]+)\s*:\s*(.*)$/i.exec(line.trim());
    if (!kv) return { ok: false, error: `header line "${line.trim().slice(0, 40)}" is not "key: value"` };
    const key = kv[1]!.toLowerCase();
    if (key in raw) return { ok: false, error: `header has ${key} twice` };
    const value = kv[2]!.trim();
    raw[key] = key === 'say' ? value.split(',').map((s) => s.trim()).filter(Boolean) : value;
  }
  const h = Header.safeParse(raw);
  if (!h.success) {
    const issue = h.error.issues[0]!;
    return { ok: false, error: issue.code === 'unrecognized_keys' ? `header has unknown ${issue.keys.join(', ')} (only name, say and schedule)` : issue.message };
  }
  const body = m[2]!.trim();
  if (!body) return { ok: false, error: 'there are no instructions under the header' };
  if (body.length > MAX_BODY_CHARS) return { ok: false, error: `the instructions are longer than ${MAX_BODY_CHARS} characters` };
  let schedule: Schedule | undefined;
  if (h.data.schedule) {
    const s = parseSchedule(h.data.schedule);
    if ('error' in s) return { ok: false, error: s.error };
    schedule = s;
  }
  if (!h.data.say.length && !schedule) return { ok: false, error: 'it needs a say phrase or a schedule (or both), or it can only start with /run' };
  return { ok: true, routine: { slug, name: h.data.name, say: [...new Set(h.data.say)], ...(schedule ? { schedule } : {}), body } };
}

/** The local weekday (0 = Sunday) of "YYYY-MM-DD". */
function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function prevDay(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** The latest scheduled time at or before `now`, within the last eight days. */
export function lastSlot(s: Schedule, now: number, timeZone: string): number | null {
  let date = utcToLocal(now, timeZone).slice(0, 10);
  for (let i = 0; i < 8; i++, date = prevDay(date)) {
    if (!s.days.includes(weekday(date))) continue;
    const at = zonedToUtc(`${date}T${s.time}`, timeZone).getTime();
    if (at <= now) return at;
  }
  return null;
}

/** The next scheduled time after `now`. */
export function nextSlot(s: Schedule, now: number, timeZone: string): number | null {
  let date = utcToLocal(now, timeZone).slice(0, 10);
  for (let i = 0; i < 8; i++, date = nextDay(date)) {
    if (!s.days.includes(weekday(date))) continue;
    const at = zonedToUtc(`${date}T${s.time}`, timeZone).getTime();
    if (at > now) return at;
  }
  return null;
}

/** "fri 16:00", "weekdays 08:30", "daily 18:00", as code writes it back. */
export function scheduleText(s: Schedule): string {
  const k = s.days.join(',');
  const days = k === '0,1,2,3,4,5,6' ? 'daily' : k === '1,2,3,4,5' ? 'weekdays' : k === '0,6' ? 'weekends' : s.days.map((d) => DAY_NAMES[d]).join(',');
  return `${days} ${s.time}`;
}

/**
 * The folders (from `[files] roots` or `[docs] roots`, `~` already expanded) that would let a
 * file tool reach `dir`: a root at or above it with no hidden folder in between (file tools leave
 * hidden ones alone). Routines stay off while this is not empty, so only the user writes them.
 */
export function rootsReaching(dir: string, roots: string[]): string[] {
  return roots.filter((r) => {
    if (!isAbsolute(r)) return false;
    const rel = relative(resolve(r), resolve(dir));
    if (rel === '') return true;
    if (rel.startsWith('..') || isAbsolute(rel)) return false;
    return !rel.split(sep).some((part) => part.startsWith('.'));
  });
}

/** Line ends as \n and exactly one at the end: how routine text is compared, hashed and written. */
export function normalizeText(text: string): string {
  return `${text.replace(/\r\n?/g, '\n').replace(/\s+$/, '')}\n`;
}

export class RoutineFolder {
  /** `home`: shown as ~ in the folder's display path. */
  constructor(
    readonly dir: string,
    private readonly home = '',
  ) {}

  /** The folder as the user would write it, e.g. ~/.config/astra/routines. */
  get display(): string {
    return this.home && (this.dir === this.home || this.dir.startsWith(`${this.home}/`)) ? `~${this.dir.slice(this.home.length)}` : this.dir;
  }

  /** The file for a slug, checked: letters, digits and dashes only, directly in the folder. */
  pathOf(slug: string): string {
    if (!SLUG.test(slug)) throw new Error('a routine file name is letters, digits and dashes, like focus-time');
    return join(this.dir, `${slug}.md`);
  }

  /** A routine file's text, or null when there is none. Throws for a link, something that isn't a file, or a file too big. */
  read(slug: string): string | null {
    const path = this.pathOf(slug);
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return null;
    }
    if (!st.isFile()) throw new Error(`${slug}.md is not a regular file (links are not read)`);
    if (st.size > MAX_FILE_BYTES) throw new Error(`${slug}.md is bigger than ${MAX_FILE_BYTES / 1024} KB`);
    return readFileSync(path, 'utf8');
  }

  /**
   * Every routine file, read again on each call so an edit applies at once. Only regular `.md`
   * files directly in the folder, never links or hidden files, and none over MAX_FILE_BYTES.
   */
  load(): { routines: Routine[]; problems: RoutineProblem[] } {
    const routines: Routine[] = [];
    const problems: RoutineProblem[] = [];
    let names: string[];
    try {
      names = readdirSync(this.dir).filter((n) => n.endsWith('.md') && !n.startsWith('.')).sort();
    } catch {
      return { routines, problems };
    }
    const phrases = new Map<string, string>();
    for (const file of names.slice(0, MAX_ROUTINES)) {
      const path = join(this.dir, file);
      let st;
      try {
        st = lstatSync(path);
      } catch {
        continue;
      }
      if (!st.isFile()) {
        problems.push({ file, error: 'it is not a regular file (links are not read)' });
        continue;
      }
      if (st.size > MAX_FILE_BYTES) {
        problems.push({ file, error: `it is bigger than ${MAX_FILE_BYTES / 1024} KB` });
        continue;
      }
      const r = parseRoutine(readFileSync(path, 'utf8'), file.slice(0, -3));
      if (!r.ok) {
        problems.push({ file, error: r.error });
        continue;
      }
      const clash = r.routine.say.find((p) => phrases.has(p));
      if (clash) {
        problems.push({ file, error: `the phrase "${clash}" is already ${phrases.get(clash)}'s` });
        continue;
      }
      for (const p of r.routine.say) phrases.set(p, r.routine.name);
      routines.push(r.routine);
    }
    if (names.length > MAX_ROUTINES) problems.push({ file: names[MAX_ROUTINES]!, error: `only the first ${MAX_ROUTINES} routines are read` });
    return { routines, problems };
  }

  /** The routine whose phrase the user's whole message is, or null. */
  match(text: string): Routine | null {
    if (text.length > 200) return null;
    const t = normalizePhrase(text);
    if (!t) return null;
    return this.load().routines.find((r) => r.say.includes(t)) ?? null;
  }

  /** /run's words: a routine's file name, name or phrase. */
  byName(text: string): Routine | null {
    const t = normalizePhrase(text);
    if (!t) return null;
    const all = this.load().routines;
    return all.find((r) => r.slug === t.replace(/\s+/g, '-') || normalizePhrase(r.name) === t) ?? all.find((r) => r.say.includes(t)) ?? null;
  }

  /** Copies the starter routines in once, when the folder doesn't exist yet. Deleting them later keeps them deleted. */
  installStarters(): boolean {
    if (existsSync(this.dir)) return false;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    for (const [slug, text] of Object.entries(STARTER_ROUTINES)) writeFileSync(join(this.dir, `${slug}.md`), text, { mode: 0o600, flag: 'wx' });
    return true;
  }
}

/** The routines a new install starts with. The user edits or deletes them like any other. */
export const STARTER_ROUTINES: Record<string, string> = {
  'weekly-review': `---
name: Weekly review
say: weekly review, review my week
schedule: fri 16:00
---
Help me close out the week.

1. Look at my calendar for the past seven days and the next seven days. Name the few things that mattered and anything coming up that needs preparing.
2. List my open to-dos, overdue ones first.
3. Find mail from the last week from people I've written to that I haven't answered yet.
4. Suggest up to three to-dos for next week, as a short list I can add myself.

Keep it to one short message.
`,
  'plan-tomorrow': `---
name: Plan tomorrow
say: plan tomorrow, plan my day tomorrow
schedule: weekdays 17:30
---
Help me plan tomorrow.

1. List tomorrow's events and the free gaps between them.
2. List the to-dos due tomorrow or overdue.
3. Suggest one focus block in the longest free gap, and offer it as a calendar event I can confirm.

Keep it short.
`,
  'meeting-prep': `---
name: Meeting prep
say: prep my next meeting, prepare my next meeting, meeting prep
---
Find my next calendar event with other people in it.
For each person in it, look them up in the knowledge base and find our recent mail.
Tell me in a few lines: what the meeting is about, who is coming and how I know them, and anything open between us.
`,
  'focus-time': `---
name: Focus time
say: focus time, start focus time
---
Turn on Do Not Disturb and pause the music.
Then tell me in one line that /focus rain, waves or brown plays a calm sound while I work.
`,
};
