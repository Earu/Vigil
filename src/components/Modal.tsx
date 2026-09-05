import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface ModalProps {
    // The existing overlay and dialog classes; the markup stays what the
    // stylesheets already target
    overlayClassName: string;
    className: string;
    // id of the heading inside children
    labelledBy: string;
    describedBy?: string;
    // Escape calls this. Left out for dialogs with no cancel path
    onClose?: () => void;
    closeOnOverlayClick?: boolean;
    // 'first' (default) focuses the first tabbable, 'container' the dialog
    // itself. A child with autoFocus wins over either
    initialFocus?: 'first' | 'container' | React.RefObject<HTMLElement>;
    // Where focus goes on close when the element that opened the dialog is
    // gone
    restoreFocusTo?: () => HTMLElement | null;
    role?: 'dialog' | 'alertdialog';
    children: React.ReactNode;
}

const TABBABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
].join(', ');

// No offsetParent check: jsdom has no layout and would exclude everything
const isVisible = (el: HTMLElement): boolean => {
    if (el.closest('[hidden]')) return false;
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden';
};

const tabbables = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(TABBABLE)).filter(isVisible);

// Everything behind the dialog is made inert (unfocusable, unclickable and
// hidden from assistive technology) for as long as it is open, and focus
// goes back to the opener when it closes. Nested dialogs compose: each one
// only marks what the outer ones had not, and only restores its own.
//
// A control inside a dialog that wants Escape for itself calls
// preventDefault on the keydown first.
export const Modal = ({
    overlayClassName,
    className,
    labelledBy,
    describedBy,
    onClose,
    closeOnOverlayClick,
    initialFocus = 'first',
    restoreFocusTo,
    role = 'dialog',
    children,
}: ModalProps) => {
    const overlayRef = useRef<HTMLDivElement>(null);
    const dialogRef = useRef<HTMLDivElement>(null);
    // Captured during the first render, before a child autoFocus commits
    const [opener] = useState(() => document.activeElement as HTMLElement | null);
    const onCloseRef = useRef(onClose);
    onCloseRef.current = onClose;
    const restoreRef = useRef(restoreFocusTo);
    restoreRef.current = restoreFocusTo;

    useLayoutEffect(() => {
        const marked: Element[] = [];
        let node: Element | null = overlayRef.current;
        while (node && node !== document.body) {
            const parent: Element | null = node.parentElement;
            if (!parent) break;
            for (const sibling of Array.from(parent.children)) {
                if (sibling === node) continue;
                if (sibling.hasAttribute('inert') || sibling.hasAttribute('data-modal-exempt')) continue;
                sibling.setAttribute('inert', '');
                marked.push(sibling);
            }
            node = parent;
        }
        return () => {
            for (const el of marked) el.removeAttribute('inert');
            // After the removal, or the opener is still inert and refuses focus
            if (opener?.isConnected && !opener.closest('[inert]')) opener.focus();
            else restoreRef.current?.()?.focus();
        };
    }, [opener]);

    useEffect(() => {
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (dialog.contains(document.activeElement)) return;
        if (typeof initialFocus === 'object') {
            (initialFocus.current ?? dialog).focus();
        } else if (initialFocus === 'container') {
            dialog.focus();
        } else {
            (tabbables(dialog)[0] ?? dialog).focus();
        }
        // Only on mount: a re-render must not yank focus around
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (e.defaultPrevented) return;
        const dialog = dialogRef.current;
        if (!dialog) return;
        if (e.key === 'Escape') {
            if (!onCloseRef.current) return;
            e.preventDefault();
            e.stopPropagation();
            onCloseRef.current();
            return;
        }
        if (e.key !== 'Tab') return;
        const items = tabbables(dialog);
        const active = document.activeElement as HTMLElement | null;
        if (items.length === 0) {
            e.preventDefault();
            e.stopPropagation();
            dialog.focus();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        const outside = !active || !dialog.contains(active);
        if (e.shiftKey && (outside || active === first || active === dialog)) {
            e.preventDefault();
            e.stopPropagation();
            last.focus();
        } else if (!e.shiftKey && (outside || active === last)) {
            e.preventDefault();
            e.stopPropagation();
            first.focus();
        }
    };

    const onOverlayClick = (e: React.MouseEvent<HTMLDivElement>) => {
        // Keeps a click in a nested dialog from reaching the outer overlay
        e.stopPropagation();
        if (closeOnOverlayClick && e.target === e.currentTarget) onCloseRef.current?.();
    };

    return (
        <div ref={overlayRef} className={overlayClassName} onClick={onOverlayClick}>
            <div
                ref={dialogRef}
                className={className}
                role={role}
                aria-modal="true"
                aria-labelledby={labelledBy}
                aria-describedby={describedBy}
                tabIndex={-1}
                onKeyDown={onKeyDown}
            >
                {children}
            </div>
        </div>
    );
};
