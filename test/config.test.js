import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/lib/config.js';

const { DEFAULTS, DEFAULT_SEED_VERSION, DEFAULT_KEYWORDS, seedDefaultFilters } = globalThis.XQB_CONFIG;

test('seedDefaultFilters seeds default keywords once and preserves user deletions', () => {
  const cfg = { ...DEFAULTS, keywords: ['custom-spam'], regexes: [] };
  const changed = seedDefaultFilters(cfg);
  assert.equal(changed, true);
  assert.equal(cfg.defaultsSeedVersion, DEFAULT_SEED_VERSION);
  assert.ok(cfg.keywords.includes('custom-spam'));
  for (const kw of DEFAULT_KEYWORDS) {
    assert.ok(cfg.keywords.includes(kw));
  }

  // User deletes a seeded keyword; re-running seedDefaultFilters must not re-add it
  cfg.keywords = cfg.keywords.filter((k) => k !== DEFAULT_KEYWORDS[0]);
  const changedAgain = seedDefaultFilters(cfg);
  assert.equal(changedAgain, false);
  assert.ok(!cfg.keywords.includes(DEFAULT_KEYWORDS[0]));
});
