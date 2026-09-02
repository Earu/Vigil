// Consent requests from the browser integration, shown one at a time.
//
// Each kind of consent (pairing, credential access, save login, passkey)
// used to live in its own React state slot, so a second request of the same
// kind replaced the first while its dialog was open: the resolve closure
// underneath swapped, the typed text stayed, and the first request was never
// answered. Pairing needs no key to ask, so any local process could time an
// associate to land while the user was naming their real browser and have
// its own key accepted under that name. Here requests queue, the dialog on
// screen is always the head of the queue, and every item carries an id so a
// replaced request remounts its dialog rather than inheriting one.
//
// Pure, with a subscribe/snapshot pair for useSyncExternalStore, so the
// ordering rules can be tested without React.

export type ConsentKind = 'pairing' | 'access' | 'set-login' | 'passkey';

export interface ConsentItem<P = unknown, R = unknown> {
    // Unique per item; the React key of its dialog
    id: number;
    // The main process request this answers, so its timeout can cancel it
    requestId: number;
    kind: ConsentKind;
    payload: P;
    resolve: (value: R) => void;
    // What the requester receives if the request is cancelled or dropped
    cancelValue: R;
}

let nextId = 1;
let items: ConsentItem[] = [];
const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of listeners) listener();
}

export const consentQueue = {
    subscribe(listener: () => void): () => void {
        listeners.add(listener);
        return () => { listeners.delete(listener); };
    },

    // The dialog to show, or null. Stable reference while unchanged, as
    // useSyncExternalStore requires
    getSnapshot(): ConsentItem | null {
        return items[0] ?? null;
    },

    // Resolves when the user answers, or when the request is cancelled
    enqueue<P, R>(kind: ConsentKind, requestId: number, payload: P, cancelValue: R): Promise<R> {
        return new Promise<R>((resolve) => {
            items = [...items, { id: nextId++, requestId, kind, payload, resolve: resolve as (value: unknown) => void, cancelValue }];
            notify();
        });
    },

    // The user answered the item on screen. Ignored for an item that is no
    // longer there, which is what happens when a cancel beat the click
    settle<R>(id: number, value: R): void {
        const item = items.find(i => i.id === id);
        if (!item) return;
        items = items.filter(i => i.id !== id);
        notify();
        item.resolve(value);
    },

    // The main process gave up on this request (its timeout passed); the
    // dialog closes and the requester hears the cancel value. Nothing the
    // user does afterwards can act on it
    cancel(requestId: number): void {
        const cancelled = items.filter(i => i.requestId === requestId);
        if (cancelled.length === 0) return;
        items = items.filter(i => i.requestId !== requestId);
        notify();
        for (const item of cancelled) item.resolve(item.cancelValue);
    },

    // Locking the vault: nothing pending survives it
    clear(): void {
        const dropped = items;
        items = [];
        notify();
        for (const item of dropped) item.resolve(item.cancelValue);
    },

    pendingCount(): number {
        return items.length;
    },
};
