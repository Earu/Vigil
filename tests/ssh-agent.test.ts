import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn, execFileSync, ChildProcess } from 'child_process';

// Against a real ssh-agent, started on a scratch socket so the user's own
// agent is never touched. ssh-add -l is the reference for what the agent
// holds after each step.

vi.mock('electron', () => ({ BrowserWindow: class {} }));

const {
    setSocketPathOverride, isAgentRunning, listIdentities, addIdentity, removeIdentity,
    addKeyForWindow, releaseWindow, loadedFingerprints, resetLoadedForTests,
} = await import('../electron/src/ssh-agent');
const { parsePrivateKey } = await import('../electron/src/ssh-key');

const FIXTURES = path.join(__dirname, 'fixtures', 'ssh');
const load = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(FIXTURES, name)));
const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf8'));

const hasAgent = (() => {
    try {
        execFileSync('ssh-agent', ['-h'], { stdio: 'ignore' });
    } catch (error) {
        // -h is not an option; the point is that the binary ran
        return (error as { status?: number }).status !== undefined;
    }
    return true;
})();

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-agent-'));
const sock = path.join(tmp, 'agent.sock');
let agent: ChildProcess | undefined;

const sshAddList = (): string[] => {
    try {
        return execFileSync('ssh-add', ['-l', '-E', 'sha256'], { env: { ...process.env, SSH_AUTH_SOCK: sock } })
            .toString().trim().split('\n').filter(Boolean);
    } catch (error) {
        const out = (error as { stdout?: Buffer }).stdout?.toString() ?? '';
        if (/no identities/i.test(out)) return [];
        throw error;
    }
};

const fakeWindow = (id: number): any => ({ id });

describe.skipIf(!hasAgent)('the ssh-agent client', () => {
    beforeAll(async () => {
        agent = spawn('ssh-agent', ['-D', '-a', sock], { stdio: 'ignore' });
        for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise(r => setTimeout(r, 20));
        setSocketPathOverride(sock);
    });

    afterAll(() => {
        agent?.kill();
        setSocketPathOverride(null);
        fs.rmSync(tmp, { recursive: true, force: true });
    });

    beforeEach(async () => {
        resetLoadedForTests();
        for (const identity of await listIdentities()) {
            // listIdentities has no blob; ssh-add -D empties the agent
            void identity;
        }
        execFileSync('ssh-add', ['-D'], { env: { ...process.env, SSH_AUTH_SOCK: sock }, stdio: 'ignore' });
    });

    it('sees the agent and an empty key list', async () => {
        expect(await isAgentRunning()).toBe(true);
        expect(await listIdentities()).toEqual([]);
    });

    it('adds a key the agent then lists under the fingerprint ssh-keygen printed, and removes it', async () => {
        const key = parsePrivateKey(load('ed25519_enc'), 'correct horse');
        await addIdentity(key, { comment: 'from vigil' });

        expect(sshAddList()).toHaveLength(1);
        expect(sshAddList()[0]).toContain(manifest.ed25519_enc.fingerprint);
        expect(sshAddList()[0]).toContain('from vigil');
        expect(await listIdentities()).toEqual([{ type: 'ssh-ed25519', fingerprint: manifest.ed25519_enc.fingerprint, comment: 'from vigil' }]);

        expect(await removeIdentity(key.publicBlob)).toBe(true);
        expect(sshAddList()).toEqual([]);
    });

    it('adds every supported key type', async () => {
        for (const [name, passphrase] of [['rsa_pem', ''], ['ecdsa256_enc', 'correct horse'], ['ecdsa384_pem', ''], ['rsa_openssh', '']] as const) {
            const key = parsePrivateKey(load(name), passphrase);
            await addIdentity(key, { comment: name });
        }
        const listed = sshAddList();
        expect(listed).toHaveLength(4);
        for (const name of ['rsa_pem', 'ecdsa256_enc', 'ecdsa384_pem', 'rsa_openssh']) {
            expect(listed.some(line => line.includes(manifest[name].fingerprint))).toBe(true);
        }
    });

    it('passes lifetime and confirm constraints through', async () => {
        const key = parsePrivateKey(load('ed25519_plain'));
        await addIdentity(key, { comment: 'constrained', lifetimeSeconds: 600, confirm: true });
        expect(sshAddList()[0]).toContain(manifest.ed25519_plain.fingerprint);
    });

    it('takes a window\'s keys out on release, unless another window still holds them', async () => {
        const shared = parsePrivateKey(load('ed25519_plain'));
        const own = parsePrivateKey(load('rsa_pem'));
        await addKeyForWindow(fakeWindow(1), shared, { comment: 'shared' }, true);
        await addKeyForWindow(fakeWindow(2), shared, { comment: 'shared' }, true);
        await addKeyForWindow(fakeWindow(1), own, { comment: 'own' }, true);
        expect(loadedFingerprints().sort()).toEqual([shared.fingerprint, own.fingerprint].sort());

        expect(await releaseWindow(1)).toEqual([own.fingerprint]);
        expect(sshAddList()).toHaveLength(1);
        expect(sshAddList()[0]).toContain(shared.fingerprint);

        expect(await releaseWindow(2)).toEqual([shared.fingerprint]);
        expect(sshAddList()).toEqual([]);
        expect(loadedFingerprints()).toEqual([]);
    });

    it('leaves a key in the agent when the entry asked for that', async () => {
        const key = parsePrivateKey(load('ed25519_plain'));
        await addKeyForWindow(fakeWindow(1), key, { comment: 'stays' }, false);
        expect(await releaseWindow(1)).toEqual([]);
        expect(sshAddList()).toHaveLength(1);
        expect(loadedFingerprints()).toEqual([]);
    });

    it('reports a dead socket instead of hanging', async () => {
        setSocketPathOverride(path.join(tmp, 'nowhere.sock'));
        try {
            expect(await isAgentRunning()).toBe(false);
            await expect(listIdentities()).rejects.toThrow(/connection failed/);
        } finally {
            setSocketPathOverride(sock);
        }
    });
});
