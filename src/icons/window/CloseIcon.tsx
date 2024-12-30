import React from 'react';

interface CloseIconProps {
    className?: string;
}

export const CloseIcon: React.FC<CloseIconProps> = ({ className }) => (
    <svg width="10" height="10" viewBox="0 0 10 10" className={className}>
        <path d="M1.41 0L0 1.41l3.59 3.59L0 8.59 1.41 10l3.59-3.59L8.59 10 10 8.59 6.41 5 10 1.41 8.59 0 5 3.59 1.41 0z" fill="currentColor" />
    </svg>
);