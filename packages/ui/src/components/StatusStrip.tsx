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

const TONE = { muted: 'var(--muted)', accent: 'var(--accent)', warning: 'var(--warning)', danger: 'var(--danger)' } as const;

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

export function StatusStrip({ status, conn }: { status: Status | null; conn: Connection }) {
  const now = useNow();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const agent = conn !== 'open' ? 'offline' : (status?.agent ?? 'idle');
  const agentTone = agent === 'working' ? 'accent' : agent === 'paused' ? 'warning' : agent === 'offline' ? 'danger' : 'muted';
  const cost = status ? `$${status.costTodayUsd.toFixed(status.costTodayUsd < 1 ? 3 : 2)}` : '–';
  const mail = status?.mail ?? 'not_configured';

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
      {mail !== 'not_configured' && (
        <Item tone={mail === 'error' ? 'danger' : 'muted'} title={MAIL[mail]} testid="mail-state">
          <Icon name="mail" />
          <span data-mail={mail}>{mail === 'connected' ? 'Mail' : mail === 'connecting' ? 'Mail…' : 'Mail error'}</span>
        </Item>
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
    </header>
  );
}
