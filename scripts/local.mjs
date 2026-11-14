import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const childEnv = { ...process.env };
// Local RPC must not go through an outbound HTTP proxy.
const bypass = [childEnv.NO_PROXY || childEnv.no_proxy || '', 'localhost', '127.0.0.1', '0.0.0.0', '::1'].filter(Boolean).join(',');
childEnv.NO_PROXY = bypass;
childEnv.no_proxy = bypass;
if (process.platform === 'linux') {
  const hard = execFileSync('sh', ['-c', 'ulimit -H -n'], { encoding: 'utf8' }).trim();
  if (hard !== 'unlimited' && Number(hard) < 65535) {
    const build = fileURLToPath(new URL('../.sandbox/compat/', import.meta.url));
    const source = fileURLToPath(new URL('./compat/nofile.c', import.meta.url));
    mkdirSync(build, { recursive: true });
    const output = `${build}nofile.so`;
    execFileSync(process.env.CC || 'cc', ['-shared', '-fPIC', '-O2', '-o', output, source, '-ldl']);
    childEnv.LD_PRELOAD = [output, childEnv.LD_PRELOAD].filter(Boolean).join(':');
    console.log(`[local NEAR] Keeping the host's ${hard}-file hard limit; applying startup compatibility wrapper.`);
  }
}
const child = spawn(process.execPath, process.argv.slice(2), { env: childEnv, stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('exit', (code, signal) => { if (signal) process.kill(process.pid, signal); else process.exitCode = code; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
