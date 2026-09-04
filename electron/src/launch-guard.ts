import { app } from 'electron';

// The fuses turn off --inspect and, outside Windows, ELECTRON_RUN_AS_NODE so
// that a local process cannot run its own code inside the signed, entitled
// Vigil binary. Chromium's remote debugging switches are the same capability
// with no fuse behind them: a process that launches Vigil with
// --remote-debugging-port gets the renderer, and with it the preload bridge,
// over a local socket. So a packaged build refuses to start with any of
// them. The inspect switches are listed too: the fuse already makes them
// inert, and refusing is clearer than ignoring them
export const DEBUG_SWITCHES = [
    'remote-debugging-port',
    'remote-debugging-pipe',
    'remote-debugging-address',
    'remote-allow-origins',
    'inspect',
    'inspect-brk',
    'inspect-port',
];

export function findDebugSwitch(hasSwitch: (name: string) => boolean): string | null {
    return DEBUG_SWITCHES.find(hasSwitch) ?? null;
}

// Terminates the process when it refuses: before the app is ready, app.exit
// exits on the spot, so nothing after the call runs. Dev builds are exempt:
// they have DevTools anyway, and IDE debuggers attach through these switches
export function refuseDebugSwitches(): void {
    if (!app.isPackaged) return;
    const found = findDebugSwitch(name => app.commandLine.hasSwitch(name));
    if (!found) return;
    process.stderr.write(`Vigil: refusing to start with --${found}; packaged builds accept no debugging switches\n`);
    app.exit(1);
}
