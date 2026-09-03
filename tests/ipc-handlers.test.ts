import { describe, it, expect, beforeEach, vi } from 'vitest';

// The IPC layer is where renderer input crosses into the main process, so
// what matters here is the wiring: which channels are gated behind a path
// grant, what the failure shapes look like, and that a denied call never
// reaches the module behind it.

const handlers = new Map<string, (...args: any[]) => any>();
const listeners = new Map<string, (...args: any[]) => any>();
const fromWebContents = vi.fn();

vi.mock('electron', () => ({
    ipcMain: {
        handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn); },
        on: (channel: string, fn: (...args: any[]) => any) => { listeners.set(channel, fn); },
    },
    BrowserWindow: { fromWebContents: (...args: any[]) => fromWebContents(...args) },
    Notification: class {
        constructor(public readonly options: unknown) {}
        show(): void {}
    },
    app: {},
    desktopCapturer: { getSources: vi.fn() },
    screen: { getAllDisplays: vi.fn(() => []) },
}));

vi.mock('../electron/src/window', () => ({
    findVaultWindow: vi.fn(),
    registerVault: vi.fn(),
    unregisterWindow: vi.fn(),
    focusWindow: vi.fn(),
    setUnsavedChanges: vi.fn(),
}));

vi.mock('../electron/src/crypto', () => ({
    hashPassword: vi.fn(),
}));

vi.mock('../electron/src/utils', () => ({
    openExternal: vi.fn(),
    getPlatform: vi.fn(() => 'linux'),
    getAppIconPath: vi.fn(() => '/icon.png'),
}));

vi.mock('../electron/src/clipboard', () => ({
    clearClipboard: vi.fn(),
    copySecret: vi.fn(),
}));

vi.mock('../electron/src/file-operations', () => ({
    saveFile: vi.fn(),
    saveToFile: vi.fn(),
    saveAttachment: vi.fn(),
    registerDroppedVault: vi.fn(),
    openFile: vi.fn(),
    readFile: vi.fn(),
    selectKeyFile: vi.fn(),
    statFile: vi.fn(),
    loadLastDatabasePath: vi.fn(),
    saveLastDatabasePath: vi.fn(),
}));

vi.mock('../electron/src/biometrics', () => ({
    isBiometricsAvailable: vi.fn(),
    getBiometricsInfo: vi.fn(),
    hasBiometricsEnabled: vi.fn(),
    enableBiometrics: vi.fn(),
    getBiometricPassword: vi.fn(),
    disableBiometrics: vi.fn(),
}));

vi.mock('../electron/src/hibp', () => ({
    checkEmailBreaches: vi.fn(),
}));

vi.mock('../electron/src/content-protection', () => ({
    isSupported: vi.fn(() => true),
    isContentProtectionEnabled: vi.fn(() => false),
    setContentProtectionEnabled: vi.fn(),
}));

vi.mock('../electron/src/hardware-key', () => ({
    listHardwareKeys: vi.fn(),
    hardwareKeyChallenge: vi.fn(),
    hardwareKeyPresent: vi.fn(),
}));

// A sentinel object so the defaulting tests can assert the exact reference
const DEFAULT_BACKUP_SENTINEL = { enabled: true, keep: 5, sentinel: true };
vi.mock('../electron/src/backups', () => ({
    DEFAULT_BACKUP_OPTIONS: DEFAULT_BACKUP_SENTINEL,
    getBackupInfo: vi.fn(),
    revealBackups: vi.fn(),
}));

vi.mock('../electron/src/logger', () => ({
    logRendererError: vi.fn(),
    revealLogs: vi.fn(),
}));

vi.mock('../electron/src/path-authority', () => ({
    isPathGranted: vi.fn(() => false),
}));

const windowMod = await import('../electron/src/window');
const crypto = await import('../electron/src/crypto');
const fileOps = await import('../electron/src/file-operations');
const biometrics = await import('../electron/src/biometrics');
const hardwareKey = await import('../electron/src/hardware-key');
const backups = await import('../electron/src/backups');
const logger = await import('../electron/src/logger');
const authority = await import('../electron/src/path-authority');

const { setupIpcHandlers } = await import('../electron/src/ipc');
setupIpcHandlers();

const isPathGranted = vi.mocked(authority.isPathGranted);
const hashPassword = vi.mocked(crypto.hashPassword);
const challenge = vi.mocked(hardwareKey.hardwareKeyChallenge);

function makeEvent() {
    return {
        sender: {
            isDestroyed: () => false,
            once: vi.fn(),
            off: vi.fn(),
            send: vi.fn(),
        },
    };
}

function invoke(channel: string, ...args: any[]) {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`no handler registered for ${channel}`);
    return handler(makeEvent(), ...args);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
    vi.clearAllMocks();
    isPathGranted.mockReturnValue(false);
    fromWebContents.mockReturnValue(null);
});

describe('path grant gating', () => {
    // Each gated channel derives a filesystem location (or a stored secret)
    // from a renderer-supplied path, so a compromised renderer must get the
    // failure shape back and the module behind the gate must never run
    const gated: Array<{
        channel: string;
        args: any[];
        denied: unknown;
        target: () => ReturnType<typeof vi.fn>;
    }> = [
        {
            channel: 'save-to-file',
            args: ['/vault.kdbx', new Uint8Array([1])],
            denied: { success: false, error: 'Failed to save file' },
            target: () => vi.mocked(fileOps.saveToFile),
        },
        {
            channel: 'get-backup-info',
            args: ['/vault.kdbx'],
            denied: { directory: '', count: 0, newest: null, totalBytes: 0 },
            target: () => vi.mocked(backups.getBackupInfo),
        },
        {
            channel: 'reveal-backups',
            args: ['/vault.kdbx'],
            denied: { success: false, error: 'Unknown database path' },
            target: () => vi.mocked(backups.revealBackups),
        },
        {
            channel: 'read-file',
            args: ['/etc/passwd'],
            denied: { success: false, error: 'Failed to read file' },
            target: () => vi.mocked(fileOps.readFile),
        },
        {
            channel: 'stat-file',
            args: ['/etc/passwd'],
            denied: { success: false, error: 'Failed to stat file' },
            target: () => vi.mocked(fileOps.statFile),
        },
        {
            channel: 'save-last-database-path',
            args: ['/vault.kdbx'],
            denied: false,
            target: () => vi.mocked(fileOps.saveLastDatabasePath),
        },
        {
            channel: 'has-biometrics-enabled',
            args: ['/vault.kdbx'],
            denied: { success: false, enabled: false, error: 'Unknown database path' },
            target: () => vi.mocked(biometrics.hasBiometricsEnabled),
        },
        {
            channel: 'enable-biometrics',
            args: ['/vault.kdbx', 'hunter2'],
            denied: { success: false, error: 'Unknown database path' },
            target: () => vi.mocked(biometrics.enableBiometrics),
        },
        {
            channel: 'get-biometric-password',
            args: ['/vault.kdbx'],
            denied: { success: false, error: 'Unknown database path' },
            target: () => vi.mocked(biometrics.getBiometricPassword),
        },
        {
            channel: 'disable-biometrics',
            args: ['/vault.kdbx'],
            denied: { success: false, error: 'Unknown database path' },
            target: () => vi.mocked(biometrics.disableBiometrics),
        },
    ];

    it.each(gated)('$channel refuses an ungranted path without touching the module', async ({ channel, args, denied, target }) => {
        expect(await invoke(channel, ...args)).toEqual(denied);
        expect(target()).not.toHaveBeenCalled();
    });

    it.each(gated)('$channel forwards a granted path', async ({ channel, args, target }) => {
        isPathGranted.mockReturnValue(true);
        const result = { forwarded: channel };
        target().mockResolvedValue(result as never);
        expect(await invoke(channel, ...args)).toBe(result);
        expect(target()).toHaveBeenCalledTimes(1);
        expect(target().mock.calls[0][0]).toBe(args[0]);
    });
});

describe('renderer-log-error', () => {
    const log = () => vi.mocked(logger.logRendererError);
    const emit = (payload: unknown) => listeners.get('renderer-log-error')!(makeEvent(), payload);

    it('ignores anything that is not a string', () => {
        emit(42);
        emit(null);
        emit({ message: 'boom' });
        emit(undefined);
        expect(log()).not.toHaveBeenCalled();
    });

    it('caps the message at 8192 characters', () => {
        emit('x'.repeat(9000));
        expect(log()).toHaveBeenCalledWith('x'.repeat(8192));
    });

    it('passes a short message through unchanged', () => {
        emit('renderer exploded');
        expect(log()).toHaveBeenCalledWith('renderer exploded');
    });
});

describe('vault-opened', () => {
    const findVaultWindow = vi.mocked(windowMod.findVaultWindow);
    const registerVault = vi.mocked(windowMod.registerVault);
    const focusWindow = vi.mocked(windowMod.focusWindow);

    it('registers nothing without a sender window', async () => {
        fromWebContents.mockReturnValue(null);
        expect(await invoke('vault-opened', '/vault.kdbx')).toEqual({ duplicate: false });
        expect(registerVault).not.toHaveBeenCalled();
    });

    it('registers nothing for an empty path', async () => {
        fromWebContents.mockReturnValue({ id: 1 });
        expect(await invoke('vault-opened', '')).toEqual({ duplicate: false });
        expect(registerVault).not.toHaveBeenCalled();
    });

    it('reports a duplicate and focuses the window that already has the vault', async () => {
        const mine = { id: 1 };
        const theirs = { id: 2 };
        fromWebContents.mockReturnValue(mine);
        findVaultWindow.mockReturnValue(theirs as never);
        expect(await invoke('vault-opened', '/vault.kdbx')).toEqual({ duplicate: true });
        expect(focusWindow).toHaveBeenCalledWith(theirs);
        expect(registerVault).not.toHaveBeenCalled();
    });

    it('re-registering from the window that owns the vault is no duplicate', async () => {
        const mine = { id: 1 };
        fromWebContents.mockReturnValue(mine);
        findVaultWindow.mockReturnValue(mine as never);
        expect(await invoke('vault-opened', '/vault.kdbx')).toEqual({ duplicate: false });
        expect(registerVault).toHaveBeenCalledWith('/vault.kdbx', mine);
    });

    it('registers a vault nobody else has open', async () => {
        const mine = { id: 1 };
        fromWebContents.mockReturnValue(mine);
        findVaultWindow.mockReturnValue(undefined);
        expect(await invoke('vault-opened', '/vault.kdbx')).toEqual({ duplicate: false });
        expect(registerVault).toHaveBeenCalledWith('/vault.kdbx', mine);
        expect(focusWindow).not.toHaveBeenCalled();
    });
});

describe('hardware-key-challenge', () => {
    const handler = () => handlers.get('hardware-key-challenge')!;
    const bytes = new Uint8Array([1, 2, 3]).buffer;

    it('returns the response on success', async () => {
        const response = new Uint8Array(20);
        challenge.mockResolvedValue(response);
        expect(await handler()(makeEvent(), 123, 2, bytes)).toEqual({ success: true, response });
    });

    it('returns the error message on failure', async () => {
        challenge.mockRejectedValue(new Error('no key present'));
        expect(await handler()(makeEvent(), null, 2, bytes)).toEqual({ success: false, error: 'no key present' });
    });

    it('passes the challenge as bytes and coerces any slot but 1 to 2', async () => {
        challenge.mockResolvedValue(new Uint8Array(20));
        await handler()(makeEvent(), 123, 1, bytes);
        await handler()(makeEvent(), 123, 2, bytes);
        await handler()(makeEvent(), 123, 7, bytes);
        expect(challenge.mock.calls.map(call => call[1])).toEqual([1, 2, 2]);
        expect(challenge.mock.calls[0][2]).toEqual(new Uint8Array([1, 2, 3]));
    });

    // The touch prompt in the renderer opens on 'hardware-key-touch' and only
    // 'hardware-key-touch-done' closes it, so the pair must always balance
    it('signals touch and then touch-done on success', async () => {
        challenge.mockImplementation(async (_serial, _slot, _bytes, onTouch) => {
            onTouch?.();
            return new Uint8Array(20);
        });
        const event = makeEvent();
        await handler()(event, 123, 2, bytes);
        expect(event.sender.send.mock.calls).toEqual([
            ['hardware-key-touch'],
            ['hardware-key-touch-done'],
        ]);
    });

    it('still sends touch-done when the challenge fails after touch', async () => {
        challenge.mockImplementation(async (_serial, _slot, _bytes, onTouch) => {
            onTouch?.();
            throw new Error('touch timed out');
        });
        const event = makeEvent();
        expect(await handler()(event, 123, 2, bytes)).toEqual({ success: false, error: 'touch timed out' });
        expect(event.sender.send).toHaveBeenCalledWith('hardware-key-touch-done');
    });

    it('sends no touch-done when touch was never requested', async () => {
        challenge.mockRejectedValue(new Error('no key present'));
        const event = makeEvent();
        await handler()(event, 123, 2, bytes);
        expect(event.sender.send).not.toHaveBeenCalled();
    });
});

describe('argon2 serialization', () => {
    // One KDF at a time: N concurrent unlocks would each allocate up to the
    // per-call memory cap, so the second call must wait for the first
    const argon2 = () => handlers.get('argon2')!;
    const buf = new ArrayBuffer(8);
    const args = [buf, buf, 65536, 3, 32, 4, 2, 19] as const;

    it('does not start the second hash until the first resolves', async () => {
        const first = deferred<string>();
        const second = deferred<string>();
        hashPassword
            .mockImplementationOnce(() => first.promise as never)
            .mockImplementationOnce(() => second.promise as never);

        const p1 = argon2()(makeEvent(), ...args);
        const p2 = argon2()(makeEvent(), ...args);
        await flush();
        expect(hashPassword).toHaveBeenCalledTimes(1);

        first.resolve('key-1');
        await flush();
        expect(hashPassword).toHaveBeenCalledTimes(2);

        second.resolve('key-2');
        expect(await p1).toBe('key-1');
        expect(await p2).toBe('key-2');
    });

    it('keeps the chain alive after a failed hash', async () => {
        const first = deferred<string>();
        const second = deferred<string>();
        hashPassword
            .mockImplementationOnce(() => first.promise as never)
            .mockImplementationOnce(() => second.promise as never);

        const p1 = argon2()(makeEvent(), ...args);
        const p2 = argon2()(makeEvent(), ...args);
        first.reject(new Error('wrong parameters'));
        await expect(p1).rejects.toThrow('wrong parameters');

        await flush();
        expect(hashPassword).toHaveBeenCalledTimes(2);
        second.resolve('key-2');
        expect(await p2).toBe('key-2');
    });

    it('drops a queued call when its window is destroyed', async () => {
        const first = deferred<string>();
        hashPassword.mockImplementationOnce(() => first.promise as never);

        const running = makeEvent();
        const queued = makeEvent();
        const p1 = argon2()(running, ...args);
        const p2 = argon2()(queued, ...args);
        await flush();

        // The handler parked a 'destroyed' listener on the queued sender;
        // firing it stands in for the window closing mid-queue
        const [channel, onGone] = queued.sender.once.mock.calls[0];
        expect(channel).toBe('destroyed');
        onGone();

        first.resolve('key-1');
        await expect(p2).rejects.toThrow('The window that asked for this unlock was closed');
        expect(hashPassword).toHaveBeenCalledTimes(1);
        expect(await p1).toBe('key-1');
    });
});

describe('backup defaulting', () => {
    it('save-file falls back to DEFAULT_BACKUP_OPTIONS', async () => {
        const saveFile = vi.mocked(fileOps.saveFile);
        saveFile.mockResolvedValue({ success: true });
        const data = new Uint8Array([9]);
        await invoke('save-file', data);
        expect(saveFile).toHaveBeenCalledWith(data, DEFAULT_BACKUP_SENTINEL);
    });

    it('save-file passes an explicit backup request through', async () => {
        const saveFile = vi.mocked(fileOps.saveFile);
        saveFile.mockResolvedValue({ success: true });
        const backup = { enabled: false };
        await invoke('save-file', new Uint8Array([9]), backup);
        expect(saveFile.mock.calls[0][1]).toBe(backup);
    });

    it('save-to-file falls back to DEFAULT_BACKUP_OPTIONS', async () => {
        isPathGranted.mockReturnValue(true);
        const saveToFile = vi.mocked(fileOps.saveToFile);
        saveToFile.mockResolvedValue({ success: true });
        const data = new Uint8Array([9]);
        await invoke('save-to-file', '/vault.kdbx', data);
        expect(saveToFile).toHaveBeenCalledWith('/vault.kdbx', data, DEFAULT_BACKUP_SENTINEL);
    });
});
