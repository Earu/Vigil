import { useRef } from 'react';

// Type-ahead for the tree and the grid, as in a native list view: printable
// keys typed in quick succession form a prefix, and the next item whose name
// starts with it is picked. One letter repeated cycles through the items
// starting with that letter.

const RESET_MS = 1000;

export const isTypeAheadKey = (e: { key: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean }) =>
	e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

// Index of the match for `prefix` among `names`, searching from `current`,
// wrapping, or -1. A repeated single letter starts after the current item;
// a longer prefix includes it, so extending "w" to "wo" stays on "Work"
export function findTypeAheadMatch(prefix: string, names: string[], current: number): number {
	const q = prefix.toLowerCase();
	if (!q || names.length === 0) return -1;
	const repeated = q.length > 1 && [...q].every((c) => c === q[0]);
	const needle = repeated ? q[0] : q;
	const from = repeated || q.length === 1 ? current + 1 : Math.max(0, current);
	for (let step = 0; step < names.length; step++) {
		const i = (from + step + names.length) % names.length;
		if (names[i].toLowerCase().startsWith(needle)) return i;
	}
	return -1;
}

// Returns a function that folds one key into the prefix and reports the
// index it lands on
export function useTypeAhead() {
	const state = useRef({ prefix: '', at: 0 });
	return (key: string, names: string[], current: number): number => {
		const now = Date.now();
		const s = state.current;
		s.prefix = now - s.at < RESET_MS ? s.prefix + key : key;
		s.at = now;
		return findTypeAheadMatch(s.prefix, names, current);
	};
}
