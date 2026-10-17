import { existsSync, writeFileSync } from 'fs';

export const CACHE_FILE = '.session-cache';

export function start(user: string): void {
  writeFileSync(CACHE_FILE, user);
}

export function active(): boolean {
  return existsSync(CACHE_FILE);
}
