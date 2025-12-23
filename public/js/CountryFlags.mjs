import { ISO3_TO_ISO2 } from './Iso3ToIso2.mjs';

function iso2ToFlagEmoji(iso2) {
  const code = (iso2 || '').trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return '';
  const A = 0x1f1e6;
  const base = 'A'.charCodeAt(0);
  const first = A + (code.charCodeAt(0) - base);
  const second = A + (code.charCodeAt(1) - base);
  return String.fromCodePoint(first, second);
}

export function getFlagEmojiForIso3(iso3) {
  const code3 = (iso3 || '').trim().toUpperCase();
  const iso2 = ISO3_TO_ISO2[code3];
  return iso2 ? iso2ToFlagEmoji(iso2) : '';
}

// Temporary global shim for legacy call sites.
if (typeof window !== 'undefined') {
  window.getFlagEmojiForIso3 = getFlagEmojiForIso3;
}
