import { unlinkSync } from 'fs';
import { active, CACHE_FILE, start } from './session';

// The first test does not clean up the cache file it creates, so it fails whenever
// a previous run in the same checkout left the file behind.
test('starts without an active session', () => {
  if (active()) {
    unlinkSync(CACHE_FILE);
    throw new Error('a session is already active before start()');
  }
  start('ada');
});

test('session module exports a cache path', () => {
  expect(CACHE_FILE).toBe('.session-cache');
});
