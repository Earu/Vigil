// Turns the security workflow's outputs into SARIF, so failures show up as
// code scanning alerts in the repository's Security tab next to CodeQL's,
// each anchored to a file and line and closed automatically once a later
// run no longer reports them.
//
//     node scripts/sarif-report.mjs vitest <vitest.json>... --out <file>
//     node scripts/sarif-report.mjs fuses  <check-fuses log>  --out <file>
//     node scripts/sarif-report.mjs smoke  <smoke-boot log>   --out <file>
//
// A run with nothing to report still writes a valid, empty SARIF file: the
// upload of an empty result set is what resolves the previous run's alerts.

import fs from 'fs';
import path from 'path';

const TOOL = {
    vitest: { name: 'Vigil fuzz and hardening invariants', uri: 'https://github.com/Earu/Vigil/tree/main/tests/fuzz' },
    fuses: { name: 'Vigil fuse check', uri: 'https://github.com/Earu/Vigil/blob/main/scripts/check-fuses.mjs' },
    smoke: { name: 'Vigil boot smoke test', uri: 'https://github.com/Earu/Vigil/blob/main/scripts/smoke-boot.mjs' },
};

const args = process.argv.slice(2);
const mode = args[0];
const outIndex = args.indexOf('--out');
if (!TOOL[mode] || outIndex === -1 || !args[outIndex + 1]) {
    console.error('usage: sarif-report.mjs <vitest|fuses|smoke> <input>... --out <file>');
    process.exit(2);
}
const inputs = args.slice(1, outIndex);
const outFile = args[outIndex + 1];

const root = process.cwd();
const relative = (file) => path.relative(root, path.resolve(file)).split(path.sep).join('/');
const stripAnsi = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

const rules = new Map();
const results = [];

function report({ ruleId, title, message, file, line }) {
    if (!rules.has(ruleId)) {
        rules.set(ruleId, { id: ruleId, name: ruleId, shortDescription: { text: title }, defaultConfiguration: { level: 'error' } });
    }
    results.push({
        ruleId,
        level: 'error',
        message: { text: message },
        locations: [{
            physicalLocation: {
                artifactLocation: { uri: relative(file), uriBaseId: '%SRCROOT%' },
                region: { startLine: Math.max(1, line || 1) },
            },
        }],
    });
}

// Where in the test file the failure sits: the reporter's own location when
// the run recorded one, else the first stack frame inside that file
function lineOf(assertion, file, text) {
    if (assertion.location?.line) return assertion.location.line;
    const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const frame = text.match(new RegExp(`${escaped}:(\\d+):\\d+`));
    return frame ? Number(frame[1]) : 1;
}

function fromVitest(file) {
    const json = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const suite of json.testResults ?? []) {
        for (const assertion of suite.assertionResults ?? []) {
            if (assertion.status !== 'failed') continue;
            const text = stripAnsi((assertion.failureMessages ?? []).join('\n'));
            // The property's verdict first: fast-check's counterexample and
            // seed are the reproduction, the rest is the stack
            const keep = text.split('\n').filter(l => /Counterexample|seed|Caused by|Error|expected|took/.test(l) && !/^\s+at /.test(l));
            const detail = (keep.length > 0 ? keep : text.split('\n')).slice(0, 8).join('\n').trim();
            report({
                ruleId: slug(assertion.fullName),
                title: assertion.fullName,
                message: `${assertion.fullName}\n\n${detail}`,
                file: suite.name,
                line: lineOf(assertion, suite.name, text),
            });
        }
    }
}

function fromFuses(file) {
    const config = fs.readFileSync(path.join(root, 'electron-builder.config.js'), 'utf8').split('\n');
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = raw.match(/^FAIL (\w+): (.*)$/);
        if (!match) continue;
        const [, key, detail] = match;
        const line = config.findIndex(l => new RegExp(`"?${key}"?\\s*:`).test(l)) + 1;
        report({
            ruleId: `fuse-${slug(key)}`,
            title: `Packaged binary fuse ${key} does not match the configuration`,
            message: `The fuse wire read out of the packaged binary disagrees with electron-builder.config.js for ${key}: ${detail}`,
            file: 'electron-builder.config.js',
            line,
        });
    }
}

function fromSmoke(file) {
    for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
        const match = raw.match(/^FAIL (.+?)(?::\s*(.*))?$/);
        if (!match) continue;
        const [, check, detail] = match;
        report({
            ruleId: `boot-${slug(check)}`,
            title: `Packaged binary failed the boot check: ${check}`,
            message: `The packaged app did not pass "${check}"${detail ? `: ${detail}` : ''}. A build that fails here cannot open a window, render the unlock screen, or answer IPC.`,
            file: 'scripts/smoke-boot.mjs',
            line: 1,
        });
    }
}

const handlers = { vitest: fromVitest, fuses: fromFuses, smoke: fromSmoke };
for (const input of inputs) {
    if (!fs.existsSync(input)) {
        console.error(`missing input ${input}; reporting nothing for it`);
        continue;
    }
    handlers[mode](input);
}

const sarif = {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/main/sarif-2.1/schema/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
        tool: {
            driver: {
                name: TOOL[mode].name,
                informationUri: TOOL[mode].uri,
                version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version,
                rules: [...rules.values()],
            },
        },
        results,
    }],
};
fs.writeFileSync(outFile, JSON.stringify(sarif, null, 2));
console.log(`${outFile}: ${results.length} result(s) from ${inputs.length} input(s)`);
