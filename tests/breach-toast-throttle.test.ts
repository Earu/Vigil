import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { Entry, Group } from '../src/types/database';

// The progress toast used to re-render once per entry: a 5,000-entry sweep of
// cache hits meant 5,000 React render cycles through window.updateToast.
// These tests pin the throttle: bursts collapse to a leading and a trailing
// render, and terminal states (completed, cancelled) bypass the throttle.

const store = new Map<string, string>();
(globalThis as any).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
};

const showToast = vi.fn(() => 'toast-1');
const updateToast = vi.fn();
(globalThis as any).window = { showToast, updateToast };

const { BreachCheckService } = await import('../src/services/BreachCheckService');
const { BreachStatusStore } = await import('../src/services/BreachStatusStore');
const { HaveIBeenPwnedService } = await import('../src/services/HaveIBeenPwnedService');

// Drives the private progress machinery directly; the public path is
// exercised by the full-sweep test below
const svc = BreachCheckService as any;

const strong = { score: 4, feedback: { warning: '', suggestions: [] } };

const entry = (id: string): Entry => ({
    id,
    title: id,
    username: `${id}@example.com`,
    password: `pw-${id}`,
    created: new Date(0),
    modified: new Date(0),
    attachments: [],
    history: [],
    expires: false,
    customFields: [],
    tags: [],
});

const vault = (n: number): Group => ({
    id: 'root',
    name: 'All Entries',
    groups: [],
    entries: Array.from({ length: n }, (_, i) => entry(`e${i}`)),
} as Group);

vi.useFakeTimers();
afterAll(() => vi.useRealTimers());

beforeEach(() => {
    BreachStatusStore.clearAll();
    showToast.mockClear();
    updateToast.mockClear();
    svc.cancelTrailingToast();
    svc.lastToastRender = 0;
    svc.toastId = null;
    svc.countedEntries.clear();
    svc.countedEmails.clear();
    svc.progress = { checked: 0, total: 0 };
    svc.emailProgress = { checked: 0, total: 0 };
});

describe('breach progress toast throttling', () => {
    it('a full sweep renders once at the start and once at completion, not per entry', async () => {
        const spy = vi.spyOn(HaveIBeenPwnedService, 'checkPassword').mockResolvedValue({
            isPwned: false, pwnedCount: 0, strength: strong,
        });

        // Fake timers freeze Date.now, so every per-entry update lands inside
        // one throttle window: the worst case the throttle exists for
        await BreachCheckService.checkGroup('/throttle.kdbx', vault(300));

        expect(showToast).toHaveBeenCalledTimes(1);
        expect(updateToast).toHaveBeenCalledTimes(1);
        // Completion bypassed the throttle: it landed with no timer advance
        expect(updateToast.mock.calls[0][1].message).toBe('Breach check completed');
        spy.mockRestore();
    });

    it('a burst collapses to a leading render plus a trailing one carrying the final value', () => {
        svc.progress = { checked: 0, total: 50 };
        for (let i = 0; i < 50; i++) svc.incrementProgress(`burst-${i}`);

        expect(showToast).toHaveBeenCalledTimes(1);
        expect(showToast.mock.calls[0][0].message).toContain('(1/50)');
        expect(updateToast).not.toHaveBeenCalled();

        vi.advanceTimersByTime(150);
        expect(updateToast).toHaveBeenCalledTimes(1);
        expect(updateToast.mock.calls[0][1].message).toContain('(50/50)');

        // The trailing timer is one-shot; nothing else fires
        vi.advanceTimersByTime(1000);
        expect(updateToast).toHaveBeenCalledTimes(1);
    });

    it('cancellation updates the toast immediately and kills the pending trailing render', () => {
        svc.progress = { checked: 0, total: 50 };
        for (let i = 0; i < 10; i++) svc.incrementProgress(`cancel-${i}`);
        updateToast.mockClear();

        BreachCheckService.cancelChecks();
        expect(updateToast).toHaveBeenCalledTimes(1);
        expect(updateToast).toHaveBeenCalledWith('toast-1', expect.objectContaining({
            message: 'Breach check cancelled',
        }));

        vi.advanceTimersByTime(1000);
        expect(updateToast).toHaveBeenCalledTimes(1);
    });

    it('renders again once the throttle window has passed', () => {
        svc.progress = { checked: 0, total: 4 };
        svc.incrementProgress('spaced-0');
        expect(showToast).toHaveBeenCalledTimes(1);

        vi.advanceTimersByTime(150);
        svc.incrementProgress('spaced-1');
        // Past the window, so this one painted immediately, no timer involved
        expect(updateToast).toHaveBeenCalledTimes(1);
        expect(updateToast.mock.calls[0][1].message).toContain('(2/4)');
    });
});
