// Boot smoke test for a packaged build: launches the binary, waits for the
// unlock screen and makes one IPC round trip from the real renderer.
//
// The unit tests mock every Electron module and the typecheck cannot see a
// main-process failure that only happens at runtime, so a build that dies
// before its first window passes both. This is the check that catches that:
// it runs the bytes that ship, with a throwaway config dir, and fails unless
// the window exists, the page rendered and the bridge answered.
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

const TIMEOUT_MS = 60_000;

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

async function waitForPage(port, deadline) {
    while (Date.now() < deadline) {
        try {
            const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
            const page = targets.find(t => t.type === 'page' && t.url);
            if (page) return page;
        } catch { /* not listening yet */ }
        await sleep(250);
    }
    throw new Error('no renderer page appeared before the deadline');
}

async function connect(page) {
    const ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let nextId = 0;
    const pending = new Map();
    ws.onmessage = (event) => {
        const message = JSON.parse(event.data);
        if (message.id && pending.has(message.id)) {
            pending.get(message.id)(message);
            pending.delete(message.id);
        }
    };
    const evaluate = async (expression) => {
        const id = ++nextId;
        const reply = await new Promise((resolve) => {
            pending.set(id, resolve);
            ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        });
        if (reply.result?.exceptionDetails) {
            throw new Error(`renderer threw: ${reply.result.exceptionDetails.exception?.description ?? 'exception'}`);
        }
        return reply.result?.result?.value;
    };
    return { evaluate, close: () => ws.close() };
}

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const ownArgs = separator === -1 ? argv : argv.slice(0, separator);
const extraArgs = separator === -1 ? [] : argv.slice(separator + 1);

const binary = findBinary(ownArgs[0]);
const configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-smoke-'));
const port = await freePort();

// ELECTRON_RUN_AS_NODE would turn the binary into a Node interpreter and
// NODE_ENV=development would point a dev build at a Vite server; neither
// belongs in a test of the packaged app
const env = { ...process.env, XDG_CONFIG_HOME: configHome };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ATTACH_CONSOLE;
delete env.NODE_ENV;

const child = spawn(binary, [`--remote-debugging-port=${port}`, '--no-sandbox', ...extraArgs], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
});
const output = [];
child.stdout.on('data', chunk => output.push(chunk));
child.stderr.on('data', chunk => output.push(chunk));
let exit = null;
child.on('exit', (code, signal) => { exit = { code, signal }; });

const failures = [];
const check = (name, ok, detail = '') => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
    if (!ok) failures.push(name);
};

try {
    const deadline = Date.now() + TIMEOUT_MS;
    const page = await waitForPage(port, deadline);
    check('window created', true, page.url);
    check('renderer shows the packaged document', /^file:.*\/index\.html/.test(page.url), page.url);

    const session = await connect(page);
    try {
        // The unlock screen paints something under #root once React mounts;
        // give it a moment past navigation
        let rendered = false;
        while (!rendered && Date.now() < deadline) {
            rendered = await session.evaluate('!!document.querySelector("#root *")');
            if (!rendered) await sleep(250);
        }
        check('unlock screen rendered', rendered);
        check('preload bridge present', await session.evaluate('typeof window.electron') === 'object');
        const platform = await session.evaluate('window.electron.getPlatform()');
        check('IPC round trip', platform === process.platform, String(platform));
    } finally {
        session.close();
    }

    const logFile = path.join(configHome, 'Vigil', 'logs', 'main.log');
    const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    const errors = log.split('\n').filter(line => /\[error\]/.test(line));
    check('no errors logged', errors.length === 0, errors.join(' | '));
    check('process still alive', exit === null, exit ? JSON.stringify(exit) : '');
} catch (error) {
    check('smoke run', false, error instanceof Error ? error.message : String(error));
} finally {
    if (exit === null) child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => child.on('exit', resolve)), sleep(5000)]);
    if (exit === null) child.kill('SIGKILL');
    fs.rmSync(configHome, { recursive: true, force: true });
}

if (failures.length > 0) {
    console.log('\n--- app output ---');
    console.log(Buffer.concat(output).toString('utf8').trim());
    console.log(`\nsmoke test failed: ${failures.join(', ')}`);
    process.exit(1);
}
console.log('smoke test passed');
