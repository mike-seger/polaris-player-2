import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const CSS_PATH = new URL('../public/style.css', import.meta.url);

function assertHasProgressWrapperPadding(cssText) {
  const idx = cssText.indexOf('#progressWrapper');
  assert.ok(idx !== -1, 'Expected #progressWrapper rule to exist');

  // Heuristic: look within the next ~500 chars for the padding line.
  const windowText = cssText.slice(idx, idx + 500);
  assert.match(
    windowText,
    /padding-bottom\s*:\s*6px\s*;/,
    'Expected #progressWrapper to include padding-bottom: 6px;'
  );
}

test('progress row has extra bottom padding', async () => {
  const cssText = await readFile(CSS_PATH, 'utf8');
  assertHasProgressWrapperPadding(cssText);
});
