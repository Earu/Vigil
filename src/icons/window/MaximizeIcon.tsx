import React from 'react';

interface MaximizeIconProps {
    className?: string;
    isMaximized?: boolean;
}

export const MaximizeIcon: React.FC<MaximizeIconProps> = ({ className, isMaximized }) => (
    isMaximized ? (
        <svg width="10" height="10" viewBox="0 0 10 10" className={className}>
            <path d="M2.1,0v2H0v8h8V8h2V0H2.1z M7,9H1V3h6V9z" fill="currentColor" />
        </svg>
    ) : (
        <svg width="10" height="10" viewBox="0 0 10 10" className={className}>
            <path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor" />
        </svg>
    )
);