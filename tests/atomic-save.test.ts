import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('electron', () => ({
    app: { getPath: () => os.tmpdir() },
    dialog: {},
    BrowserWindow: { getAllWindows: () => [] },
}));

const { saveToFile, statFile } = await import('../electron/src/file-operations');

describe('atomic database writes', () => {
    let dir: string;
    let target: string;

    beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigil-atomic-'));
        target = path.join(dir, 'vault.kdbx');
    });

    afterAll(() => {
        fs.chmodSync(dir, 0o755);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('writes and overwrites without leaving temp files', async () => {
        expect((await saveToFile(target, Buffer.from('version-1'))).success).toBe(true);
        expect(fs.readFileSync(target).toString()).toBe('version-1');

        expect((await saveToFile(target, Buffer.from('version-2-longer-content'))).success).toBe(true);
        expect(fs.readFileSync(target).toString()).toBe('version-2-longer-content');
        expect(fs.readdirSync(dir)).toHaveLength(1);
    });

    it('leaves the original intact when the write fails', async () => {
        fs.chmodSync(dir, 0o555); // temp file creation in the target dir must fail
        const result = await saveToFile(target, Buffer.from('should-never-land'));
        fs.chmodSync(dir, 0o755);

        expect(result.success).toBe(false);
        expect(fs.readFileSync(target).toString()).toBe('version-2-longer-content');
        expect(fs.readdirSync(dir)).toHaveLength(1);
    });

    // The temp name is random and the open is exclusive ('wx'): in a
    // directory another user can write to, a predictable name plus 'w' let a
    // pre-planted symlink capture the vault bytes and, after the rename, the
    // vault file itself
    it('refuses to write through anything pre-planted at the temp path', async () => {
        const cryptoMod = (await import('crypto')).default;
        const fixed = Buffer.from('0123456789abcdef', 'hex');
        const spy = vi.spyOn(cryptoMod, 'randomBytes').mockReturnValue(fixed as any);
        const planted = path.join(dir, `.vault.kdbx.tmp-${fixed.toString('hex')}`);
        fs.writeFileSync(planted, 'attacker-owned');

        const result = await saveToFile(target, Buffer.from('should-never-land'));
        spy.mockRestore();

        expect(result.success).toBe(false);
        expect(fs.readFileSync(planted, 'utf8')).toBe('attacker-owned');
        expect(fs.readFileSync(target).toString()).toBe('version-2-longer-content');
        fs.unlinkSync(planted);
    });

    it('retries under a fresh name when the random one collides', async () => {
        const cryptoMod = (await import('crypto')).default;
        const real = cryptoMod.randomBytes.bind(cryptoMod);
        const fixed = Buffer.from('feedfacefeedface', 'hex');
        const spy = vi.spyOn(cryptoMod, 'randomBytes')
            .mockImplementationOnce((() => fixed) as any)
            .mockImplementation(((size: number) => real(size)) as any);
        const planted = path.join(dir, `.vault.kdbx.tmp-${fixed.toString('hex')}`);
        fs.writeFileSync(planted, 'attacker-owned');

        const result = await saveToFile(target, Buffer.from('lands-on-retry'));
        spy.mockRestore();

        expect(result.success).toBe(true);
        expect(fs.readFileSync(target).toString()).toBe('lands-on-retry');
        expect(fs.readFileSync(planted, 'utf8')).toBe('attacker-owned');
        fs.unlinkSync(planted);
        // Restore the content later tests expect
        await saveToFile(target, Buffer.from('version-2-longer-content'));
    });

    it('stats files and fails cleanly on missing ones', async () => {
        const stat = await statFile(target);
        expect(stat.success).toBe(true);
        expect(typeof stat.mtimeMs).toBe('number');
        expect(stat.size).toBe('version-2-longer-content'.length);

        expect((await statFile(path.join(dir, 'nope.kdbx'))).success).toBe(false);
    });

    it('survives rapid large save cycles with every read complete', async () => {
        const big = (n: number) => Buffer.alloc(4 * 1024 * 1024, n);
        for (let i = 0; i < 5; i++) {
            await saveToFile(target, big(i));
            const readBack = fs.readFileSync(target);
            expect(readBack.length).toBe(big(i).length);
            expect(readBack[0]).toBe(i);
            expect(readBack[readBack.length - 1]).toBe(i);
        }
        expect(fs.readdirSync(dir)).toHaveLength(1);
    });
});
