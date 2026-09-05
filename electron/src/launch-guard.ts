import { app } from 'electron';

// The fuses turn off --inspect and, outside Windows, ELECTRON_RUN_AS_NODE so
// that a local process cannot run its own code inside the signed, entitled
// Vigil binary. Several Chromium switches are the same capability with no
// fuse behind them, so a packaged build refuses to start with any of them.
// The threat is a local process that launches Vigil with an argv of its
// choosing (electron-builder.config.js); a switch a user might legitimately
// pass to work around a desktop quirk (--disable-gpu, --ozone-platform,
// --enable-features) stays out of the list because refusing it would break
// real launches for no gain
export const DEBUG_SWITCHES = [
    // Remote debugging hands the renderer, and with it the preload bridge,
    // to whoever launched the process over a local socket
    'remote-debugging-port',
    'remote-debugging-pipe',
    'remote-debugging-address',
    'remote-allow-origins',
    // Inert under the fuse; refusing is clearer than ignoring
    'inspect',
    'inspect-brk',
    'inspect-port',
    // Run a binary of the launcher's choosing as a child of the signed app,
    // where it inherits the app's identity (on macOS its TCC attribution)
    'browser-subprocess-path',
    'renderer-cmd-prefix',
    'utility-cmd-prefix',
    'zygote-cmd-prefix',
    'gpu-launcher',
    // Point the app at another profile: granted-paths.json there is whatever
    // the launcher wrote, which turns into arbitrary read and write grants
    'user-data-dir',
    // Load code or turn off the page's protections
    'load-extension',
    'disable-web-security',
    'allow-running-insecure-content',
    'allow-file-access-from-files',
    'disable-site-isolation-trials',
    'js-flags',
    'auto-open-devtools-for-tabs',
    // Intercept or decrypt the network traffic (the HIBP call carries the
    // API key; the update check fetches a signed artifact, but the request
    // still says which version runs here)
    'host-resolver-rules',
    'host-rules',
    'proxy-server',
    'proxy-pac-url',
    'ignore-certificate-errors',
    'ignore-certificate-errors-spki-list',
    'ssl-key-log-file',
    'log-net-log',
    'unsafely-treat-insecure-origin-as-secure',
    'allow-insecure-localhost',
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
