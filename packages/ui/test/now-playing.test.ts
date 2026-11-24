/** MU2: the now-playing line's words. Display only; the song's words are shown as plain text. */
import { describe, expect, it } from 'vitest';
import { nowPlayingLabel, nowPlayingText } from '../src/nowPlaying';

describe('the now-playing line (MU2)', () => {
  it('names the song and artist, and says when it is paused', () => {
    expect(nowPlayingText({ playing: true, title: 'Says', artist: 'Nils Frahm', app: 'Spotify' })).toBe('Says · Nils Frahm');
    expect(nowPlayingText({ playing: false, title: 'Says', artist: 'Nils Frahm', app: 'Spotify' })).toBe('Paused · Says · Nils Frahm');
    expect(nowPlayingText({ playing: true, title: '', artist: 'Nils Frahm', app: 'Spotify' })).toBe('Nils Frahm');
    expect(nowPlayingLabel({ playing: true, title: 'x', artist: '', app: 'Spotify' })).toBe('Playing in Spotify');
    expect(nowPlayingLabel({ playing: false, title: 'x', artist: '', app: 'Chromium' })).toBe('Paused in Chromium');
  });
});
