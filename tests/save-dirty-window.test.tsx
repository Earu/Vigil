// @vitest-environment jsdom
import { webcrypto } from 'node:crypto';

// See app-seam.test.tsx: webcrypto results must live in this realm
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
import { render, cleanup, act, waitFor } from '@testing-library/react';
import React from 'react';
import * as kdbxweb from 'kdbxweb';

// The window between handing an edit to the save path and the save landing.
// EntryDetails clears its dirty flag the moment onSave returns, so the main
// process's unsaved-changes flag used to drop while the write (an Argon2-
// sized pause) was still running: a window close in that gap lost the edit
// with no prompt. The flag must stay set until the save resolves.
//
// App and PasswordView are real; the visual children are stubbed.

(globalThis as any).__APP_VERSION__ = 'test';
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const holder: { auth: any; entryList: any; entryDetails: any } = {
    auth: null, entryList: null, entryDetails: null,
};

vi.mock('../src/components/Authentication/AuthenticationView', () => ({
    AuthenticationView: (props: any) => { holder.auth = props; return <div data-testid="auth-view" />; },
}));
vi.mock('../src/components/PasswordView/Sidebar', () => ({ Sidebar: () => null }));
vi.mock('../src/components/PasswordView/EntryList', () => ({
    EntryList: (props: any) => { holder.entryList = props; return null; },
}));
vi.mock('../src/components/PasswordView/EntryDetails', () => ({
    EntryDetails: (props: any) => { holder.entryDetails = props; return <div data-testid="entry-details" />; },
}));
vi.mock('../src/components/PasswordView/BreachReport', () => ({ BreachReport: () => null }));
vi.mock('../src/components/TitleBar', () => ({ TitleBar: () => null }));
vi.mock('../src/components/Settings/Settings', () => ({ Settings: () => null }));
vi.mock('../src/components/Background', () => ({ Background: () => null }));
vi.mock('../src/components/Toast/Toast', () => ({ ToastContainer: () => null }));
vi.mock('../src/components/HardwareKeyTouchDialog', () => ({ HardwareKeyTouchDialog: () => null }));
vi.mock('../src/contexts/ThemeContext', () => ({
    ThemeProvider: ({ children }: any) => <>{children}</>,
}));
vi.mock('../src/components/BrowserPairingDialog', () => ({ BrowserPairingDialog: () => null }));
vi.mock('../src/components/PasskeyConsentDialog', () => ({ PasskeyConsentDialog: () => null }));
vi.mock('../src/components/SetLoginConsentDialog', () => ({ SetLoginConsentDialog: () => null }));
vi.mock('../src/components/AccessConsentDialog', () => ({ AccessConsentDialog: () => null }));

const channels = new Map<string, Array<(payload: any) => void>>();
let saveFileImpl: () => Promise<any> = async () => ({ success: true, filePath: '/fake.kdbx' });
const electronMock = {
    on: vi.fn((channel: string, handler: (payload: any) => void) => {
        const list = channels.get(channel) ?? [];
        list.push(handler);
        channels.set(channel, list);
        return () => {};
    }),
    focusWindow: vi.fn(async () => {}),
    browserIntegrationRespond: vi.fn(async () => {}),
    setUnsavedChanges: vi.fn(async () => {}),
    reportVaultOpened: vi.fn(async () => ({ duplicate: false })),
    reportVaultClosed: vi.fn(async () => {}),
    clearClipboard: vi.fn(async () => {}),
    saveFile: vi.fn(() => saveFileImpl()),
    saveToFile: vi.fn(async () => ({ success: true })),
    statFile: vi.fn(async () => ({ success: true, mtimeMs: 1, size: 1 })),
    readFile: vi.fn(async () => ({ success: false, error: 'not readable' })),
};
(window as any).electron = electronMock;

const { default: App } = await import('../src/App');
const { KeepassDatabaseService } = await import('../src/services/KeepassDatabaseService');

const flush = () => act(() => new Promise<void>(resolve => setTimeout(resolve, 30)));

// True while no setUnsavedChanges(false) has been sent since the mock was
// last cleared
const neverClearedDirty = () =>
    electronMock.setUnsavedChanges.mock.calls.every(([dirty]) => dirty === true);

async function openVaultWithEntry() {
    render(<App />);
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString('test'));
    const db0 = kdbxweb.Kdbx.create(credentials, 'Vault');
    db0.setVersion(3);
    (db0.header as any).keyEncryptionRounds = 1000;
    db0.createEntry(db0.getDefaultGroup()).fields.set('Title', 'Kept');
    const kdbxDb = await kdbxweb.Kdbx.load(await db0.save(), credentials);
    const database = KeepassDatabaseService.convertKdbxToDatabase(kdbxDb);
    await act(async () => {
        await holder.auth.onDatabaseOpen(database, kdbxDb);
    });

    // Open the entry the way a click in the list does
    await act(async () => {
        holder.entryList.onEntrySelect(holder.entryList.group.entries[0]);
    });
    expect(holder.entryDetails).toBeTruthy();
    return holder.entryDetails.entry;
}

// The sync sequence the real EntryDetails runs in handleSave: hand the entry
// over, then drop the edit-form dirty flag
const saveFromEditForm = (entry: any) => act(async () => {
    holder.entryDetails.onSave({ ...entry, notes: 'edited' });
    holder.entryDetails.onDirtyChange(false);
});

beforeEach(() => {
    channels.clear();
    holder.auth = holder.entryList = holder.entryDetails = null;
    vi.clearAllMocks();
    saveFileImpl = async () => ({ success: true, filePath: '/fake.kdbx' });
    electronMock.reportVaultOpened.mockImplementation(async () => ({ duplicate: false }));
});

// A test that fails before releasing its held save would otherwise leave the
// service's save queue blocked for every test after it
let releaseSave: ((value: any) => void) | undefined;

afterEach(async () => {
    releaseSave?.({ success: true, filePath: '/fake.kdbx' });
    releaseSave = undefined;
    cleanup();
    await flush();
    KeepassDatabaseService.setPath(undefined);
});

describe('the unsaved-changes flag around a save', () => {
    it('stays set while the save is in flight and clears when it lands', async () => {
        const entry = await openVaultWithEntry();

        await act(async () => { holder.entryDetails.onDirtyChange(true); });
        await waitFor(() => expect(electronMock.setUnsavedChanges).toHaveBeenCalledWith(true));

        // The save will hang until the test releases it
        saveFileImpl = () => new Promise(resolve => { releaseSave = resolve; });

        electronMock.setUnsavedChanges.mockClear();
        await saveFromEditForm(entry);
        // Serializing the vault takes a KDF pass and a compression; on a
        // loaded machine (the fuzz suites run alongside) that outlasts a
        // fixed pause, so wait for the write rather than assume it
        await waitFor(() => expect(electronMock.saveFile).toHaveBeenCalled(), { timeout: 10_000 });

        // The write has not landed; a close right now must still prompt
        expect(neverClearedDirty()).toBe(true);

        releaseSave({ success: true, filePath: '/fake.kdbx' });
        await waitFor(() => {
            const calls = electronMock.setUnsavedChanges.mock.calls;
            expect(calls[calls.length - 1]).toEqual([false]);
        }, { timeout: 10_000 });
    });

    it('stays set when the save fails', async () => {
        const entry = await openVaultWithEntry();

        await act(async () => { holder.entryDetails.onDirtyChange(true); });
        await waitFor(() => expect(electronMock.setUnsavedChanges).toHaveBeenCalledWith(true));

        saveFileImpl = async () => ({ success: false, error: 'disk full' });
        electronMock.setUnsavedChanges.mockClear();
        await saveFromEditForm(entry);
        await waitFor(() => expect(electronMock.saveFile).toHaveBeenCalled(), { timeout: 10_000 });
        await flush();

        // Nothing between handing the edit over and the failure may have
        // told the main process the window was clean
        expect(neverClearedDirty()).toBe(true);
        const calls = electronMock.setUnsavedChanges.mock.calls;
        expect(calls[calls.length - 1]).toEqual([true]);
    });
});
