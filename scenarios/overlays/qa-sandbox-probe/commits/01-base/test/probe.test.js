'use strict';
const fs = require('fs');
const net = require('net');
const dns = require('dns');

const read = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch (e) {
    return `error:${e.code}`;
  }
};

function tcp(host, port) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port, timeout: 2500 });
    s.on('connect', () => {
      s.destroy();
      resolve('connected');
    });
    s.on('timeout', () => {
      s.destroy();
      resolve('timeout');
    });
    s.on('error', (e) => resolve(e.code || 'error'));
  });
}

function lookup(name) {
  return new Promise((resolve) => dns.lookup(name, (err) => resolve(err ? err.code || 'error' : 'resolved')));
}

function tryWrite(p) {
  try {
    fs.writeFileSync(p, 'qa-probe');
    fs.unlinkSync(p);
    return 'written';
  } catch (e) {
    return e.code || 'error';
  }
}

test('isolation probe', async () => {
  const status = read('/proc/self/status');
  const report = {
    uid: process.getuid(),
    gid: process.getgid(),
    capEff: (/CapEff:\s*([0-9a-f]+)/.exec(status) || [])[1] || null,
    noNewPrivs: (/NoNewPrivs:\s*(\d)/.exec(status) || [])[1] || null,
    rootFsWrite: tryWrite('/qa-probe-root-write'),
    etcWrite: tryWrite('/etc/qa-probe'),
    tmpWrite: tryWrite('/tmp/qa-probe'),
    workWrite: tryWrite('/work/.qa-probe-write'),
    dockerSocket: fs.existsSync('/var/run/docker.sock') || fs.existsSync('/run/docker.sock'),
    hostUsersDir: fs.existsSync('/Users'),
    envNames: Object.keys(process.env).sort(),
    envValuesWithQaMarkers: Object.values(process.env).filter((v) => /qa-host-canary|qa-mock-/.test(String(v))).length,
    preinstallRan: fs.existsSync('/work/.qa-preinstall-ran'),
    memoryMax: read('/sys/fs/cgroup/memory.max'),
    pidsMax: read('/sys/fs/cgroup/pids.max'),
    tcpExternal: await tcp('1.1.1.1', 443),
    dnsExternal: await lookup('registry.npmjs.org'),
  };
  process.stderr.write(`\nQA_PROBE_RESULT ${JSON.stringify(report)}\n`);
  throw new Error('probe complete (intentional failure so the CI run is red)');
});
