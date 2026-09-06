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
// clang is required (libFuzzer ships with it). --if-available turns a machine
// without it into a skip and exit 0, so a local run on a box with only gcc is
// not a failure; CI passes no such flag.

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

const compiler = process.env.CXX || 'clang++';
const targets = only ? TARGETS.filter(t => t.name === only) : TARGETS;
if (targets.length === 0) {
    console.error(`no such target ${only}; known: ${TARGETS.map(t => t.name).join(', ')}`);
    process.exit(2);
}

fs.mkdirSync(outDir, { recursive: true });

function hasLibFuzzer() {
    const probe = path.join(outDir, 'probe.cc');
    fs.writeFileSync(probe, 'extern "C" int LLVMFuzzerTestOneInput(const unsigned char*, unsigned long) { return 0; }\n');
    const result = spawnSync(compiler, ['-fsanitize=fuzzer', '-o', path.join(outDir, 'probe'), probe], { stdio: 'ignore' });
    return result.status === 0;
}

if (!hasLibFuzzer()) {
    const message = `${compiler} cannot build a libFuzzer target; install clang to run the native fuzzer`;
    if (ifAvailable) {
        console.log(`skipped: ${message}`);
        process.exit(0);
    }
    console.error(message);
    process.exit(2);
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

    console.log(`\n== ${target.name}: building ${target.source} with ${compiler}`);
    execFileSync(compiler, [
        '-std=c++17',
        '-g',
        '-O1',
        // Assertions are the invariants the target states; a release build
        // would compile every one of them away
        '-UNDEBUG',
        '-fsanitize=fuzzer,address,undefined',
        // A sanitizer report is a finding, so the process must stop at the
        // first one rather than carry on and exit 0
        '-fno-sanitize-recover=all',
        '-fno-omit-frame-pointer',
        ...(process.platform === 'darwin' ? target.darwin ?? [] : []),
        '-o', binary,
        source,
    ], { stdio: 'inherit' });

    // The corpus is read-only input: findings go under outDir, and nothing a
    // run discovers is written back into the repository
    const workingCorpus = path.join(findings, 'corpus');
    fs.cpSync(path.join(root, target.corpus), workingCorpus, { recursive: true });

    console.log(`== ${target.name}: fuzzing for ${seconds}s`);
    const result = spawnSync(binary, [
        workingCorpus,
        `-max_total_time=${seconds}`,
        `-artifact_prefix=${findings}${path.sep}`,
        '-rss_limit_mb=2048',
        '-max_len=4096',
        '-print_final_stats=1',
    ], { encoding: 'utf8' });

    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
    process.stdout.write(output);
    fs.writeFileSync(log, output);

    if (result.status === 0) {
        console.log(`== ${target.name}: no findings`);
        return true;
    }

    // libFuzzer writes the input that reproduced the crash; it is the whole
    // reproduction, so it stays where CI can upload it
    console.error(`\n== ${target.name}: finding (exit ${result.status})`);
    for (const name of fs.readdirSync(findings).filter(isArtifact)) {
        const file = path.join(findings, name);
        console.error(`  reproducer: ${path.relative(root, file)}`);
        console.error(`  base64: ${fs.readFileSync(file).toString('base64')}`);
        console.error(`  replay:  ${path.relative(root, binary)} ${path.relative(root, file)}`);
    }
    return false;
}

const clean = targets.map(run).every(Boolean);
console.log(`\n${targets.length} target(s): ${clean ? 'no findings' : 'findings above'}`);
process.exit(clean ? 0 : 1);
