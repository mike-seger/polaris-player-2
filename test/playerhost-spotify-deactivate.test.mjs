import test from 'node:test';
import assert from 'node:assert/strict';

import { PlayerHost } from '../public/js/players/PlayerHost.mjs';

function makeMockAdapter({ name, kind, calls }) {
  return {
    name,
    supports: (k) => k === kind,
    mount: () => {},
    unmount: () => {},
    getThumbnailUrl: () => undefined,
    getCapabilities: () => ({
      canPlay: true,
      canPause: true,
      canStop: true,
      canSeek: true,
      canSetRate: false,
      canSetVolume: true,
      canMute: true,
      hasAccurateTime: true,
      hasAudioPipeline: false,
      hasVideo: kind === 'youtube' || kind === 'file' || kind === 'vlc',
    }),
    getInfo: () => ({
      state: 'idle',
      muted: false,
      volume: 1,
      rate: 1,
      time: { positionMs: 0, durationMs: undefined, bufferedMs: undefined },
      activeTrackId: undefined,
    }),
    getMediaPane: () => ({ kind: 'none' }),
    on: () => () => {},
    activate: async () => { calls.push(`${name}.activate`); },
    deactivate: async () => { calls.push(`${name}.deactivate`); },
    load: async () => { calls.push(`${name}.load`); },
    play: async () => { calls.push(`${name}.play`); },
    pause: async () => { calls.push(`${name}.pause`); },
    stop: async () => { calls.push(`${name}.stop`); },
    seekToMs: async () => {},
    setVolume: async () => {},
    setMuted: async () => {},
    setRate: async () => {},
    dispose: async () => { calls.push(`${name}.dispose`); },
  };
}

test('PlayerHost deactivates Spotify adapter when switching away', async () => {
  const calls = [];
  const spotify = makeMockAdapter({ name: 'spotify', kind: 'spotify', calls });
  const youtube = makeMockAdapter({ name: 'youtube', kind: 'youtube', calls });

  const host = new PlayerHost([spotify, youtube]);

  await host.load({ id: 's1', source: { kind: 'spotify', trackId: 'abc' } });
  await host.load({ id: 'y1', source: { kind: 'youtube', videoId: 'xyz' } });

  assert.ok(calls.includes('spotify.deactivate'), 'Expected spotify.deactivate to be called');

  const idxStop = calls.indexOf('spotify.stop');
  const idxDeactivate = calls.indexOf('spotify.deactivate');
  const idxYoutubeActivate = calls.indexOf('youtube.activate');

  assert.ok(idxStop !== -1, 'Expected spotify.stop to be called');
  assert.ok(idxDeactivate !== -1, 'Expected spotify.deactivate to be called');
  assert.ok(idxYoutubeActivate !== -1, 'Expected youtube.activate to be called');

  assert.ok(idxStop < idxDeactivate, 'Expected spotify.stop before spotify.deactivate');
  assert.ok(idxDeactivate < idxYoutubeActivate, 'Expected spotify.deactivate before youtube.activate');
});
