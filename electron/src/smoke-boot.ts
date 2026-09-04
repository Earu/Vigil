import { app, BrowserWindow } from 'electron';

// --smoke-boot: the packaged binary checks itself and exits. The CI boot test
// used to attach over --remote-debugging-port, which launch-guard now
// refuses; this is the replacement, and the only code it can run is the fixed
// expressions below. Once the first window has loaded it prints one line,
// `smoke-boot {json}`, to stdout and exits 0 whatever the answers were:
// judging them is the test's job (scripts/smoke-boot.mjs)
export const SMOKE_BOOT_SWITCH = 'smoke-boot';
const RENDER_TIMEOUT_MS = 30_000;

export function isSmokeBoot(): boolean {
    return app.commandLine.hasSwitch(SMOKE_BOOT_SWITCH);
}

export function runSmokeBoot(win: BrowserWindow): void {
    const finish = (report: Record<string, unknown>) => {
        process.stdout.write(`smoke-boot ${JSON.stringify(report)}\n`, () => app.exit(0));
    };
    win.webContents.once('did-finish-load', async () => {
        const evaluate = (expression: string) => win.webContents.executeJavaScript(expression, true);
        try {
            // React mounts a moment after navigation; wait for the first
            // element under #root
            const deadline = Date.now() + RENDER_TIMEOUT_MS;
            let rendered = false;
            while (!rendered && Date.now() < deadline) {
                rendered = (await evaluate('!!document.querySelector("#root *")')) === true;
                if (!rendered) await new Promise(resolve => setTimeout(resolve, 250));
            }
            finish({
                url: win.webContents.getURL(),
                rendered,
                bridge: await evaluate('typeof window.electron'),
                platform: await evaluate('window.electron.getPlatform()'),
                // Settings live in localStorage, which the origin only has
                // because the app scheme is registered as standard
                storage: await evaluate(
                    '(() => { localStorage.setItem("smoke-boot", "1"); const v = localStorage.getItem("smoke-boot"); localStorage.removeItem("smoke-boot"); return v === "1"; })()'
                ),
            });
        } catch (error) {
            finish({ url: win.webContents.getURL(), error: error instanceof Error ? error.message : String(error) });
        }
    });
}
