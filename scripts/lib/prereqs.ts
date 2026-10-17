import { existsSync } from 'node:fs';
import { run } from './exec.ts';
import type { QaConfig } from './config.ts';

export interface Prereq {
  name: string;
  ok: boolean;
  detail: string;
  /** Which tier needs it. */
  neededFor: 'all' | 'docker' | 'browser';
}

export type Tier = 'offline' | 'docker' | 'browser' | 'all';

function semverAtLeast(v: string, min: [number, number]) {
  const [a, b] = v.replace(/^v/, '').split('.').map(Number);
  return a > min[0] || (a === min[0] && b >= min[1]);
}

export async function checkPrereqs(cfg: QaConfig, tier: Tier): Promise<Prereq[]> {
  const out: Prereq[] = [];
  out.push({ name: 'node >= 20.11', ok: semverAtLeast(process.version, [20, 11]), detail: process.version, neededFor: 'all' });
  const gitV = await run('git', ['--version']);
  out.push({ name: 'git', ok: gitV.code === 0, detail: gitV.stdout.trim() || gitV.stderr.trim(), neededFor: 'all' });

  if (tier === 'docker' || tier === 'all') {
    const d = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeoutMs: 20_000 });
    const daemon = d.code === 0;
    out.push({ name: 'docker daemon', ok: daemon, detail: daemon ? `server ${d.stdout.trim()}` : (d.stderr.trim() || 'docker not found').slice(0, 200), neededFor: 'docker' });
    if (daemon) {
      const img = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', cfg.docker.nodeImage], { timeoutMs: 20_000 });
      out.push({ name: `docker image ${cfg.docker.nodeImage}`, ok: img.code === 0, detail: img.code === 0 ? 'present locally' : `missing — run: docker pull ${cfg.docker.nodeImage}`, neededFor: 'docker' });
    }
    // Sandboxed dependency installation (npm install inside the container) needs the public npm registry.
    const reg = await fetch('https://registry.npmjs.org/-/ping', { signal: AbortSignal.timeout(8000) }).then((r) => r.ok).catch(() => false);
    out.push({ name: 'npm registry reachable (sandbox dependency install)', ok: reg, detail: reg ? 'registry.npmjs.org reachable' : 'unreachable: Docker scenarios cannot install fixture dependencies', neededFor: 'docker' });
  }

  if (tier === 'browser' || tier === 'all') {
    let path = '';
    try {
      const { chromium } = await import('@playwright/test');
      path = chromium.executablePath();
    } catch (e) {
      path = '';
    }
    const ok = Boolean(path) && existsSync(path);
    out.push({ name: 'Playwright Chromium', ok, detail: ok ? 'installed' : 'missing — run: npx playwright install chromium (network)', neededFor: 'browser' });
  }
  return out;
}

export function tierAvailable(prereqs: Prereq[], neededFor: Prereq['neededFor']): { ok: boolean; detail: string } {
  const missing = prereqs.filter((p) => (p.neededFor === neededFor || p.neededFor === 'all') && !p.ok);
  return { ok: missing.length === 0, detail: missing.map((m) => `${m.name} (${m.detail})`).join('; ') };
}
