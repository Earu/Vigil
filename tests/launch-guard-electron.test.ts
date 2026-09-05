import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { createRequire } from 'module';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DEBUG_SWITCHES } from '../electron/src/launch-guard';

// Electron puts switches of its own on every command line
// (--allow-file-access-from-files, for one). A denylist entry that names one
// of them refuses every launch of the packaged app, which the mocked unit
// tests cannot see. This starts the real binary and asks it

const require = createRequire(import.meta.url);

function probe(): Promise<{ present: string[]; stderr: string; code: number | null }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-guard-probe-'));
    const script = path.join(dir, 'probe.cjs');
    fs.writeFileSync(script, `
        const { app } = require('electron');
        const list = JSON.parse(process.env.VIGIL_PROBE_SWITCHES);
        process.stdout.write(JSON.stringify(list.filter(name => app.commandLine.hasSwitch(name))) + '\\n');
        app.exit(0);
    `);
    const env = { ...process.env, VIGIL_PROBE_SWITCHES: JSON.stringify(DEBUG_SWITCHES) };
    // Set by the test runner's own parent process on some setups; with it the
    // binary runs as plain Node and app is undefined
    delete env.ELECTRON_RUN_AS_NODE;
    const electron = require('electron') as string;
    return new Promise((resolve, reject) => {
        const child = spawn(electron, ['--no-sandbox', '--ozone-platform=headless', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', code => {
            fs.rmSync(dir, { recursive: true, force: true });
            const line = stdout.trim().split('\n').pop() ?? '[]';
            try {
                resolve({ present: JSON.parse(line), stderr, code });
            } catch {
                reject(new Error(`probe printed no list; stdout: ${stdout}\nstderr: ${stderr}`));
            }
        });
    });
}

describe('the denylist against a real Electron launch', () => {
    it('names nothing Electron sets by itself', async () => {
        const result = await probe();
        expect(result.code).toBe(0);
        expect(result.present).toEqual([]);
    }, 60_000);
});
