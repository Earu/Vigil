import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './FocusTooltip.css';

// Native title tooltips only show on hover. This shows the focused element's
// title when focus got there from the keyboard, so the icon-only buttons
// explain themselves on Tab as they do on hover. Visual only: the title is
// already the element's accessible name.

interface Tip {
	text: string;
	left: number;
	top: number;
}

export const FocusTooltip = () => {
	const [tip, setTip] = useState<Tip | null>(null);
	const ref = useRef<HTMLDivElement>(null);

	useEffect(() => {
		let keyboard = false;
		const hide = () => setTip(null);
		const onKeyDown = (e: KeyboardEvent) => {
			keyboard = true;
			if (e.key === 'Escape') hide();
		};
		const onPointer = () => { keyboard = false; };
		const onFocusIn = (e: FocusEvent) => {
			const el = e.target;
			if (!keyboard || !(el instanceof HTMLElement) || !el.title) { hide(); return; }
			const r = el.getBoundingClientRect();
			setTip({ text: el.title, left: r.left + r.width / 2, top: r.bottom + 6 });
		};
		document.addEventListener('keydown', onKeyDown, true);
		document.addEventListener('pointerdown', onPointer, true);
		document.addEventListener('focusin', onFocusIn);
		document.addEventListener('focusout', hide);
		window.addEventListener('scroll', hide, true);
		window.addEventListener('resize', hide);
		return () => {
			document.removeEventListener('keydown', onKeyDown, true);
			document.removeEventListener('pointerdown', onPointer, true);
			document.removeEventListener('focusin', onFocusIn);
			document.removeEventListener('focusout', hide);
			window.removeEventListener('scroll', hide, true);
			window.removeEventListener('resize', hide);
		};
	}, []);

	// Keep it inside the window: shift horizontally, flip above when the
	// bottom edge is too close. Applied to the element directly, once per
	// tip, since the measurement depends on the position
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || !tip) return;
		const r = el.getBoundingClientRect();
		const margin = 8;
		let dx = 0;
		if (r.left < margin) dx = margin - r.left;
		else if (r.right > window.innerWidth - margin) dx = window.innerWidth - margin - r.right;
		const above = r.bottom > window.innerHeight - margin;
		el.style.left = `${tip.left + dx}px`;
		el.style.top = `${above ? tip.top - 12 - r.height : tip.top}px`;
	}, [tip]);

	if (!tip) return null;
	return (
		<div ref={ref} className="focus-tooltip" aria-hidden="true" data-modal-exempt="" style={{ left: tip.left, top: tip.top }}>
			{tip.text}
		</div>
	);
};
