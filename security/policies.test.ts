/**
 * F. Unsafe paths, patch policy, command construction, container arguments,
 * and clone-source validation — white-box against the target commit's own
 * modules. Nothing here runs a container; git operations happen only inside
 * throwaway repositories in this run's directory.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { before, describe, test } from 'node:test';
import { git } from '../scripts/lib/exec.ts';
import { importTarget, qaEnv } from '../scripts/lib/harness.ts';

let ws: any;
let fw: any;
let docker: any;
let remediation: any;
before(async () => {
  ws = await importTarget('server/src/runner/workspace.ts');
  fw = await importTarget('server/src/runner/frameworks.ts');
  docker = await importTarget('server/src/runner/docker.ts');
  remediation = await importTarget('server/src/pipeline/remediation.ts');
});

const diffFor = (path: string, body = '@@ -1 +1 @@\n-a\n+b\n') => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${body}`;

describe('F: patch policy blocks unsafe changes', () => {
  const blocked: Array<[string, string, RegExp]> = [
    ['path traversal', diffFor('src/../../outside.txt'), /escapes repository/],
    ['an absolute path', 'diff --git a//etc/passwd b//etc/passwd\n--- a//etc/passwd\n+++ b//etc/passwd\n@@ -1 +1 @@\n-a\n+b\n', /escapes repository|not allowed/],
    ['a CI workflow', diffFor('.github/workflows/ci.yml'), /not allowed: \.github/],
    ['an .npmrc in a subdirectory', diffFor('packages/api/.npmrc'), /not allowed/],
    ['an .env file', diffFor('.env.production'), /not allowed/],
    ['a git hook', diffFor('.git/hooks/pre-commit'), /not allowed/],
    ['Maven wrapper config', diffFor('.mvn/wrapper/maven-wrapper.properties'), /not allowed/],
    ["Alibi's own workspace metadata", diffFor('.alibi/candidate.patch'), /not allowed/],
    ['a mode change', `diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n`, /Mode changes/],
    ['a new executable file', `diff --git a/x.sh b/x.sh\nnew file mode 100755\n--- /dev/null\n+++ b/x.sh\n@@ -0,0 +1 @@\n+echo hi\n`, /Mode changes/],
    ['a symlink', `diff --git a/link b/link\nnew file mode 120000\n--- /dev/null\n+++ b/link\n@@ -0,0 +1 @@\n+/etc/passwd\n`, /Symlinks/],
    ['a binary patch', `diff --git a/a.bin b/a.bin\nGIT binary patch\nliteral 4\nLcmZ?d00001\n`, /Binary/],
    ['a rename', `diff --git a/a.js b/b.js\nsimilarity index 100%\nrename from a.js\nrename to b.js\n`, /Renames/],
    ['an oversized patch', diffFor('src/big.js', `@@ -1 +1 @@\n-a\n+${'x'.repeat(70 * 1024)}\n`), /64 KiB/],
    ['a diff that touches no file', 'just some text\n', /does not modify any files/],
  ];
  for (const [name, diff, reason] of blocked) {
    test(`[F2] rejects ${name}`, () => {
      const r = ws.checkPatchPolicy(diff);
      assert.equal(r.ok, false, `accepted: ${JSON.stringify(r)}`);
      assert.match(r.reasons.join('; '), reason);
    });
  }

  test('[F2] accepts an ordinary source edit', () => {
    const r = ws.checkPatchPolicy(diffFor('src/shipping.js'));
    assert.equal(r.ok, true, r.reasons.join('; '));
    assert.deepEqual(r.files, ['src/shipping.js']);
  });

  test('[F2] applyPatch refuses a traversal diff before git sees it, and nothing is written outside the workspace', async () => {
    const dir = join(qaEnv().runDir, 'scratch', `apply-${Date.now()}`);
    mkdirSync(join(dir, '.alibi'), { recursive: true });
    await git(['init', '-q'], dir);
    const r = await ws.applyPatch(dir, `diff --git a/../escape.txt b/../escape.txt\nnew file mode 100644\n--- /dev/null\n+++ b/../escape.txt\n@@ -0,0 +1 @@\n+owned\n`);
    assert.equal(r.ok, false);
    assert.equal(existsSync(join(dir, '..', 'escape.txt')), false);
  });
});

describe('F: model-written edits are confined to the files the model was shown', () => {
  let repo: string;
  let sha: string;
  before(async () => {
    repo = join(qaEnv().runDir, 'scratch', `materialize-${Date.now()}`);
    mkdirSync(join(repo, 'src'), { recursive: true });
    mkdirSync(join(repo, 'test'), { recursive: true });
    writeFileSync(join(repo, 'src', 'a.js'), 'module.exports = 1;\n');
    writeFileSync(join(repo, 'test', 'a.test.js'), "test('a', () => expect(require('../src/a')).toBe(1));\n");
    await git(['init', '-q', '-b', 'main'], repo);
    await git(['add', '-A'], repo);
    await mustCommit(repo);
    sha = (await git(['rev-parse', 'HEAD'], repo)).trim();
  });
  const cand = (path: string, content = 'module.exports = 2;\n') => ({ title: 'qa', strategy: 'code_patch', origin: 'model', rationale: 'qa', edits: [{ path, content }] });
  const materialize = (path: string, allowed: string[] | undefined, content?: string) =>
    remediation.materialize({ location: repo, cacheKey: 'qa' }, sha, join(qaEnv().runDir, 'scratch', `m-${Date.now()}-${Math.random().toString(16).slice(2)}`), 'inv_qa', cand(path, content), allowed);

  test('[F2] an edit outside the allowed file list is rejected', async () => {
    const r = await materialize('src/a.js', ['src/b.js']);
    assert.equal(r.patch, null);
    assert.match(r.problem, /outside the files provided to the model/);
  });
  for (const p of ['../outside.js', '/etc/passwd', 'src/../../outside.js', 'src/new-file.js']) {
    test(`[F2] an edit to "${p}" is rejected`, async () => {
      const r = await materialize(p, undefined);
      assert.equal(r.patch, null);
      assert.match(r.problem, /Invalid or unknown path/);
    });
  }
  test('[F2] an edit producing no change is rejected', async () => {
    const r = await materialize('src/a.js', undefined, 'module.exports = 1;\n');
    assert.equal(r.patch, null);
    assert.match(r.problem, /no changes/);
  });
  test('[F2] test files are recognised so the retry can exclude them', () => {
    for (const p of ['test/a.test.js', 'src/__tests__/x.js', 'lib/x.spec.ts', 'src/test/java/com/x/FooTest.java', 'tests/unit/y.js']) assert.equal(remediation.isTestFile(p), true, p);
    for (const p of ['src/a.js', 'src/testing-utils.js', 'pom.xml', 'package.json']) assert.equal(remediation.isTestFile(p), false, p);
  });
});

async function mustCommit(dir: string) {
  await git(['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'init'], dir);
}

describe('F: test selections and commands are data, never shell', () => {
  test('[F3] unsafe Jest selections are dropped', () => {
    assert.deepEqual(fw.validateSelection('jest', { file: '../../etc/passwd' }), {});
    assert.deepEqual(fw.validateSelection('jest', { file: '/etc/passwd' }), {});
    assert.deepEqual(fw.validateSelection('jest', { file: 'test/a.test.js; rm -rf /' }), {});
    assert.deepEqual(fw.validateSelection('jest', { file: 'test/$(id).test.js' }), {});
    assert.deepEqual(fw.validateSelection('jest', { name: 'line\ninjected' }), {});
  });

  test('[F3] unsafe Maven selections are dropped', () => {
    assert.deepEqual(fw.validateSelection('maven', { file: 'com.x.Test;touch /tmp/x', name: 'run' }), { name: 'run' });
    assert.deepEqual(fw.validateSelection('maven', { file: 'com.x.Test', name: 'a b' }), { file: 'com.x.Test' });
  });

  test('[F3] Jest test names are regex-escaped and passed as a single argv element', () => {
    const cmd = fw.testCommand('jest', { selection: { file: 'test/a.test.js', name: 'adds $(id) && `whoami` | .*' }, resultFile: '/work/.alibi/r.json' });
    const i = cmd.indexOf('-t');
    assert.ok(i > 0);
    assert.equal(cmd[i + 1], '^adds \\$\\(id\\) && `whoami` \\| \\.\\*$');
    assert.equal(cmd[0], 'node', 'runs node directly, not a shell');
  });

  test('[F3] a selection starting with "-" cannot be read as a CLI option', () => {
    const sel = fw.validateSelection('jest', { file: '--watchAll.js' });
    assert.equal(sel.file, undefined, `"--watchAll.js" accepted and passed to jest as ${JSON.stringify(fw.testCommand('jest', { selection: sel, resultFile: '/x' }))}`);
  });
});

describe('F: container arguments isolate untrusted code', () => {
  const spec = (over: Record<string, unknown> = {}) => ({ image: 'node:20-bookworm-slim', command: ['node', '--version'], workspace: '/tmp/ws', network: false, timeoutSec: 10, ...over });

  test('[F4] test runs get no network, no capabilities, a read-only root, a non-root user, and resource limits', () => {
    const a: string[] = docker.buildDockerArgs(spec(), 'qa');
    const pair = (flag: string) => a[a.indexOf(flag) + 1];
    assert.equal(pair('--network'), 'none');
    assert.equal(pair('--cap-drop'), 'ALL');
    assert.equal(pair('--security-opt'), 'no-new-privileges');
    assert.equal(pair('--user'), '1000:1000');
    assert.ok(a.includes('--read-only'));
    assert.equal(pair('--pids-limit'), '512');
    assert.ok(a.includes('--memory') && a.includes('--cpus'));
    assert.ok(!a.includes('--privileged'));
  });

  test('[F4] only the workspace and dependency cache are mounted; never the Docker socket', () => {
    const a: string[] = docker.buildDockerArgs(spec({ cacheDir: '/tmp/cache' }), 'qa');
    const mounts = a.filter((_, i) => a[i - 1] === '-v');
    assert.deepEqual(mounts, ['/tmp/ws:/work:rw', '/tmp/cache:/cache:rw']);
    assert.ok(!a.join(' ').includes('docker.sock'));
  });

  test('[F4] network access is opt-in per container (used only for the dependency install step)', () => {
    const a: string[] = docker.buildDockerArgs(spec({ network: true }), 'qa');
    assert.equal(a[a.indexOf('--network') + 1], 'bridge');
  });

  test('[F4] invalid environment variable names are refused', () => {
    for (const k of ['BAD KEY', 'A=B', '$(id)', '1START', '']) assert.throws(() => docker.buildDockerArgs(spec({ env: { [k]: 'v' } }), 'qa'), /invalid env key/i, JSON.stringify(k));
  });

  test('[F4] host secrets are not passed to containers', () => {
    const a: string[] = docker.buildDockerArgs(spec({ env: { NODE_OPTIONS: '--max-old-space-size=768' } }), 'qa');
    const envs = a.filter((_, i) => a[i - 1] === '-e').map((e) => e.split('=')[0]);
    assert.deepEqual(envs.sort(), ['CI', 'HOME', 'NODE_OPTIONS']);
  });
});

describe('F: clone sources and SHAs are validated before git runs', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const dir = () => join(qaEnv().runDir, 'scratch', `clone-${Date.now()}`);
  for (const loc of ['file:///etc', 'git@github.com:qa-org/x.git', 'https://evil.example/qa-org/x', 'https://github.com/qa-org/x/../../y', 'ext::sh -c touch% /tmp/qa-pwned', '/tmp/../etc', 'relative/path']) {
    test(`[F5] refuses to clone from ${JSON.stringify(loc)}`, async () => {
      await assert.rejects(ws.checkout({ location: loc, cacheKey: 'qa' }, sha, dir()), /Refusing to clone/);
    });
  }
  for (const bad of ['--upload-pack=touch /tmp/qa', 'HEAD', 'main', 'abc', `${sha};id`]) {
    test(`[F5] refuses the commit ${JSON.stringify(bad)}`, async () => {
      await assert.rejects(ws.checkout({ location: '/tmp/x', cacheKey: 'qa' }, bad, dir()), /Invalid commit SHA/);
    });
  }
});
