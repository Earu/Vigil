import { describe, it, expect, beforeEach } from 'vitest';
import { consentQueue } from '../src/services/ConsentQueue';

const settled = <T,>(p: Promise<T>) => {
    let value: T | undefined;
    let done = false;
    p.then(v => { value = v; done = true; });
    return { get done() { return done; }, get value() { return value; } };
};
const tick = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => consentQueue.clear());

describe('consent queue', () => {
    it('shows one request at a time, in arrival order', async () => {
        const first = settled(consentQueue.enqueue('pairing', 1, { fingerprint: 'aaa' }, null));
        const second = settled(consentQueue.enqueue('pairing', 2, { fingerprint: 'bbb' }, null));

        // The attack this exists for: a second pairing arriving while the
        // first dialog is open must not become the dialog on screen
        const shown = consentQueue.getSnapshot()!;
        expect((shown.payload as { fingerprint: string }).fingerprint).toBe('aaa');

        consentQueue.settle(shown.id, 'Firefox');
        await tick();
        expect(first.done).toBe(true);
        expect(first.value).toBe('Firefox');
        expect(second.done).toBe(false);
        expect((consentQueue.getSnapshot()!.payload as { fingerprint: string }).fingerprint).toBe('bbb');
    });

    it('gives each request its own dialog identity', () => {
        consentQueue.enqueue('pairing', 1, {}, null);
        const a = consentQueue.getSnapshot()!.id;
        consentQueue.settle(a, null);
        consentQueue.enqueue('pairing', 2, {}, null);
        expect(consentQueue.getSnapshot()!.id).not.toBe(a);
    });

    it('answers a cancelled request with its cancel value and drops its dialog', async () => {
        const access = settled(consentQueue.enqueue('access', 7, { host: 'example.com' }, null));
        const login = settled(consentQueue.enqueue('set-login', 8, {}, false));

        consentQueue.cancel(7);
        await tick();
        expect(access.done).toBe(true);
        expect(access.value).toBeNull();
        expect(consentQueue.getSnapshot()!.kind).toBe('set-login');

        consentQueue.cancel(8);
        await tick();
        expect(login.value).toBe(false);
        expect(consentQueue.getSnapshot()).toBeNull();
    });

    it('ignores an answer to a request that was already cancelled', async () => {
        const pairing = settled(consentQueue.enqueue('pairing', 3, {}, null));
        const id = consentQueue.getSnapshot()!.id;
        consentQueue.cancel(3);
        consentQueue.settle(id, 'Late click');
        await tick();
        expect(pairing.value).toBeNull();
    });

    it('drops everything on clear, answering each with its cancel value', async () => {
        const a = settled(consentQueue.enqueue('passkey', 1, {}, null));
        const b = settled(consentQueue.enqueue('set-login', 2, {}, false));
        consentQueue.clear();
        await tick();
        expect(a.value).toBeNull();
        expect(b.value).toBe(false);
        expect(consentQueue.pendingCount()).toBe(0);
    });

    it('notifies subscribers on every change and keeps the snapshot stable between them', () => {
        let notified = 0;
        const unsubscribe = consentQueue.subscribe(() => { notified++; });
        consentQueue.enqueue('pairing', 1, {}, null);
        const snap = consentQueue.getSnapshot();
        expect(consentQueue.getSnapshot()).toBe(snap);
        consentQueue.settle(snap!.id, null);
        expect(notified).toBe(2);
        unsubscribe();
    });
});
