import fc from 'fast-check';
import { vi } from 'vitest';

// Shared settings for the property-based fuzz suites under tests/fuzz.
//
// These run as part of the ordinary test suite with a small budget, so a
// regression at a trust boundary fails a normal push. The security workflow
// raises FUZZ_RUNS by an order of magnitude or two for the scheduled deep
// pass. Every run is seeded, so a failure reports the seed and the exact
// counterexample it shrank to, reproducible with FUZZ_SEED

export const RUNS = Number(process.env.FUZZ_RUNS) || 150;

// A property's wall time grows with its budget; the per-test timeout has to
// as well, or the deep pass fails on the clock rather than on a finding.
// Applies to whichever test file imports this
vi.setConfig({ testTimeout: Math.max(10_000, RUNS * 30) });

const seed = process.env.FUZZ_SEED ? Number(process.env.FUZZ_SEED) : undefined;

export const settings = <T>(overrides: fc.Parameters<T> = {}): fc.Parameters<T> => ({
    numRuns: RUNS,
    ...(seed !== undefined ? { seed } : {}),
    ...overrides,
});

// Text of every shape a parser might meet: plain ASCII, full unicode, empty,
// whitespace, control characters, and the delimiters this codebase splits on
export const anyText = (): fc.Arbitrary<string> => fc.oneof(
    { weight: 3, arbitrary: fc.string() },
    { weight: 3, arbitrary: fc.string({ unit: 'binary' }) },
    { weight: 1, arbitrary: fc.constantFrom('', ' ', '\n', '\r\n', '\t', '\0', '{', '}', '"', "'", ':', ';', ',', '=', '\\', '/', '//', '://') },
    { weight: 1, arbitrary: fc.stringMatching(/^[{}:@A-Za-z0-9 _\-.]{0,40}$/) },
);

// Anything JSON can carry, plus the values a careless caller might hand over
export const anyValue = (): fc.Arbitrary<unknown> => fc.oneof(
    { weight: 3, arbitrary: fc.jsonValue() },
    { weight: 1, arbitrary: fc.anything() },
);

export const bytes = (max = 512): fc.Arbitrary<Uint8Array> => fc.uint8Array({ maxLength: max });

// Wall-clock guard for a single property run: a parser that hangs on an
// input is as much a finding as one that throws
export const withinMs = async (limit: number, work: () => Promise<unknown> | unknown): Promise<void> => {
    const start = performance.now();
    await work();
    const elapsed = performance.now() - start;
    if (elapsed > limit) throw new Error(`took ${Math.round(elapsed)}ms, limit ${limit}ms`);
};
