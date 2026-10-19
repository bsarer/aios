import type { Status } from '@aios/shared/protocol';
import { useEffect, useState } from 'react';
import type { Connection } from '../useChat';

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

function Pill({ children, tone = 'muted', title }: { children: React.ReactNode; tone?: 'muted' | 'accent' | 'warning' | 'danger'; title?: string | undefined }) {
  const color = { muted: 'var(--muted)', accent: 'var(--accent)', warning: 'var(--warning)', danger: 'var(--danger)' }[tone];
  return (
    <span className="whitespace-nowrap" style={{ color }} title={title}>
      {children}
    </span>
  );
}

export function StatusStrip({ status, conn }: { status: Status | null; conn: Connection }) {
  const now = useNow();
  const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const date = now.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  const agent = conn !== 'open' ? 'offline' : (status?.agent ?? 'idle');
  const agentTone = agent === 'working' ? 'accent' : agent === 'paused' ? 'warning' : agent === 'offline' ? 'danger' : 'muted';
  const cost = status ? `$${status.costTodayUsd.toFixed(status.costTodayUsd < 1 ? 3 : 2)}` : '–';

  return (
    <header data-testid="status" className="glass mx-auto mt-3 flex w-[min(960px,calc(100%-24px))] items-center gap-5 rounded-2xl px-5 py-2 text-[15px]">
      <span className="font-semibold tabular-nums" data-testid="clock">{time}</span>
      <Pill>{date}</Pill>
      <span className="flex-1" />
      <Pill tone={agentTone} title={status?.model}>
        <span data-testid="agent-state">{agent === 'working' ? '● working' : agent === 'paused' ? '❚❚ paused' : agent === 'offline' ? '○ offline' : '○ idle'}</span>
      </Pill>
      <Pill tone={status?.mail === 'error' ? 'danger' : 'muted'}>{MAIL[status?.mail ?? 'not_configured']}</Pill>
      <Pill tone={status?.wifi && !status.wifi.connected ? 'warning' : 'muted'}>
        {status?.wifi ? (status.wifi.connected ? `Wi-Fi ${status.wifi.ssid ?? ''}`.trim() : 'Wi-Fi off') : 'Wi-Fi –'}
      </Pill>
      {status?.battery && (
        <Pill tone={status.battery.percent <= 15 && !status.battery.charging ? 'danger' : 'muted'}>
          {status.battery.charging ? '⚡' : '🔋'} {status.battery.percent}%
        </Pill>
      )}
      <Pill tone={status && status.costTodayUsd >= status.costCapUsd ? 'danger' : 'muted'} title="Model cost today">
        <span data-testid="cost">{cost}</span>
      </Pill>
    </header>
  );
}
