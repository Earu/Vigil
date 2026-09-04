// Boot smoke test for a packaged build: two launches of the bytes that ship.
//
// 1. With --remote-debugging-port. A packaged build refuses debugging
//    switches (electron/src/launch-guard.ts): the process has to exit
//    non-zero, and the port must never answer.
// 2. With --smoke-boot (electron/src/smoke-boot.ts). The app opens its first
//    window, evaluates a fixed set of checks in the real renderer, prints
//    them as one JSON line and exits. This replaced attaching over the
//    debugging port, which launch 1 proves is no longer possible.
//
// The unit tests mock every Electron module and the typecheck cannot see a
// main-process failure that only happens at runtime, so a build that dies
// before its first window passes both. This is the check that catches that:
// it runs with a throwaway config dir and fails unless the window exists,
// the page rendered and the bridge answered.
//
//     node scripts/smoke-boot.mjs [binary] [-- extra electron args]
//
// On a headless runner wrap it in xvfb-run and pass --ozone-platform=x11.
// The binary defaults to the Linux unpacked output of electron-builder.

import { spawn } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

const BOOT_TIMEOUT_MS = 60_000;
const REFUSAL_TIMEOUT_MS = 15_000;

function findBinary(explicit) {
    if (explicit) return explicit;
    const dist = path.resolve('dist');
    const candidates = fs.existsSync(dist)
        ? fs.readdirSync(dist)
            .filter(name => /^linux(-\w+)?-unpacked$/.test(name))
            .map(name => path.join(dist, name, 'vigil'))
            .filter(file => fs.existsSync(file))
        : [];
    if (candidates.length === 0) {
        throw new Error('no packaged binary: pass its path, or build with electron-builder first');
    }
    return candidates[0];
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function portAnswers(port) {
    try {
        await fetch(`http://127.0.0.1:${port}/json`);
        return true;
    } catch {
        return false;
    }
}

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const ownArgs = separator === -1 ? argv : argv.slice(0, separator);
const extraArgs = separator === -1 ? [] : argv.slice(separator + 1);

const binary = findBinary(ownArgs[0]);
const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-smoke-'));

// ELECTRON_RUN_AS_NODE would turn the binary into a Node interpreter and
// NODE_ENV=development would point a dev build at a Vite server; neither
// belongs in a test of the packaged app
const env = { ...process.env, XDG_CONFIG_HOME: configHome };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.NODE_ENV;

// Runs the binary until it exits or the deadline passes, then kills it.
// `during` is polled while it runs, for things that must hold the whole time
async function launch(args, { timeoutMs, until = () => false, during = async () => {} }) {
    const child = spawn(binary, [...args, '--no-sandbox', ...extraArgs], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    let exit = null;
    child.on('exit', (code, signal) => { exit = { code, signal }; });

    const deadline = Date.now() + timeoutMs;
    const text = () => ({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') });
    while (exit === null && Date.now() < deadline && !until(text())) {
        await during();
        await sleep(250);
    }
    if (exit === null) {
        // Give a process that has printed its report a moment to exit on
        // its own before taking it down
        const grace = Date.now() + 5000;
        while (exit === null && Date.now() < grace) await sleep(100);
    }
    if (exit === null) child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.on('exit', resolve)), sleep(5000)]);
    if (exit === null) child.kill('SIGKILL');
    return { exit, ...text() };
}

const failures = [];
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(name);
};

const output = [];
try {
    // 1. Debugging switches are refused
    const port = await freePort();
    let answered = false;
    const refusal = await launch([`--remote-debugging-port=${port}`], {
        timeoutMs: REFUSAL_TIMEOUT_MS,
        during: async () => { if (!answered) answered = await portAnswers(port); },
    });
    output.push(refusal.stdout, refusal.stderr);
    check('refuses --remote-debugging-port', refusal.exit?.code === 1, JSON.stringify(refusal.exit));
    check('says why on stderr', /refusing to start with --remote-debugging-port/.test(refusal.stderr), refusal.stderr.trim().split('\n').pop() ?? '');
    check('debug port never answered', !answered && !(await portAnswers(port)));

    // 2. The app boots and the renderer answers
    const boot = await launch(['--smoke-boot'], {
        timeoutMs: BOOT_TIMEOUT_MS,
        until: ({ stdout }) => /^smoke-boot /m.test(stdout),
    });
    output.push(boot.stdout, boot.stderr);
    const line = boot.stdout.split('\n').find(l => l.startsWith('smoke-boot '));
    check('window created and reported', !!line, line ?? '(no report)');
    const report = line ? JSON.parse(line.slice('smoke-boot '.length)) : {};
    check('renderer shows the packaged document', /^vigil:\/\/app\/index\.html/.test(report.url ?? ''), report.url ?? '');
    check('unlock screen rendered', report.rendered === true, report.error ?? '');
    check('preload bridge present', report.bridge === 'object', String(report.bridge));
    check('IPC round trip', report.platform === process.platform, String(report.platform));
    check('localStorage works on the app origin', report.storage === true, String(report.storage));
    check('exited cleanly', boot.exit?.code === 0, JSON.stringify(boot.exit));

    const logFile = path.join(configHome, 'Vigil', 'logs', 'main.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const errors = log.split('\n').filter(l => /\[error\]/.test(l));
    check('no errors logged', errors.length === 0, errors.join(' | '));
} catch (error) {
    check('smoke run', false, error instanceof Error ? error.message : String(error));
} finally {
    fs.rmSync(configHome, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.log('\n--- app output ---');
    console.log(output.join('\n').trim());
    console.log(`\nsmoke test failed: ${failures.join(', ')}`);
    process.exit(1);
}
console.log('smoke test passed');
