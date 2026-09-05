// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';

// Under the jsdom environment webcrypto results are ArrayBuffers from node's
// realm, which fail kdbxweb's `instanceof ArrayBuffer` checks against the
// jsdom-populated global. Copy every subtle result into this realm
const intoRealm = (buf: ArrayBuffer): ArrayBuffer => {
    const out = new Uint8Array(buf.byteLength);
    out.set(new Uint8Array(buf));
    return out.buffer;
};
const subtle: any = {
    digest: async (...a: any[]) => intoRealm(await (webcrypto.subtle.digest as any)(...a)),
    sign: async (...a: any[]) => intoRealm(await (webcrypto.subtle.sign as any)(...a)),
    encrypt: async (...a: any[]) => intoRealm(await (webcrypto.subtle.encrypt as any)(...a)),
    decrypt: async (...a: any[]) => intoRealm(await (webcrypto.subtle.decrypt as any)(...a)),
    importKey: (...a: any[]) => (webcrypto.subtle.importKey as any)(...a),
    exportKey: async (...a: any[]) => intoRealm(await (webcrypto.subtle.exportKey as any)(...a)),
};
Object.defineProperty(globalThis, 'crypto', {
    value: { subtle, getRandomValues: (a: any) => webcrypto.getRandomValues(a), randomUUID: () => webcrypto.randomUUID() },
    configurable: true,
});

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, screen, act, waitFor } from '@testing-library/react';
import React from 'react';
import * as kdbxweb from 'kdbxweb';

// App.tsx is the seam between the main process events, the browser
// integration and the vault services. The child views are stubbed; the
// effects, handlers and the consent queue wiring under test are real.

(globalThis as any).__APP_VERSION__ = 'test';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Captured props of the stubbed children, refreshed on every render
const holder: {
    auth: any;
    passwordView: any;
    titleBar: any;
    settings: any;
} = { auth: null, passwordView: null, titleBar: null, settings: null };

vi.mock('../src/components/Authentication/AuthenticationView', () => ({
    AuthenticationView: (props: any) => { holder.auth = props; return <div data-testid="auth-view" />; },
}));
vi.mock('../src/components/PasswordView', () => ({
    PasswordView: (props: any) => { holder.passwordView = props; return <div data-testid="password-view" />; },
}));
vi.mock('../src/components/TitleBar', () => ({
    TitleBar: (props: any) => { holder.titleBar = props; return null; },
}));
vi.mock('../src/components/Settings/Settings', () => ({
    Settings: (props: any) => { holder.settings = props; return null; },
}));
vi.mock('../src/components/Background', () => ({ Background: () => null }));
vi.mock('../src/components/Toast/Toast', () => ({ ToastContainer: () => null }));
vi.mock('../src/components/HardwareKeyTouchDialog', () => ({ HardwareKeyTouchDialog: () => null }));
vi.mock('../src/contexts/ThemeContext', () => ({
    ThemeProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock('../src/components/BrowserPairingDialog', () => ({
    BrowserPairingDialog: () => <div data-testid="dialog-pairing" />,
}));
vi.mock('../src/components/PasskeyConsentDialog', () => ({
    PasskeyConsentDialog: () => <div data-testid="dialog-passkey" />,
}));
vi.mock('../src/components/SetLoginConsentDialog', () => ({
    SetLoginConsentDialog: () => <div data-testid="dialog-set-login" />,
}));
vi.mock('../src/components/AccessConsentDialog', () => ({
    AccessConsentDialog: () => <div data-testid="dialog-access" />,
}));

// The window.electron surface App and the services underneath reach for.
// Event handlers are recorded per channel; fire() invokes the newest one,
// which is the one whose cleanup has not run
const channels = new Map<string, Array<(payload: any) => void>>();
const electronMock = {
    on: vi.fn((channel: string, handler: (payload: any) => void) => {
        const list = channels.get(channel) ?? [];
        list.push(handler);
        channels.set(channel, list);
        return () => {
            const current = channels.get(channel) ?? [];
            channels.set(channel, current.filter(h => h !== handler));
        };
    }),
    focusWindow: vi.fn(async () => {}),
    browserIntegrationRespond: vi.fn(async () => {}),
    setUnsavedChanges: vi.fn(async () => {}),
    reportVaultOpened: vi.fn(async () => ({ duplicate: false })),
    listConflictCopies: vi.fn(async () => []),
    trashConflictCopy: vi.fn(async () => ({ success: true })),
    reportVaultClosed: vi.fn(async () => {}),
    clearClipboard: vi.fn(async () => {}),
    copySecret: vi.fn(async () => ({ success: true })),
    saveFile: vi.fn(async () => ({ success: true, filePath: '/fake.kdbx' })),
    saveToFile: vi.fn(async () => ({ success: true })),
    statFile: vi.fn(async () => ({ success: true, mtimeMs: 1, size: 1 })),
    readFile: vi.fn(async () => ({ success: false, error: 'not readable' })),
};
(window as any).electron = electronMock;

const fire = (channel: string, payload?: any) => {
    const list = channels.get(channel) ?? [];
    expect(list.length, `no handler subscribed on ${channel}`).toBeGreaterThan(0);
    return list[list.length - 1](payload);
};

const { default: App } = await import('../src/App');
const { KeepassDatabaseService } = await import('../src/services/KeepassDatabaseService');
const { consentQueue } = await import('../src/services/ConsentQueue');

const flush = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 30)));

async function makeDb() {
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'));
    const db0 = kdbxweb.Kdbx.create(credentials, 'Vault');
    db0.setVersion(3);
    // The default AES-KDF rounds cost real time per save; the KDF is not
    // what these tests exercise
    (db0.header as any).keyEncryptionRounds = 1000;
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
    return await kdbxweb.Kdbx.load(await db0.save(), credentials);
}

async function openVault() {
    render(<App />);
    const kdbxDb = await makeDb();
    const database = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
    await act(async () => {
        await holder.auth.onDatabaseOpen(database, kdbxDb);
    });
    expect(screen.getByTestId('password-view')).toBeTruthy();
    return { kdbxDb, database };
}

beforeEach(() => {
    channels.clear();
    holder.auth = holder.passwordView = holder.titleBar = null;
    vi.clearAllMocks();
    electronMock.reportVaultOpened.mockImplementation(async () => ({ duplicate: false }));
});

afterEach(async () => {
    cleanup();
    await flush();
    KeepassDatabaseService.setPath(undefined);
});

describe('locking', () => {
    it('returns to the unlock screen and tells main the vault closed', async () => {
        await openVault();
        await act(async () => { fire('trigger-lock'); });

        expect(screen.getByTestId('auth-view')).toBeTruthy();
        expect(screen.queryByTestId('password-view')).toBeNull();
        expect(electronMock.reportVaultClosed).toHaveBeenCalled();
        expect(electronMock.setUnsavedChanges).toHaveBeenCalledWith(false);
        expect(electronMock.clearClipboard).toHaveBeenCalled();
    });

    it('does not put the vault back on screen when a save finishes after the lock', async () => {
        // Give the vault a file, so the save writes rather than asks
        KeepassDatabaseService.setPath('/fake.kdbx');
        await flush();
        const { kdbxDb } = await openVault();

        let finishWrite!: () => void;
        electronMock.saveToFile.mockImplementationOnce(() => new Promise(resolve => {
            finishWrite = () => resolve({ success: true });
        }));
        act(() => {
            holder.passwordView.onDatabaseChange(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
        });
        await waitFor(() => expect(electronMock.saveToFile).toHaveBeenCalled(), { timeout: 5000 });

        await act(async () => { fire('trigger-lock'); });
        expect(screen.getByTestId('auth-view')).toBeTruthy();
        electronMock.setUnsavedChanges.mockClear();

        await act(async () => { finishWrite(); });
        await flush();

        // Written where it was started, and the lock stands
        expect(electronMock.saveToFile.mock.calls[0][0]).toBe('/fake.kdbx');
        expect(electronMock.saveFile).not.toHaveBeenCalled();
        expect(screen.getByTestId('auth-view')).toBeTruthy();
        expect(screen.queryByTestId('password-view')).toBeNull();
        // The finished save reports nothing about a session that is over
        expect(electronMock.setUnsavedChanges).not.toHaveBeenCalled();
    });

    it('closes the settings modal', async () => {
        await openVault();
        act(() => { holder.titleBar.onOpenSettings(); });
        expect(holder.settings.isOpen).toBe(true);

        await act(async () => { fire('trigger-lock'); });
        expect(holder.settings.isOpen).toBe(false);
    });

    it('drops a pending consent dialog: nobody is there to answer it', async () => {
        const { kdbxDb } = await openVault();
        void kdbxDb;

        let settled: unknown = 'unsettled';
        act(() => {
            consentQueue.enqueue('set-login', 42, { url: 'https://x', login: 'u', mode: 'create' }, false)
                .then(v => { settled = v; });
        });
        expect(screen.getByTestId('dialog-set-login')).toBeTruthy();

        await act(async () => { fire('trigger-lock'); });
        await flush();
        expect(settled).toBe(false);
        expect(screen.queryByTestId('dialog-set-login')).toBeNull();
    });
});

describe('unlocking', () => {
    it('closes a settings modal left open over the unlock screen', async () => {
        render(<App />);
        act(() => { holder.titleBar.onOpenSettings(); });
        expect(holder.settings.isOpen).toBe(true);

        const kdbxDb = await makeDb();
        const database = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
        await act(async () => {
            await holder.auth.onDatabaseOpen(database, kdbxDb);
        });
        expect(screen.getByTestId('password-view')).toBeTruthy();
        expect(holder.settings.isOpen).toBe(false);
    });
});

describe('a consent dialog open while an unrelated save completes', () => {
    it('stays open and unanswered', async () => {
        const { kdbxDb } = await openVault();

        // The extension asks to save a login; the dialog goes up and waits
        // for the user
        const request = fire('browser-integration-request', {
            id: 7,
            action: 'set-login',
            payload: { url: 'https://site.example', login: 'user', password: 'pw' },
        });
        await flush();
        expect(screen.getByTestId('dialog-set-login')).toBeTruthy();

        // Meanwhile an unrelated UI edit saves. The save succeeds and
        // refreshes the database model
        await act(async () => {
            holder.passwordView.onDatabaseChange(KeepassDatabaseService.convertKdbxToDatabase(kdbxDb));
        });
        await waitFor(() => expect(electronMock.saveFile).toHaveBeenCalled(), { timeout: 5000 });
        await flush();

        // The dialog must still be waiting for the user: the save answered
        // nothing on their behalf, and the browser has not been told anything
        expect(screen.queryByTestId('dialog-set-login')).toBeTruthy();
        expect(electronMock.browserIntegrationRespond).not.toHaveBeenCalled();

        // Let the request finish so it does not leak into the next test
        act(() => { consentQueue.clear(); });
        await act(async () => { await request; });
    });
});
