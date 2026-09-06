import { describe, it, expect, beforeEach, vi } from 'vitest';
import fc from 'fast-check';
import { RUNS, settings, anyText, anyValue } from './fuzz';

// The IPC surface is where renderer input crosses into the main process.
// ipc-guard proves who sent a message; nothing proves what is in it, and most
// handlers take their arguments as TypeScript annotations, which are gone by
// the time a message arrives. A renderer that got script running sends
// whatever it likes on every channel, so what has to hold for any argument at
// all is: the handler answers or rejects with an Error rather than taking the
// main process down, and nothing behind a path grant runs without one.
//
// The modules behind the handlers are stubs here (tests/ipc-handlers.test.ts
// pins what each one is called with); this is about the layer in front of
// them, and about the gate.

const handlers = new Map<string, (...args: any[]) => any>();
const listeners = new Map<string, (...args: any[]) => any>();

vi.mock('electron', () => ({
    ipcMain: {
        handle: (channel: string, fn: (...args: any[]) => any) => { handlers.set(channel, fn); },
        on: (channel: string, fn: (...args: any[]) => any) => { listeners.set(channel, fn); },
    },
    BrowserWindow: { fromWebContents: () => null },
    Notification: class {
        constructor(public readonly options: unknown) {}
        show(): void {}
    },
    app: {},
    net: { fetch: async () => { throw new Error('no network in tests'); } },
    desktopCapturer: { getSources: async () => [] },
    screen: { getAllDisplays: () => [] },
    shell: { trashItem: async () => undefined },
}));

vi.mock('../../electron/src/ipc-guard', async () => {
    const { ipcMain } = await import('electron');
    return { handle: ipcMain.handle, on: ipcMain.on, isTrustedSender: () => true };
});

vi.mock('../../electron/src/window', () => ({
    findVaultWindow: vi.fn(),
    registerVault: vi.fn(),
    unregisterWindow: vi.fn(),
    focusWindow: vi.fn(),
    setUnsavedChanges: vi.fn(),
    requestVaultFolderAccess: vi.fn(async () => ({ granted: false })),
}));

vi.mock('../../electron/src/crypto', () => ({ hashPassword: vi.fn() }));

vi.mock('../../electron/src/utils', () => ({
    openExternal: vi.fn(),
    getPlatform: vi.fn(() => 'linux'),
    getAppIconPath: vi.fn(() => '/icon.png'),
    isDevBuild: vi.fn(() => false),
}));

vi.mock('../../electron/src/clipboard', () => ({ clearClipboard: vi.fn(), copySecret: vi.fn() }));

vi.mock('../../electron/src/file-operations', () => ({
    saveFile: vi.fn(async () => ({ success: true })),
    saveToFile: vi.fn(async () => ({ success: true })),
    saveAttachment: vi.fn(async () => ({ success: true })),
    saveKeyFile: vi.fn(async () => ({ success: true })),
    registerDroppedVault: vi.fn(() => true),
    openFile: vi.fn(async () => ({ success: true })),
    readFile: vi.fn(async () => ({ success: true })),
    selectKeyFile: vi.fn(async () => ({ success: true })),
    statFile: vi.fn(async () => ({ success: true })),
    loadLastDatabasePath: vi.fn(async () => null),
    saveLastDatabasePath: vi.fn(async () => true),
}));

vi.mock('../../electron/src/biometrics', () => ({
    isBiometricsAvailable: vi.fn(async () => false),
    getBiometricsInfo: vi.fn(async () => ({ available: false })),
    getBiometricsConfig: vi.fn(() => ({ requirePasswordAfterRestart: true })),
    setBiometricsConfig: vi.fn(async () => ({ success: true })),
    hasBiometricsEnabled: vi.fn(async () => false),
    enableBiometrics: vi.fn(async () => ({ success: true })),
    getBiometricPassword: vi.fn(async () => ({ success: false })),
    disableBiometrics: vi.fn(async () => ({ success: true })),
}));

vi.mock('../../electron/src/hibp', () => ({
    checkEmailBreaches: vi.fn(async () => []),
    setHibpApiKey: vi.fn(async () => ({ success: true })),
    hasHibpApiKey: vi.fn(async () => false),
}));

vi.mock('../../electron/src/content-protection', () => ({
    isSupported: vi.fn(() => true),
    isContentProtectionEnabled: vi.fn(() => false),
    setContentProtectionEnabled: vi.fn(),
}));

vi.mock('../../electron/src/hardware-key', () => ({
    listHardwareKeys: vi.fn(async () => []),
    hardwareKeyChallenge: vi.fn(async () => ({ success: false })),
    hardwareKeyPresent: vi.fn(async () => false),
    yubicoDevicePresent: vi.fn(async () => false),
}));

// The transport, not the driver: the OATH protocol code runs for real, over a
// card that is never there, so no property here touches the reader
vi.mock('../../electron/native/pcsc', () => ({
    isLoaded: () => false,
    listReaders: async () => { throw new Error('unavailable'); },
    connect: async () => { throw new Error('unavailable'); },
}));

// The user's own running agent is not a fuzz target
vi.mock('../../electron/src/ssh-agent', () => ({
    agentSocketPath: vi.fn(async () => null),
    isAgentRunning: vi.fn(async () => false),
    listIdentities: vi.fn(async () => []),
    addKeyForWindow: vi.fn(async () => undefined),
    releaseWindow: vi.fn(async () => []),
    removeIdentity: vi.fn(async () => false),
    forgetKeyForWindow: vi.fn(),
    loadedFingerprints: vi.fn(() => []),
}));

vi.mock('../../electron/src/backups', () => ({
    DEFAULT_BACKUP_OPTIONS: { enabled: true, keep: 5 },
    getBackupInfo: vi.fn(async () => ({ directory: '', count: 0, newest: null, totalBytes: 0 })),
    revealBackups: vi.fn(async () => ({ success: true })),
    purgeBackups: vi.fn(async () => ({ success: true, removed: 0 })),
}));

vi.mock('../../electron/src/logger', () => ({ logRendererError: vi.fn(), revealLogs: vi.fn(async () => ({ success: true })) }));

vi.mock('../../electron/src/gesture', () => ({ consumeRecentGesture: vi.fn(() => true) }));

vi.mock('../../electron/src/qr-decode', () => ({ decodeQrFromImage: vi.fn(() => null) }));

vi.mock('../../electron/src/path-authority', () => ({
    isPathGranted: vi.fn(() => false),
    grantPath: vi.fn(),
}));

vi.mock('../../electron/src/conflict-copies', () => ({
    scanConflictCopies: vi.fn(async () => []),
    nominateConflictCopy: vi.fn(),
    isNominatedConflictCopy: vi.fn(() => false),
    probeVaultFolder: vi.fn(async () => ({ listable: true })),
}));

const authority = await import('../../electron/src/path-authority');
const fileOps = await import('../../electron/src/file-operations');
const backups = await import('../../electron/src/backups');
const biometrics = await import('../../electron/src/biometrics');
const conflictCopies = await import('../../electron/src/conflict-copies');

const { shell } = await import('electron');

const { setupIpcHandlers } = await import('../../electron/src/ipc');
setupIpcHandlers();

const isPathGranted = vi.mocked(authority.isPathGranted);

const makeEvent = () => ({
    sender: { isDestroyed: () => false, once: vi.fn(), off: vi.fn(), send: vi.fn(), id: 1 },
});

beforeEach(() => {
    vi.clearAllMocks();
    isPathGranted.mockReturnValue(false);
});

// Every channel setupIpcHandlers registered, so a channel added later is
// fuzzed without anyone remembering to list it here
const channels = [...handlers.keys()];

// A run draws one channel, so the budget has to cover the whole surface a
// few times over before it is the per-channel depth the other suites get
const sweep = <T>(overrides: fc.Parameters<T> = {}) => settings<T>({ numRuns: Math.max(RUNS, channels.length * 5), ...overrides });

// Arguments a compromised renderer sends: anything at all, and the shapes
// that are nearly right, which get further into a handler before failing
const args = (): fc.Arbitrary<unknown[]> => fc.array(
    fc.oneof(
        { weight: 3, arbitrary: anyValue() },
        { weight: 2, arbitrary: anyText() },
        { weight: 1, arbitrary: fc.uint8Array({ maxLength: 64 }) },
        { weight: 1, arbitrary: fc.constantFrom('/etc/passwd', '../../etc/shadow', '\0', 'C:\\Windows\\System32\\config\\SAM', 'file:///etc/passwd') },
    ),
    { maxLength: 4 },
);

describe('IPC arguments under fuzz', () => {
    it('registered every channel the fuzz then covers', () => {
        expect(channels.length).toBeGreaterThan(40);
    });

    it('every channel answers or rejects with an Error, whatever it is sent', async () => {
        await fc.assert(fc.asyncProperty(fc.constantFrom(...channels), args(), async (channel, values) => {
            try {
                await handlers.get(channel)!(makeEvent(), ...values);
            } catch (error) {
                // A rejection is a fine answer; a thrown string or object is
                // not, since the renderer sees it as an opaque failure and
                // the main process logs nothing useful
                expect(error, `${channel} threw a non-Error`).toBeInstanceOf(Error);
            }
        }), sweep());
    });

    it('the fire-and-forget listeners never throw', () => {
        fc.assert(fc.property(fc.constantFrom(...listeners.keys()), args(), (channel, values) => {
            expect(() => listeners.get(channel)!(makeEvent(), ...values)).not.toThrow();
        }), settings());
    });

    it('no channel behind a path grant reaches its module without one', async () => {
        // Each of these derives a filesystem location, or a stored secret,
        // from a renderer-supplied path
        const gated: Array<[string, () => ReturnType<typeof vi.fn>]> = [
            ['save-to-file', () => vi.mocked(fileOps.saveToFile)],
            ['read-file', () => vi.mocked(fileOps.readFile)],
            ['stat-file', () => vi.mocked(fileOps.statFile)],
            ['save-last-database-path', () => vi.mocked(fileOps.saveLastDatabasePath)],
            ['get-backup-info', () => vi.mocked(backups.getBackupInfo)],
            ['reveal-backups', () => vi.mocked(backups.revealBackups)],
            ['purge-backups', () => vi.mocked(backups.purgeBackups)],
            ['has-biometrics-enabled', () => vi.mocked(biometrics.hasBiometricsEnabled)],
            ['enable-biometrics', () => vi.mocked(biometrics.enableBiometrics)],
            ['get-biometric-password', () => vi.mocked(biometrics.getBiometricPassword)],
            ['disable-biometrics', () => vi.mocked(biometrics.disableBiometrics)],
            ['list-conflict-copies', () => vi.mocked(conflictCopies.scanConflictCopies)],
        ];

        isPathGranted.mockReturnValue(false);
        // Only this run's own mock is cleared: clearAllMocks walks every mock
        // in the file, which at a deep budget costs more than the property
        await fc.assert(fc.asyncProperty(fc.constantFrom(...gated), args(), async ([channel, target], values) => {
            const behindTheGate = target();
            behindTheGate.mockClear();
            await handlers.get(channel)!(makeEvent(), ...values).catch(() => undefined);
            expect(behindTheGate, `${channel} ran without a grant`).not.toHaveBeenCalled();
        }), sweep());
    });

    it('trashing a file is refused for anything the main process did not nominate', async () => {
        // A grant is not the thing that makes a file deletable: a key file is
        // granted too. The nomination is, so this run grants everything
        isPathGranted.mockReturnValue(true);
        vi.mocked(conflictCopies.isNominatedConflictCopy).mockReturnValue(false);
        const trash = vi.spyOn(shell, 'trashItem');
        try {
            await fc.assert(fc.asyncProperty(args(), async values => {
                trash.mockClear();
                await handlers.get('trash-conflict-copy')!(makeEvent(), ...values).catch(() => undefined);
                expect(trash).not.toHaveBeenCalled();
            }), settings());
        } finally {
            trash.mockRestore();
            isPathGranted.mockReturnValue(false);
        }
    });
});
