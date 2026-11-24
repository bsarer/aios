import type { NowPlaying } from '@aios/shared';
import { nowPlayingLabel, nowPlayingText } from '../nowPlaying';
import { Icon } from './ui';

/**
 * MU2: one quiet line above the message box naming the song that is playing. Display only: no
 * buttons, nothing is sent from here. Song words are plain text (React escapes them).
 */
export function NowPlayingLine({ nowPlaying }: { nowPlaying: NowPlaying }) {
  if (!nowPlaying) return null;
  const label = nowPlayingLabel(nowPlaying);
  return (
    <div
      data-testid="now-playing"
      data-playing={nowPlaying.playing ? 'true' : 'false'}
      role="status"
      aria-label={`${label}: ${nowPlayingText(nowPlaying)}`}
      title={label}
      className="now-playing mx-auto flex w-[min(760px,calc(100%-24px))] items-center justify-center gap-2 pb-1.5 text-[13px]"
    >
      <span className="now-playing-note shrink-0" style={{ color: 'var(--accent)' }}>
        <Icon name="music" size={13} />
      </span>
      <span className="min-w-0 truncate">{nowPlayingText(nowPlaying)}</span>
    </div>
  );
}
