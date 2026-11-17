import type { Status } from '@aios/shared/protocol';
import { useEffect, useState } from 'react';
import type { Connection } from '../useChat';
import { Icon } from './ui';

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

const MAIL: Record<Status['mail'], string> = {
  not_configured: 'Mail: off',
  connecting: 'Mail: connecting',
  connected: 'Mail: connected',
  error: 'Mail: error',
};

const TONE = { muted: 'var(--muted)', accent: 'var(--accent)', warning: 'var(--warning)', danger: 'var(--danger)', fg: 'var(--fg)' } as const;

function Item({ children, tone = 'muted', title, testid }: { children: React.ReactNode; tone?: keyof typeof TONE; title?: string | undefined; testid?: string }) {
  return (
    <span className="flex items-center gap-1.5 whitespace-nowrap" style={{ color: TONE[tone] }} title={title} data-testid={testid}>
      {children}
    </span>
  );
}

function Battery({ percent, charging }: { percent: number; charging: boolean }) {
  const fill = Math.max(1, Math.round((Math.min(100, Math.max(0, percent)) / 100) * 12));
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="7" width="18" height="10" rx="2.5" />
      <path d="M22.5 11v2" />
      {charging ? <path d="m12 8.5-2.5 4h3l-2.5 3" /> : <rect x="4.5" y="9.5" width={fill} height="5" rx="1" fill="currentColor" stroke="none" />}
    </svg>
  );
}

interface Props {
  status: Status | null;
  conn: Connection;
  onSettings?: () => void;
  /** Clear: starts the chat again (/clear). Left out while there is nothing to clear. */
  onClear?: (() => void) | undefined;
  /** A reply is being written: Clear waits for it (Esc stops it). */
  working?: boolean;
  /** New mail waiting in the side rail's inbox; shown instead of the plain mail item. */
  mail?: { fresh: number; urgent: number };
  onMail?: () => void;
}

export function StatusStrip({ status, conn, onSettings, onClear, working = false, mail, onMail }: Props) {
  const now = useNow();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const agent = conn !== 'open' ? 'offline' : (status?.agent ?? 'idle');
  const agentTone = agent === 'working' ? 'accent' : agent === 'paused' ? 'warning' : agent === 'offline' ? 'danger' : 'muted';
  const cost = status ? `$${status.costTodayUsd.toFixed(status.costTodayUsd < 1 ? 3 : 2)}` : '–';
  const mailState = status?.mail ?? 'not_configured';

  return (
    <header data-testid="status" className="flex flex-wrap items-center gap-x-6 gap-y-1 px-8 py-3.5 text-[13px]">
      <div className="flex items-baseline gap-3 text-[15px]">
        <span className="font-semibold tabular-nums" data-testid="clock">
          {time}
        </span>
        <span style={{ color: 'var(--muted)' }}>{date}</span>
      </div>
      <span className="flex-1" />
      <Item tone={agentTone} title={status?.model}>
        <span
          className={`h-2 w-2 rounded-full ${agent === 'working' ? 'orb-working' : ''}`}
          style={{ background: TONE[agentTone], boxShadow: agent === 'working' ? '0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent)' : undefined }}
        />
        <span data-testid="agent-state" className="capitalize">
          {agent}
        </span>
      </Item>
      {mailState === 'connected' && mail && mail.fresh > 0 ? (
        <button
          type="button"
          data-testid="mail-count"
          onClick={onMail}
          title="Open the inbox"
          className="-mx-2 flex items-center gap-1.5 whitespace-nowrap rounded-lg px-2 py-1 hover:bg-[var(--panel)]"
          style={{ color: mail.urgent ? 'var(--warning)' : 'var(--fg)' }}
        >
          <Icon name="mail" />
          {mail.fresh}
          {mail.urgent > 0 && ` · ${mail.urgent} urgent`}
        </button>
      ) : (
        mailState !== 'not_configured' && (
          <Item tone={mailState === 'error' ? 'danger' : 'muted'} title={MAIL[mailState]} testid="mail-state">
            <Icon name="mail" />
            <span data-mail={mailState}>{mailState === 'connected' ? 'Mail' : mailState === 'connecting' ? 'Mail…' : 'Mail error'}</span>
          </Item>
        )
      )}
      <Item tone={status?.wifi && !status.wifi.connected ? 'warning' : 'muted'}>
        <Icon name="wifi" />
        {status?.wifi ? (status.wifi.connected ? status.wifi.ssid || 'Wi-Fi' : 'Wi-Fi off') : 'Wi-Fi –'}
      </Item>
      {status?.battery && (
        <Item tone={status.battery.percent <= 15 && !status.battery.charging ? 'danger' : 'muted'} title={status.battery.charging ? 'Charging' : 'Battery'}>
          <Battery percent={status.battery.percent} charging={status.battery.charging} />
          <span className="tabular-nums">{status.battery.percent}%</span>
        </Item>
      )}
      <Item tone={status && status.costTodayUsd >= status.costCapUsd ? 'danger' : 'muted'} title="Model cost today">
        <span className="tabular-nums">
          <span data-testid="cost">{cost}</span> today
        </span>
      </Item>
      {onClear && (
        <button
          type="button"
          data-testid="clear-chat"
          onClick={onClear}
          disabled={conn !== 'open' || working}
          title={working ? 'Clear: press Esc to stop the reply first' : 'Clear the chat and start a new conversation (/clear). Your mail stays in the inbox.'}
          className="-mx-1 flex h-8 items-center gap-1.5 rounded-lg px-2 hover:bg-[var(--panel)] disabled:opacity-40"
          style={{ color: 'var(--muted)' }}
        >
          <Icon name="erase" size={16} />
          Clear
        </button>
      )}
      {onSettings && (
        <button
          type="button"
          data-testid="settings"
          onClick={onSettings}
          disabled={conn !== 'open'}
          title="Settings: opens the setup window on your current settings (/settings). /tone and /pin change tone and tiles in the chat."
          aria-label="Settings"
          className="-mx-2 flex h-8 w-8 items-center justify-center rounded-lg hover:bg-[var(--panel)] disabled:opacity-40"
          style={{ color: 'var(--muted)' }}
        >
          <Icon name="gear" size={17} />
        </button>
      )}
    </header>
  );
}
