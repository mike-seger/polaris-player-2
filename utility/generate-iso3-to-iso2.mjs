import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import iso3166 from 'iso-3166-1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function stringifyMapping(mapping) {
  const keys = Object.keys(mapping).sort((a, b) => a.localeCompare(b));
  const lines = keys.map((k) => `  ${k}: ${JSON.stringify(mapping[k])}`);
  return `// GENERATED FILE — do not edit by hand.
// Regenerate via: node utility/generate-iso3-to-iso2.mjs

export const ISO3_TO_ISO2 = Object.freeze({
${lines.join(',\n')}
});
`;
}

async function main() {
  const rows = typeof iso3166.all === 'function' ? iso3166.all() : [];
  if (!Array.isArray(rows) || !rows.length) {
    throw new Error('iso-3166-1 did not return any rows (unexpected)');
  }

  const mapping = {};
  rows.forEach((row) => {
    const a2 = row && typeof row === 'object' ? row.alpha2 : undefined;
    const a3 = row && typeof row === 'object' ? row.alpha3 : undefined;
    if (typeof a2 !== 'string' || typeof a3 !== 'string') return;
    const alpha2 = a2.trim().toUpperCase();
    const alpha3 = a3.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(alpha2)) return;
    if (!/^[A-Z]{3}$/.test(alpha3)) return;
    mapping[alpha3] = alpha2;
  });

  // Ensure we cover common “new” codes like LTU.
  if (mapping.LTU !== 'LT') {
    // (Should never happen, but guard anyway.)
    mapping.LTU = 'LT';
  }

  const outPath = path.resolve(__dirname, '..', 'public', 'js', 'Iso3ToIso2.mjs');
  await fs.writeFile(outPath, stringifyMapping(mapping), 'utf8');

  // eslint-disable-next-line no-console
  console.log(`Wrote ${Object.keys(mapping).length} mappings to ${outPath}`);
}

await main();
