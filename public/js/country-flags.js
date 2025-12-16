(function () {
  'use strict';

  // Minimal ISO3 -> ISO2 mapping for codes present in data/country-artist-iso3.tsv (split on ';').
  const ISO3_TO_ISO2 = Object.freeze({
    ARG: 'AR',
    AUS: 'AU',
    AUT: 'AT',
    BEL: 'BE',
    BLR: 'BY',
    CAN: 'CA',
    CHE: 'CH',
    CHL: 'CL',
    DEU: 'DE',
    DNK: 'DK',
    ESP: 'ES',
    FIN: 'FI',
    FRA: 'FR',
    GBR: 'GB',
    GRC: 'GR',
    HRV: 'HR',
    HUN: 'HU',
    ISL: 'IS',
    ITA: 'IT',
    KAZ: 'KZ',
    MEX: 'MX',
    NLD: 'NL',
    NOR: 'NO',
    PRT: 'PT',
    RUS: 'RU',
    SRB: 'RS',
    SWE: 'SE',
    TUR: 'TR',
    USA: 'US',
    UZB: 'UZ',
    ZAF: 'ZA'
  });

  function iso2ToFlagEmoji(iso2) {
    const code = (iso2 || '').trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(code)) return '';
    const A = 0x1F1E6;
    const base = 'A'.charCodeAt(0);
    const first = A + (code.charCodeAt(0) - base);
    const second = A + (code.charCodeAt(1) - base);
    return String.fromCodePoint(first, second);
  }

  window.getFlagEmojiForIso3 = function getFlagEmojiForIso3(iso3) {
    const code3 = (iso3 || '').trim().toUpperCase();
    const iso2 = ISO3_TO_ISO2[code3];
    return iso2 ? iso2ToFlagEmoji(iso2) : '';
  };
})();
