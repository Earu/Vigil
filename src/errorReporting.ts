// Forwards renderer failures to the main process log file. Packaged builds
// have no DevTools, so an error that only reaches the renderer console is an
// error nobody can retrieve. Messages are plain text (error text and stacks),
// truncated, and never include vault contents.

const LIMIT = 8192;

const forward = (message: string): void => {
    try {
        window.electron?.logError(message.slice(0, LIMIT));
    } catch { /* logging must never take the app down */ }
};

// Errors and strings are logged as they are. Anything else is described by
// its shape only: an object that reaches here by mistake (a rejection with
// { entry } in it, a console.error handed a model) could carry vault
// contents, and serializing it would put them in a plain-text file. The
// constructor name and a message field are enough to find the code that
// produced it
const describe = (value: unknown): string => {
    if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
    if (typeof value === 'string') return value;
    if (value !== null && typeof value === 'object') {
        const name = value.constructor?.name || 'Object';
        const message = (value as { message?: unknown }).message;
        return typeof message === 'string' ? `[${name}] ${message}` : `[${name}]`;
    }
    return String(value);
};

export function installErrorReporting(): void {
    if (!window.electron?.logError) return;

    window.addEventListener('error', (event) => {
        forward(`${event.message} (${event.filename}:${event.lineno})${event.error?.stack ? `\n${event.error.stack}` : ''}`);
    });

    window.addEventListener('unhandledrejection', (event) => {
        forward(`Unhandled rejection: ${describe(event.reason)}`);
    });

    // The existing console.error diagnostics all over src/ become retrievable
    // without touching any of them
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
        original(...args);
        forward(args.map(describe).join(' '));
    };
}
