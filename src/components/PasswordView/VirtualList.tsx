import { ReactNode, useLayoutEffect, useMemo, useRef, useState } from 'react';

// Windowed rendering for the report lists, same approach as EntryList:
// measured row height, overscan, spacer divs keeping scrollbar geometry.
// The list is a direct child of the scrolling element (which may hold other
// content above it), so offsets are taken relative to the list's own top.
// Items of unequal height (reused clusters) declare a unit count via
// itemUnits; item height is then modeled as chrome + units * unitHeight,
// both measured from the first rendered item.

const OVERSCAN = 10;

interface VirtualListProps<T> {
    items: T[];
    // Must return a keyed element
    renderItem: (item: T) => ReactNode;
    className: string;
    // Units per item for variable-height items; omit for uniform rows
    itemUnits?: (item: T) => number;
    // Selector for one unit inside an item, required with itemUnits
    unitSelector?: string;
}

interface Geometry {
    listTop: number;
    gap: number;
    unitHeight: number;
    chrome: number;
    measured: boolean;
}

export function VirtualList<T>({ items, renderItem, className, itemUnits, unitSelector }: VirtualListProps<T>) {
    const wrapperRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(600);
    const [geom, setGeom] = useState<Geometry>({
        listTop: 0,
        gap: 0,
        unitHeight: 60,
        chrome: itemUnits ? 30 : 0,
        measured: false,
    });

    // Cumulative units before each item; identity when rows are uniform
    const unitOffsets = useMemo(() => {
        if (!itemUnits) return null;
        const offsets = new Array<number>(items.length + 1);
        offsets[0] = 0;
        for (let i = 0; i < items.length; i++) {
            offsets[i + 1] = offsets[i] + itemUnits(items[i]);
        }
        return offsets;
    }, [items, itemUnits]);

    // Top of item i relative to the list start, per the height model
    const posOf = (i: number) => {
        const units = unitOffsets ? unitOffsets[i] : i;
        return units * geom.unitHeight + i * (geom.chrome + geom.gap);
    };

    // Largest index whose top is at or above y
    const indexAt = (y: number) => {
        if (y <= 0) return 0;
        let lo = 0;
        let hi = items.length;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (posOf(mid) <= y) lo = mid;
            else hi = mid - 1;
        }
        return lo;
    };

    const relTop = scrollTop - geom.listTop;
    const start = Math.max(0, indexAt(relTop) - OVERSCAN);
    const end = Math.min(items.length, indexAt(relTop + viewportHeight) + 1 + OVERSCAN);

    // Track the scroll container (the parent element) and its viewport
    useLayoutEffect(() => {
        const scroller = wrapperRef.current?.parentElement;
        if (!scroller) return;
        const onScroll = () => setScrollTop(scroller.scrollTop);
        const measure = () => setViewportHeight(scroller.clientHeight);
        onScroll();
        measure();
        scroller.addEventListener('scroll', onScroll);
        const observer = new ResizeObserver(measure);
        observer.observe(scroller);
        return () => {
            scroller.removeEventListener('scroll', onScroll);
            observer.disconnect();
        };
    }, []);

    // Heights come from CSS; measure real elements once (see EntryList for
    // why measuring on every render can loop). The list's offset inside the
    // scroller and the flex gap are cheap and refreshed every pass
    useLayoutEffect(() => {
        const wrapper = wrapperRef.current;
        const scroller = wrapper?.parentElement;
        if (!wrapper || !scroller) return;
        const listTop = wrapper.getBoundingClientRect().top
            - scroller.getBoundingClientRect().top + scroller.scrollTop;
        const gap = parseFloat(getComputedStyle(wrapper).rowGap) || 0;
        let { unitHeight, chrome, measured } = geom;
        if (!measured) {
            const first = wrapper.querySelector<HTMLElement>(':scope > :not([data-spacer])');
            if (first && first.offsetHeight > 0) {
                if (itemUnits && unitSelector) {
                    const unit = first.querySelector<HTMLElement>(unitSelector);
                    if (unit && unit.offsetHeight > 0) {
                        unitHeight = unit.offsetHeight;
                        chrome = first.offsetHeight - itemUnits(items[start]) * unitHeight;
                        measured = true;
                    }
                } else {
                    unitHeight = first.offsetHeight;
                    chrome = 0;
                    measured = true;
                }
            }
        }
        if (measured !== geom.measured || gap !== geom.gap
            || Math.abs(listTop - geom.listTop) > 0.5
            || Math.abs(unitHeight - geom.unitHeight) > 0.5
            || Math.abs(chrome - geom.chrome) > 0.5) {
            setGeom({ listTop, gap, unitHeight, chrome, measured });
        }
    });

    return (
        <div className={className} ref={wrapperRef}>
            {start > 0 && (
                <div data-spacer style={{ height: Math.max(0, posOf(start) - geom.gap) }} aria-hidden="true" />
            )}
            {items.slice(start, end).map(item => renderItem(item))}
            {end < items.length && (
                <div data-spacer style={{ height: Math.max(0, posOf(items.length) - posOf(end) - geom.gap) }} aria-hidden="true" />
            )}
        </div>
    );
}
