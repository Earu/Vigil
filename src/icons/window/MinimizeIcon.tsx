import React from 'react';

interface MinimizeIconProps {
    className?: string;
}

export const MinimizeIcon: React.FC<MinimizeIconProps> = ({ className }) => (
    <svg width="10" height="1" viewBox="0 0 10 1" className={className}>
        <path d="M0 0h10v1H0z" fill="currentColor" />
    </svg>
);