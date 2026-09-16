const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

test('V2 verifier exits promptly when the CLI is missing or exits before startup', () => {
  const script = path.join(__dirname, '../scripts/verify-opencode-v2.mjs');
  for (const [binary, expected] of [
    [path.join(__dirname, 'missing-opencode-executable'), /ENOENT/],
    [process.execPath, /Server exited/],
  ]) {
    const result = spawnSync(process.execPath, [script], {
      env: { ...process.env, OPENCODE_V2_BIN: binary },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, expected);
  }
});
