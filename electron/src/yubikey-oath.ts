import { spawn } from 'child_process';
import { isDevBuild } from './utils';

// Read-only view of the OATH application on a connected YubiKey.
//
// OATH lives on the key's CCID (smart card) interface, not the OTP HID
// interface hardware-key.ts drives, so none of that code applies here and
// reaching it directly would mean linking a PC/SC stack into the build.
// Instead this shells out to ykman, Yubico's own CLI, the way KeeWeb does.
// The cost is that the user installs it themselves; the gain is that no
// native module joins the build for a feature this far off the main path.
//
// Reads are the bulk of this. The one write, pushAccount, copies a secret
// the vault already holds onto the key; the vault keeps its copy, because no
// command in the protocol reads a secret back and that vault copy is the only
// backup that will ever exist. Nothing here can move a secret the other way.

const LIST_TIMEOUT_MS = 10_000;
// A touch-required account blinks until the user presses it; ykman gives up
// on its own, this is only the backstop
const CODE_TIMEOUT_MS = 30_000;

// PATH in a packaged app launched from a desktop session is not the shell's,
// so absolute paths are tried too. VIGIL_YKMAN overrides the lot: it points a
// non-standard install at the right binary, and pointing it at nothing is the
// only way to exercise the not-installed path on a machine that has ykman
// Known locations are tried before a bare name, so a PATH entry (or, on
// Windows, the working directory, which CreateProcess also searches) cannot
// win over a real install
const DEFAULT_CANDIDATES = process.platform === 'win32'
    ? ['C:\\Program Files\\Yubico\\YubiKey Manager\\ykman.exe', 'ykman.exe']
    : ['/usr/bin/ykman', '/usr/local/bin/ykman', '/opt/homebrew/bin/ykman', '/snap/bin/ykman', 'ykman'];

// Development only: in a packaged build this would be a way to point Vigil at
// an arbitrary binary, which is a fine place to hang a fake ykman that prompts
// for the OATH password
const CANDIDATES = isDevBuild() && process.env.VIGIL_YKMAN
    ? [process.env.VIGIL_YKMAN]
    : DEFAULT_CANDIDATES;

export type OathType = 'TOTP' | 'HOTP';

export interface OathAccount {
    // The credential id exactly as ykman prints it, which is what every
    // other ykman call takes as its query. Both halves below are derived
    // from it for display only
    id: string;
    issuer: string | null;
    name: string;
    type: OathType;
    period: number;
    // null when the key would not hand one over unprompted: HOTP accounts
    // (calculating one burns a counter) and touch-required ones
    code: string | null;
    requiresTouch: boolean;
}

export type OathFailure =
    | 'ykman-missing'
    | 'no-key'
    | 'no-pcscd'
    | 'locked'
    | 'wrong-password'
    | 'timeout'
    | 'in-use'
    | 'failed';

export interface OathResult<T> {
    ok: boolean;
    value?: T;
    error?: OathFailure;
    detail?: string;
}

interface RunResult {
    code: number | null;
    stdout: string;
    stderr: string;
    spawnError?: NodeJS.ErrnoException;
}

let resolvedBinary: string | null | undefined;

// `answers` are fed to ykman's prompts in order. A locked applet asks for
// the password first, and `add` then asks for the secret, so a write to a
// locked key passes both
function run(binary: string, args: string[], answers: string[], timeoutMs: number): Promise<RunResult> {
    return new Promise(resolve => {
        // detached takes the child out of this process's controlling terminal.
        // ykman's password prompt goes through getpass, which reads /dev/tty
        // when there is one: without this, a Vigil started from a shell would
        // send the prompt to that shell and block there rather than reading
        // the password written below
        const child = spawn(binary, args, { detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result: RunResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill('SIGKILL');
            finish({ code: null, stdout, stderr, spawnError: undefined });
        }, timeoutMs);

        child.stdout.on('data', chunk => { stdout += chunk; });
        child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', (error: NodeJS.ErrnoException) => finish({ code: null, stdout, stderr, spawnError: error }));
        child.on('close', code => finish({ code, stdout, stderr }));

        // Neither the password nor a secret ever goes in argv:
        // /proc/<pid>/cmdline is readable by other processes. Anything ykman
        // does not prompt for is simply discarded
        child.stdin.on('error', () => { /* EPIPE when ykman never prompts */ });
        for (const answer of answers) child.stdin.write(`${answer}\n`);
        child.stdin.end();
    });
}

const answers = (password: string | null): string[] => (password === null ? [] : [password]);

// PC/SC gives the card to one process at a time. A second ykman talking to the
// same key does not wait its turn, it fails with SCARD_E_PROTO_MISMATCH, so
// two overlapping reads leave one of them broken for no reason. Every call
// that touches the card goes through this chain
let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
    const next = queue.then(task, task);
    // The chain must survive a rejected task, and nothing awaits it
    queue = next.then(() => undefined, () => undefined);
    return next;
}

// Serializing keeps Vigil from racing itself, but any other process on the
// machine can still hold the card mid-call. One retry covers the moment
// Yubico Authenticator or ykman happens to be reading
const CONTENTION_RETRY_MS = 250;

async function withCard<T>(task: () => Promise<OathResult<T>>, retry = true): Promise<OathResult<T>> {
    return serialize(async () => {
        const first = await task();
        if (!retry || first.ok || first.error !== 'in-use') return first;
        await new Promise(resolve => setTimeout(resolve, CONTENTION_RETRY_MS));
        return task();
    });
}

// The first candidate that answers --version. Cached across calls; a user who
// installs ykman while Vigil is open gets it after a restart
export async function findYkman(): Promise<string | null> {
    if (resolvedBinary !== undefined) return resolvedBinary;
    for (const candidate of CANDIDATES) {
        const result = await run(candidate, ['--version'], [], 5000);
        if (!result.spawnError && result.code === 0) {
            resolvedBinary = candidate;
            return candidate;
        }
    }
    resolvedBinary = null;
    return null;
}

// Exposed for tests: forget what findYkman cached
export function resetYkmanCache(): void {
    resolvedBinary = undefined;
}

// ykman reports every failure as exit 1 with a human sentence, so the sentence
// is all there is to go on. Matching is deliberately loose and always falls
// back to showing the user what ykman said
function classify(stderr: string, stdout: string): OathFailure {
    const text = `${stderr}\n${stdout}`.toLowerCase();
    // Another process holds the card. Never matched on the bare string
    // 'pcsc': a Python traceback names ykman/pcsc and smartcard/pcsc modules,
    // which would report every crash as a missing smart card service
    if (text.includes('protocol mismatch') || text.includes('0x8010000f')) return 'in-use';
    if (text.includes('sharing violation') || text.includes('0x8010000b')) return 'in-use';
    if (text.includes('in use')) return 'in-use';
    // Checked before no-key: with no PC/SC stack ykman also reports that it
    // could not connect to the key, which on its own reads as no-key
    if (text.includes('pc/sc not available')) return 'no-pcscd';
    if (text.includes('no yubikey detected') || text.includes('no device')) return 'no-key';
    if (text.includes('failed to connect to yubikey')) return 'no-key';
    if (text.includes('wrong password') || text.includes('authentication to the yubikey failed')) return 'wrong-password';
    if (text.includes('enter the password')) return 'locked';
    if (text.includes('timed out')) return 'timeout';
    return 'failed';
}

function fail<T>(result: RunResult): OathResult<T> {
    if (result.spawnError?.code === 'ENOENT') return { ok: false, error: 'ykman-missing' };
    if (result.code === null) return { ok: false, error: 'timeout' };
    const text = (result.stderr.trim() || result.stdout.trim());
    const lines = text.split('\n').map(line => line.trim()).filter(Boolean);
    // A Python traceback opens with boilerplate and ends with what went wrong
    const detail = text.includes('Traceback (most recent call last)')
        ? lines[lines.length - 1]
        : lines.slice(0, 3).join(' ');
    return { ok: false, error: classify(result.stderr, result.stdout), detail };
}

// `<id>, <TOTP|HOTP>, <period>`, where the id is free text that may itself
// hold commas, so the two known fields are taken off the right
function parseListLine(line: string): { id: string; type: OathType; period: number } | null {
    const parts = line.split(', ');
    if (parts.length < 3) return null;
    const period = Number(parts[parts.length - 1]);
    const type = parts[parts.length - 2];
    if (!Number.isInteger(period) || (type !== 'TOTP' && type !== 'HOTP')) return null;
    return { id: parts.slice(0, -2).join(', '), type, period };
}

// An id is `issuer:name`, or `<period>/issuer:name` when the period is not
// the default 30. Neither half is escaped, so a name holding a colon splits
// at the first one, the same way ykman's own parser does
function splitId(id: string): { issuer: string | null; name: string } {
    const withoutPeriod = /^\d+\//.test(id) ? id.slice(id.indexOf('/') + 1) : id;
    const colon = withoutPeriod.indexOf(':');
    if (colon === -1) return { issuer: null, name: withoutPeriod };
    return { issuer: withoutPeriod.slice(0, colon), name: withoutPeriod.slice(colon + 1) };
}

// `accounts code` pads the name column to the longest name and right-aligns
// the code, and a name may contain runs of spaces of its own. Rather than
// guess where the columns split, each line is matched against the ids the
// list call already returned, longest first so one id that prefixes another
// cannot win
function parseCodes(stdout: string, ids: string[]): Map<string, string> {
    const byLength = [...ids].sort((a, b) => b.length - a.length);
    const codes = new Map<string, string>();
    for (const line of stdout.split('\n')) {
        if (!line.trim()) continue;
        const id = byLength.find(candidate => line.startsWith(candidate));
        if (!id) continue;
        codes.set(id, line.slice(id.length).trim());
    }
    return codes;
}

const NO_CODE = new Set(['[Requires Touch]', '[HOTP Account]', '']);

// One `list` for the names and one `code` for the values. `code` with no
// query is a CALCULATE ALL: it never advances an HOTP counter and never asks
// for a touch, which is what makes it safe to call on every refresh
export async function readAccounts(serial: number | null, password: string | null): Promise<OathResult<OathAccount[]>> {
    return withCard(() => readAccountsUnlocked(serial, password));
}

async function readAccountsUnlocked(serial: number | null, password: string | null): Promise<OathResult<OathAccount[]>> {
    const binary = await findYkman();
    if (!binary) return { ok: false, error: 'ykman-missing' };
    const device = serial === null ? [] : ['--device', String(serial)];

    const listed = await run(binary, [...device, 'oath', 'accounts', 'list', '-o', '-P'], answers(password), LIST_TIMEOUT_MS);
    if (listed.spawnError || listed.code !== 0) return fail(listed);

    const rows = listed.stdout.split('\n').map(parseListLine).filter(row => row !== null);
    if (rows.length === 0) return { ok: true, value: [] };

    const calculated = await run(binary, [...device, 'oath', 'accounts', 'code'], answers(password), LIST_TIMEOUT_MS);
    if (calculated.spawnError || calculated.code !== 0) return fail(calculated);
    const codes = parseCodes(calculated.stdout, rows.map(row => row.id));

    return {
        ok: true,
        value: rows.map(row => {
            const raw = codes.get(row.id) ?? '';
            return {
                ...row,
                ...splitId(row.id),
                code: NO_CODE.has(raw) ? null : raw,
                requiresTouch: raw === '[Requires Touch]',
            };
        }),
    };
}

// One account, calculated on purpose. This is the call that burns an HOTP
// counter and that lights the key up for a touch, so it only ever runs from
// an explicit click
export async function calculateCode(serial: number | null, id: string, password: string | null): Promise<OathResult<string>> {
    // Not retried: the key may already have advanced an HOTP counter before
    // the failure, and a second attempt would advance it again, leaving the
    // vault two behind the service rather than one
    return withCard(() => calculateCodeUnlocked(serial, id, password), false);
}

async function calculateCodeUnlocked(serial: number | null, id: string, password: string | null): Promise<OathResult<string>> {
    const binary = await findYkman();
    if (!binary) return { ok: false, error: 'ykman-missing' };
    const device = serial === null ? [] : ['--device', String(serial)];
    // `--` first: a credential named --help would otherwise print help and
    // exit 0, and that output would be shown as if it were a code
    const result = await run(binary, [...device, 'oath', 'accounts', 'code', '-s', '--', id], answers(password), CODE_TIMEOUT_MS);
    if (result.spawnError || result.code !== 0) return fail(result);
    const code = result.stdout.trim();
    return code ? { ok: true, value: code } : { ok: false, error: 'failed', detail: 'ykman returned no code' };
}

// Serial numbers of the connected keys, for the case where more than one is
// plugged in. `list --serials` prints one per line
export async function listKeys(): Promise<OathResult<number[]>> {
    const binary = await findYkman();
    if (!binary) return { ok: false, error: 'ykman-missing' };
    const result = await run(binary, ['list', '--serials'], [], LIST_TIMEOUT_MS);
    if (result.spawnError || result.code !== 0) return fail(result);
    const serials = result.stdout.split('\n')
        .map(line => Number(line.trim()))
        .filter(serial => Number.isInteger(serial) && serial > 0);
    return { ok: true, value: serials };
}

export interface PushRequest {
    // Together these form the credential id the key files it under
    issuer: string | null;
    name: string;
    type: OathType;
    digits: number;
    // 'SHA-1' style, as the vault stores it
    algorithm: string;
    period: number;
    counter: number;
    // Always set by the panel today. Touch is the only thing that makes a
    // credential on the key harder to abuse than one in the vault: without
    // it, anything running as the user can mint codes while the key is in
    requireTouch: boolean;
}

// The one call that writes. The secret stays in the vault as well, which is
// what makes this safe to offer: the key cannot hand it back, so the vault
// copy is the only backup there will ever be
export async function pushAccount(
    serial: number | null,
    request: PushRequest,
    secret: string,
    password: string | null
): Promise<OathResult<true>> {
    return withCard(() => pushAccountUnlocked(serial, request, secret, password));
}

async function pushAccountUnlocked(
    serial: number | null,
    request: PushRequest,
    secret: string,
    password: string | null
): Promise<OathResult<true>> {
    const binary = await findYkman();
    if (!binary) return { ok: false, error: 'ykman-missing' };
    const device = serial === null ? [] : ['--device', String(serial)];

    const args = [...device, 'oath', 'accounts', 'add', '-f'];
    if (request.issuer) args.push('-i', request.issuer);
    args.push('-o', request.type.toLowerCase());
    args.push('-d', String(request.digits));
    args.push('-a', request.algorithm.replace('-', '').toLowerCase());
    // ykman rejects a period on a counter-based account
    if (request.type === 'TOTP') args.push('-P', String(request.period));
    else args.push('-c', String(request.counter));
    if (request.requireTouch) args.push('-t');
    // The name is an entry title the vault may have got from an import or the
    // browser. `--` keeps a leading dash from being read as an option: a name
    // of --help makes ykman print help and exit 0, which reads here as a
    // successful write that never happened
    args.push('--', request.name);

    // The secret answers `add`'s own prompt, after the password prompt when
    // the applet is locked
    const result = await run(binary, args, [...answers(password), secret], LIST_TIMEOUT_MS);
    if (result.spawnError || result.code !== 0) return fail(result);
    return { ok: true, value: true };
}

// Whether to offer OATH actions in the UI. A Yubico device on the HID bus is
// the responsive signal, and ykman being installed is the fallback that
// covers a CCID-only key, which no HID enumeration can see. ykman is a hard
// prerequisite either way, so its presence is a fair proxy for owning a key
export async function oathWorthOffering(devicePresent: boolean): Promise<boolean> {
    return devicePresent || (await findYkman()) !== null;
}
