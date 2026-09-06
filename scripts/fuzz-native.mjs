// Builds and runs the native addons' fuzz targets under AddressSanitizer and
// UndefinedBehaviorSanitizer.
//
//     node scripts/fuzz-native.mjs [--seconds 60] [--target pcsc] [--out <dir>]
//
// These addons are C++, so a length that disagrees with the bytes behind it
// is a read past the end rather than an exception. The rest of the fuzzing is
// property-based and lives in tests/fuzz, where a thrown JavaScript error is
// the worst outcome; the sanitizers are the oracle here, and any finding
// fails the run.
//
// The budget is per target, and every target is built and run unless --target
// names one. The Touch ID target covers more on macOS than elsewhere: its
// string handling is Objective-C and needs Foundation, so the security
// workflow runs this on a macOS runner as well.
//
// Apple's clang ships the sanitizers but not libFuzzer (Apple DTS confirms
// libclang_rt.fuzzer_osx.a is absent from Xcode, FB22185586). Upstream LLVM
// has it and links Foundation like any other clang, so on macOS the runner
// looks for a Homebrew LLVM first: the GitHub runner images ship one
// (llvm@20 on macOS 26, llvm@18 on macOS 15), and `brew install llvm` gives
// a developer machine the same. Two modes fall out of what is found:
//
//   fuzz     libFuzzer generates inputs from the corpus.
//   replay   the corpus is run through the target once, under the same
//            sanitizers and assertions, with no new inputs. A regression
//            check rather than a search, for a compiler with no libFuzzer.
//
// CXX overrides the search. --if-available turns a machine with neither into
// a skip and exit 0, so a local run on a box with only gcc is not a failure;
// CI passes no such flag.

import { execFileSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TARGETS = [
    {
        name: 'pcsc',
        source: 'electron/native/pcsc/fuzz/pcsc_fuzz.cc',
        corpus: 'electron/native/pcsc/fuzz/corpus',
    },
    {
        name: 'touchid',
        source: 'electron/native/touchid/fuzz/touchid_fuzz.cc',
        corpus: 'electron/native/touchid/fuzz/corpus',
        // The same file elsewhere: the Objective-C half compiles out, and the
        // wipe key material goes through is still covered
        darwin: ['-x', 'objective-c++', '-fobjc-arc', '-framework', 'Foundation'],
    },
];

const args = process.argv.slice(2);
const flag = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index === -1 ? fallback : args[index + 1];
};
const seconds = Number(flag('seconds', process.env.NATIVE_FUZZ_SECONDS || 60));
const outDir = path.resolve(flag('out', path.join(root, 'native-fuzz-out')));
const only = flag('target', null);
const ifAvailable = args.includes('--if-available');

const targets = only ? TARGETS.filter(t => t.name === only) : TARGETS;
if (targets.length === 0) {
    console.error(`no such target ${only}; known: ${TARGETS.map(t => t.name).join(', ')}`);
    process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

// A stuck child must fail the run, never hold it: a compiler waiting on
// something, or a target that stopped answering, is a finding about the
// setup and gets a deadline it cannot outlive
const PROBE_MS = 60_000;
const BUILD_MS = 300_000;

const quietly = (file, args) => {
    try {
        return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_MS }).trim();
    } catch {
        return null;
    }
};

// ASan on macOS 14 and later can stall or abort at startup with the nano
// malloc zone enabled; disabling it is the documented workaround, and it is
// meaningless anywhere else
const childEnv = { ...process.env, MallocNanoZone: '0' };

// A Homebrew clang builds against the SDK Xcode's would, once told where it
// is; Apple's own clang takes the flag without complaint, so it is passed to
// whichever is used
const sysroot = process.platform === 'darwin' ? quietly('xcrun', ['--show-sdk-path']) : null;
const platformFlags = sysroot ? ['-isysroot', sysroot] : [];

// What a build is instrumented with, best first. A rung is only used when a
// probe built with it also runs to completion: on macOS 26 a Homebrew LLVM
// whose sanitizer runtime predates the OS builds a binary that never gets
// past its own startup, and a compile-only check called that a success and
// left the job hanging for twenty minutes. The rungs below the first give
// up a sanitizer each, and the run says which one it settled on
const RECOVER = '-fno-sanitize-recover=all';
const LADDER = {
    fuzz: [
        ['-fsanitize=fuzzer,address,undefined', RECOVER],
        ['-fsanitize=fuzzer,undefined', RECOVER],
        ['-fsanitize=fuzzer'],
    ],
    replay: [
        ['-fsanitize=address,undefined', RECOVER],
        ['-fsanitize=undefined', RECOVER],
    ],
};

// Whether a compiler builds a probe with these flags and the result runs and
// exits 0 inside the deadline. The probe must not define main under
// -fsanitize=fuzzer: libFuzzer brings its own, and a second one is a
// duplicate symbol rather than a missing feature; that probe is then run as
// the fuzzer it is, for one input
function works(candidate, flags, ownMain) {
    const source = path.join(outDir, 'probe.cc');
    const binary = path.join(outDir, 'probe');
    fs.rmSync(binary, { force: true });
    fs.writeFileSync(source, [
        'extern "C" int LLVMFuzzerTestOneInput(const unsigned char*, unsigned long) { return 0; }',
        ...(ownMain ? ['int main() { return 0; }'] : []),
        '',
    ].join('\n'));
    const built = spawnSync(candidate, [...platformFlags, ...flags, '-o', binary, source], { stdio: 'ignore', timeout: PROBE_MS, env: childEnv });
    if (built.status !== 0) return 'does not build';
    const ran = spawnSync(binary, ownMain ? [] : ['-runs=1'], { stdio: 'ignore', timeout: PROBE_MS, env: childEnv });
    if (ran.error?.code === 'ETIMEDOUT') return `builds, but the binary hung for ${PROBE_MS / 1000}s`;
    if (ran.status !== 0) return `builds, but the binary exited ${ran.status ?? ran.signal}`;
    return null;
}

// The first rung of a ladder that works for a compiler, with what was wrong
// with each one above it
function climb(candidate, rungs, ownMain) {
    const refused = [];
    for (const flags of rungs) {
        const problem = works(candidate, flags, ownMain);
        if (problem === null) return { flags, refused };
        refused.push(`${flags[0]}: ${problem}`);
    }
    return { flags: null, refused };
}

// Every Homebrew LLVM on the machine, newest first: the unversioned formula,
// then llvm@N descending
function homebrewClangs() {
    const prefix = quietly('brew', ['--prefix']);
    if (!prefix) return [];
    const opt = path.join(prefix, 'opt');
    let names;
    try {
        names = fs.readdirSync(opt).filter(name => /^llvm(@\d+)?$/.test(name));
    } catch {
        return [];
    }
    const version = (name) => name === 'llvm' ? Infinity : Number(name.split('@')[1]);
    return names
        .sort((a, b) => version(b) - version(a))
        .map(name => path.join(opt, name, 'bin', 'clang++'))
        .filter(file => fs.existsSync(file));
}

// The compiler, the mode and the instrumentation. CXX names the compiler
// outright; otherwise on macOS every Homebrew LLVM is tried for a fuzz rung
// before Apple's clang, which has no libFuzzer and only ever gets as far as
// replay. Every rung that was passed over is reported, so the log explains
// a run that ends up with less instrumentation than the first rung
function choose() {
    const candidates = process.env.CXX ? [process.env.CXX]
        : [...(process.platform === 'darwin' ? homebrewClangs() : []), 'clang++'];
    const notes = [];
    for (const candidate of candidates) {
        const fuzz = climb(candidate, LADDER.fuzz, false);
        notes.push(...fuzz.refused.map(r => `${candidate}: ${r}`));
        if (fuzz.flags) return { compiler: candidate, mode: 'fuzz', flags: fuzz.flags, notes };
    }
    for (const candidate of candidates) {
        const replay = climb(candidate, LADDER.replay, true);
        notes.push(...replay.refused.map(r => `${candidate}: ${r}`));
        if (replay.flags) return { compiler: candidate, mode: 'replay', flags: replay.flags, notes };
    }
    return { compiler: candidates[0], mode: null, flags: null, notes };
}

const { compiler, mode, flags: sanitizers, notes } = choose();
for (const note of notes) console.log(`passed over: ${note}`);

if (mode === null) {
    const message = `${compiler} builds neither a libFuzzer target nor a sanitized one; install clang to run the native fuzzer`;
    if (ifAvailable) {
        console.log(`skipped: ${message}`);
        process.exit(0);
    }
    console.error(message);
    process.exit(2);
}

// Replay needs an entry point, since libFuzzer's is what usually provides it.
// Generated rather than tracked: it is the runner's, not the addon's, and it
// only exists for compilers without libFuzzer
function replayDriver() {
    const file = path.join(outDir, 'replay_main.cc');
    fs.writeFileSync(file, `// Generated by scripts/fuzz-native.mjs
#include <cstdint>
#include <cstdio>
#include <vector>
extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size);
int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        FILE* input = fopen(argv[i], "rb");
        if (input == nullptr) { fprintf(stderr, "cannot open %s\\n", argv[i]); return 2; }
        std::vector<uint8_t> bytes;
        uint8_t chunk[4096];
        size_t read = 0;
        while ((read = fread(chunk, 1, sizeof chunk, input)) > 0) bytes.insert(bytes.end(), chunk, chunk + read);
        fclose(input);
        // Named before it runs, so an abort says which input did it
        printf("replaying %s (%zu bytes)\\n", argv[i], bytes.size());
        fflush(stdout);
        LLVMFuzzerTestOneInput(bytes.data(), bytes.size());
    }
    printf("replayed %d input(s)\\n", argc - 1);
    return 0;
}
`);
    return file;
}

const isArtifact = (name) => /^(crash|leak|timeout|oom)-/.test(name);

function run(target) {
    const source = path.join(root, target.source);
    const binary = path.join(outDir, `${target.name}_fuzz`);
    const findings = path.join(outDir, target.name);
    const log = path.join(outDir, `${target.name}.log`);

    // Findings from an earlier run would otherwise be reported as this one's
    fs.rmSync(findings, { recursive: true, force: true });
    fs.mkdirSync(findings, { recursive: true });

    console.log(`\n== ${target.name}: building ${target.source} with ${compiler} (${mode})`);
    execFileSync(compiler, [
        '-std=c++17',
        '-g',
        '-O1',
        // Assertions are the invariants the target states; a release build
        // would compile every one of them away
        '-UNDEBUG',
        // A sanitizer report is a finding, so the process must stop at the
        // first one rather than carry on and exit 0
        ...sanitizers,
        '-fno-omit-frame-pointer',
        ...platformFlags,
        ...(process.platform === 'darwin' ? target.darwin ?? [] : []),
        '-o', binary,
        source,
        ...(mode === 'replay' ? [replayDriver()] : []),
    ], { stdio: 'inherit', timeout: BUILD_MS, env: childEnv });

    // The corpus is read-only input: findings go under outDir, and nothing a
    // run discovers is written back into the repository
    const workingCorpus = path.join(findings, 'corpus');
    fs.cpSync(path.join(root, target.corpus), workingCorpus, { recursive: true });

    const inputs = fs.readdirSync(workingCorpus).map(name => path.join(workingCorpus, name));
    console.log(mode === 'fuzz'
        ? `== ${target.name}: fuzzing for ${seconds}s`
        : `== ${target.name}: replaying ${inputs.length} corpus input(s)`);
    // libFuzzer's own per-input deadline defaults to twenty minutes; an input
    // that hangs the target is a finding and should say so in seconds. The
    // runner stops waiting a little after the budget either way
    const deadline = { encoding: 'utf8', env: childEnv, timeout: (seconds + 120) * 1000, maxBuffer: 64 * 1024 * 1024 };
    const result = mode === 'fuzz'
        ? spawnSync(binary, [
            workingCorpus,
            `-max_total_time=${seconds}`,
            '-timeout=30',
            `-artifact_prefix=${findings}${path.sep}`,
            '-rss_limit_mb=2048',
            '-max_len=4096',
            '-print_final_stats=1',
        ], deadline)
        : spawnSync(binary, inputs, deadline);

    let output = `compiler: ${compiler}\nmode: ${mode}\ninstrumentation: ${sanitizers[0]}\n${notes.map(n => `passed over: ${n}\n`).join('')}${result.stdout ?? ''}${result.stderr ?? ''}`;
    if (result.error) {
        output += `\n==runner== ERROR: runner: ${result.error.code === 'ETIMEDOUT' ? `the target did not finish within ${seconds + 120}s and was killed` : result.error.message}\n`;
    }
    process.stdout.write(output);
    fs.writeFileSync(log, output);

    if (result.status === 0) {
        console.log(`== ${target.name}: no findings`);
        return true;
    }

    // libFuzzer writes the input that reproduced the crash; it is the whole
    // reproduction, so it stays where CI can upload it. A replay crashed on an
    // input that is already in the corpus, and the log named it before it ran
    console.error(`\n== ${target.name}: finding (exit ${result.status})`);
    for (const name of fs.readdirSync(findings).filter(isArtifact)) {
        const file = path.join(findings, name);
        console.error(`  reproducer: ${path.relative(root, file)}`);
        console.error(`  base64: ${fs.readFileSync(file).toString('base64')}`);
        console.error(`  replay:  ${path.relative(root, binary)} ${path.relative(root, file)}`);
    }
    return false;
}

console.log(`compiler: ${compiler}`);
console.log(`mode: ${mode}${mode === 'replay' ? ` (${compiler} has no libFuzzer; the corpus is run once under the sanitizers. On macOS, brew install llvm)` : ''}`);
console.log(`instrumentation: ${sanitizers[0]}${sanitizers[0].includes('address') ? '' : ' (no AddressSanitizer: a read past a buffer is caught only if it crashes)'}`);
const clean = targets.map(run).every(Boolean);
console.log(`\n${targets.length} target(s), ${mode}: ${clean ? 'no findings' : 'findings above'}`);
process.exit(clean ? 0 : 1);
