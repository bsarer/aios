import type { HTMLAttributes, ReactNode } from 'react';

/** Small line icons drawn inline (no icon library). Decorative: screen readers skip them. */
const PATHS = {
  mail: (
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m3 7 9 6 9-6" />
    </>
  ),
  wifi: (
    <>
      <path d="M2 9a15 15 0 0 1 20 0" />
      <path d="M5 12.5a10 10 0 0 1 14 0" />
      <path d="M8.5 16a5 5 0 0 1 7 0" />
      <circle cx="12" cy="19.5" r="0.8" fill="currentColor" />
    </>
  ),
  system: (
    <>
      <path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1" />
      <circle cx="15" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="17" cy="18" r="2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </>
  ),
  todo: (
    <>
      <path d="M10 6h10M10 12h10M10 18h10" />
      <path d="m3.5 6 1.5 1.5L7.5 5M3.5 12l1.5 1.5L7.5 11M3.5 18l1.5 1.5L7.5 17" />
    </>
  ),
  memory: <path d="M7 4h10a1 1 0 0 1 1 1v15l-6-4-6 4V5a1 1 0 0 1 1-1z" />,
  folder: <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />,
  file: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5M9 13h6M9 17h6" />
    </>
  ),
  clip: <path d="m20 11.5-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.5 8.5a1.7 1.7 0 0 1-2.4-2.4l7.8-7.8" />,
  box: (
    <>
      <path d="M12 3 3.5 7.5v9L12 21l8.5-4.5v-9z" />
      <path d="M3.5 7.5 12 12l8.5-4.5M12 12v9" />
    </>
  ),
  alert: (
    <>
      <path d="M12 4 2.5 20h19z" />
      <path d="M12 10v4M12 17h.01" />
    </>
  ),
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  gauge: (
    <>
      <path d="M4 18a8 8 0 1 1 16 0" />
      <path d="m12 18 4-5" />
    </>
  ),
  sweep: (
    <>
      <path d="M14 4 9 13" />
      <path d="M5 13h9l1 7H4z" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
  cross: <path d="M6 6l12 12M18 6 6 18" />,
  arrowUp: <path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" />,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 16, strokeWidth = 1.8, className }: { name: IconName; size?: number; strokeWidth?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {PATHS[name]}
    </svg>
  );
}

/** The assistant's mark: a ring with a dot, like the orb in the top bar. */
export function Mark({ size = 26 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={size > 32 ? 1.4 : 1.8} aria-hidden="true" style={{ color: 'var(--accent)' }}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

export type Tone = 'accent' | 'warning' | 'danger' | 'muted';

/** The label most cards that wait for a click carry. */
export const NEEDS_OK = 'Needs your OK';

interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  icon: IconName;
  /** Header text. Written by code, or plain text from the item: never Markdown or HTML. */
  title: ReactNode;
  tone?: Tone;
  badge?: { text: string; tone?: Tone } | false | undefined;
  /** Extra header content after the title (before the badge). */
  aside?: ReactNode;
  children?: ReactNode;
}

/**
 * The one card frame (header with icon and label, then the body). data-* attributes pass
 * through to the outer element, which is what tests and the e2e run select on.
 */
export function Card({ icon, title, tone = 'accent', badge, aside, children, className, ...rest }: CardProps) {
  return (
    <div {...rest} data-tone={tone === 'danger' ? 'danger' : undefined} className={`card ${className ?? ''}`}>
      <div className="card-head">
        <span className="tile" data-tone={tone}>
          <Icon name={icon} />
        </span>
        <span className="min-w-0 flex-1 text-[15px] font-semibold">{title}</span>
        {aside}
        {badge && (
          <span className="badge" data-tone={badge.tone ?? 'accent'}>
            {badge.text}
          </span>
        )}
      </div>
      {children !== undefined && <div className="card-body">{children}</div>}
    </div>
  );
}

/** The action row at the foot of a card body, full width with a rule above it. */
export function CardActions({ children }: { children: ReactNode }) {
  return <div className="card-actions">{children}</div>;
}
