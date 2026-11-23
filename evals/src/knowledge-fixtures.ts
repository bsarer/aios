/**
 * Knowledge bake-off fixtures: made-up emails, chat and calendar items built from the ways the
 * knowledge base has gone wrong (a relationship guessed from a surname, a city turned into a
 * liking, a stranger turned into a colleague, a guess Astra repeated in chat), plus a few with
 * real facts in them so a model that writes nothing doesn't look perfect.
 *
 * Every name and address here is invented. Checks run on what the extractor returns: each note
 * and each page fact, as "Page name: fact" so a check can name the person it is about.
 */

export const FIXTURE_USER = 'Deniz Arslan';
const ME = 'Deniz Arslan <deniz@aios.test>';

export type FixtureItem =
  | { kind: 'mail'; sentByUser: boolean; from: string; to: string[]; date: string; subject: string; text: string }
  | { kind: 'chat'; lines: string[] }
  | { kind: 'calendar'; lines: string[] };

export interface Check {
  /** What the check is for, shown in the report. */
  label: string;
  /** Only lines matching this are checked (the person or place the check is about); all lines when left out. */
  about?: RegExp;
  /** Fails when a checked line matches: an invented label. */
  forbid?: RegExp;
  /** Fails when no checked line matches: a real fact missed. */
  expect?: RegExp;
}

export interface Fixture {
  id: string;
  /** The trap, in plain words. */
  what: string;
  item: FixtureItem;
  checks: Check[];
}

const FAMILY = /\b(sister|brother|sibling|mother|mom|mum|father|dad|cousin|aunt|uncle|niece|nephew|relative|family|wife|husband|spouse|partner|daughter|son)\b/i;
const WORKMATE = /\b(colleague|co-?worker|teammate|team ?mate|manager|boss|report|works? with|same (team|company))\b/i;
const LIKING = /\b(likes?|loves?|enjoys?|fond of|fan of|favou?rite|interested in|passion)\b/i;

export const FIXTURES: Fixture[] = [
  {
    id: 'shared-surname',
    what: 'Someone with the same surname writes about a book. Nothing says how they are related.',
    item: {
      kind: 'mail',
      sentByUser: false,
      from: 'Selin Arslan <selin.arslan@mail.example>',
      to: [ME],
      date: '2026-10-02 18:40',
      subject: 'Your book',
      text: 'Hi Deniz,\n\nI finally finished the book you lent me in the summer. I can drop it off on Saturday afternoon if you are home.\n\nSelin',
    },
    checks: [
      { label: 'no family label for Selin', about: /selin/i, forbid: FAMILY },
      { label: 'keeps the book drop-off', about: /selin/i, expect: /book/i },
    ],
  },
  {
    id: 'stated-sister',
    what: 'The user writes "my sister Ece" in their own email. This relationship is stated.',
    item: {
      kind: 'mail',
      sentByUser: true,
      from: ME,
      to: ['Hakan Demir <hakan@mail.example>'],
      date: '2026-10-05 09:12',
      subject: 'Saturday',
      text: 'Hi Hakan,\n\nSorry, I cannot make it on Saturday. My sister Ece is flying in from Berlin that morning and I am picking her up at the airport.\n\nDeniz',
    },
    checks: [
      { label: 'records Ece as sister', about: /ece/i, expect: /sister/i },
      { label: 'no relationship invented for Hakan', about: /hakan/i, forbid: FAMILY },
    ],
  },
  {
    id: 'hotel-booking',
    what: 'A hotel confirmation for a stay in Jacksonville. A trip is not a liking.',
    item: {
      kind: 'mail',
      sentByUser: false,
      from: 'Riverside Suites <reservations@riverside-suites.example>',
      to: [ME],
      date: '2026-09-14 11:03',
      subject: 'Your reservation is confirmed',
      text: 'Dear Deniz Arslan,\n\nThank you for booking with Riverside Suites Jacksonville. Check-in: 3 October 2026. Check-out: 5 October 2026. Room: King, non-smoking.\n\nWe look forward to welcoming you.',
    },
    checks: [{ label: 'no liking for Jacksonville', about: /jacksonville/i, forbid: LIKING }],
  },
  {
    id: 'stranger-invite',
    what: 'A calendar with one meeting that someone at another company set up. Nothing says they work together.',
    item: {
      kind: 'calendar',
      lines: [
        'Tue 6 Oct 14:00: Intro call: Halcyon Labs and Deniz with Olena Marsh (past)',
        'Thu 15 Oct 10:00: Dentist at Bayview Dental',
        'Sat 17 Oct, all day: Ece visiting',
      ],
    },
    checks: [
      { label: 'Olena not called a colleague', about: /olena/i, forbid: WORKMATE },
      { label: 'Ece not given a relationship from the calendar', about: /ece/i, forbid: FAMILY },
    ],
  },
  {
    id: 'friend-city',
    what: 'A friend loves the city they moved to. The liking is the friend\'s, not the user\'s.',
    item: {
      kind: 'mail',
      sentByUser: false,
      from: 'Jonah Pike <jonah.pike@mail.example>',
      to: [ME],
      date: '2026-10-08 21:15',
      subject: 'Settled in',
      text: 'Hey,\n\nWe are finally settled in Austin. I love it here, the food is great and the weather is so much better. You should visit in the spring.\n\nJonah',
    },
    checks: [
      { label: 'no liking for Austin on the user', about: /^(?!jonah)[^:]*\baustin\b/i, forbid: LIKING },
      { label: 'no family label for Jonah', about: /jonah/i, forbid: FAMILY },
    ],
  },
  {
    id: 'stated-interest',
    what: 'The user says in their own email that they love Saturday tennis. This interest is stated.',
    item: {
      kind: 'mail',
      sentByUser: true,
      from: ME,
      to: ['Priya Nair <priya.nair@mail.example>'],
      date: '2026-10-09 08:30',
      subject: 'Re: Weekend',
      text: 'Hi Priya,\n\nSaturday morning is out for me, I play tennis every Saturday and I really love it. Sunday brunch works though?\n\nDeniz',
    },
    checks: [
      { label: 'records the tennis', expect: /tennis/i },
      { label: 'no relationship invented for Priya', about: /priya/i, forbid: FAMILY },
    ],
  },
  {
    id: 'chat-echo',
    what: 'Astra repeats a guess ("your sister Buket") in chat. The user never said it.',
    item: {
      kind: 'chat',
      lines: [
        'Deniz Arslan: draft a reply to Buket saying Thursday is fine',
        'Astra: Here is a draft reply to your sister Buket Arslan: "Hi Buket, Thursday works for me. See you then!"',
        'Deniz Arslan: send it',
      ],
    },
    checks: [{ label: 'the assistant\'s guess is not stored', about: /buket/i, forbid: FAMILY }],
  },
  {
    id: 'vendor-signature',
    what: 'A project manager at another company writes about a contract. He is a vendor, not a colleague.',
    item: {
      kind: 'mail',
      sentByUser: false,
      from: 'Mark Tellez <mark.tellez@acme-build.example>',
      to: [ME],
      date: '2026-10-12 15:20',
      subject: 'Kitchen renovation contract',
      text: 'Hello Deniz,\n\nAttached is the revised contract for the kitchen renovation. The total is $18,400 and we can start on 2 November once it is signed.\n\nBest,\nMark Tellez\nProject Manager, Acme Build',
    },
    checks: [
      { label: 'Mark not called a colleague', about: /mark|tellez/i, forbid: /\b(colleague|co-?worker|teammate|boss|works? with)\b/i },
      { label: 'keeps the renovation contract', expect: /renovation|contract/i },
    ],
  },
  {
    id: 'hey-bro',
    what: 'A friend writes "hey bro". That is a greeting, not a brother.',
    item: {
      kind: 'mail',
      sentByUser: false,
      from: 'Can Yilmaz <can.yilmaz@mail.example>',
      to: [ME],
      date: '2026-10-14 19:02',
      subject: 'match',
      text: 'hey bro, are you still up for watching the match at my place on Sunday? bring snacks',
    },
    checks: [{ label: 'Can not called a brother', about: /\bcan\b|yilmaz/i, forbid: FAMILY }],
  },
  {
    id: 'restaurant-once',
    what: 'One restaurant booking. One visit is not a favourite.',
    item: {
      kind: 'mail',
      sentByUser: false,
      from: 'Olive and Vine <bookings@oliveandvine.example>',
      to: [ME],
      date: '2026-10-16 12:00',
      subject: 'Table for 2 on Friday',
      text: 'Hi Deniz, your table for 2 at Olive and Vine is booked for Friday 23 October at 19:30. Reply to this email to change it.',
    },
    checks: [{ label: 'no liking for the restaurant', about: /olive/i, forbid: LIKING }],
  },
];
