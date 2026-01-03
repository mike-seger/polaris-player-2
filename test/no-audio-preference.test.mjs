import test from 'node:test';
import assert from 'node:assert/strict';

import { TrackDetailSettingsStore } from '../public/js/TrackDetailSettingsStore.mjs';

test('TrackDetailSettingsStore persists noAudio boolean', () => {
  const saves = [];
  const defaults = {
    trackNumber: true,
    thumbnail: true,
    noAudio: false,
    wrapLines: true,
    country: true,
    checkTrack: false,
    showExcluded: false,
    sortAZ: false,
  };

  const store = new TrackDetailSettingsStore({
    defaults,
    getSettings: () => ({ trackDetailPreferences: { noAudio: true } }),
    saveSettings: (patch) => saves.push(patch),
  });

  const snap = store.snapshot();
  assert.equal(snap.preferences.noAudio, true);

  store.setPreferences({ noAudio: false });
  assert.equal(store.getPreferences().noAudio, false);
  assert.ok(
    saves.some((p) => p && p.trackDetailPreferences && p.trackDetailPreferences.noAudio === false),
    'Expected saveSettings to persist noAudio=false'
  );
});
