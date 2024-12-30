import React from 'react';

interface LogoIconProps {
    className?: string;
}

export const LogoIcon: React.FC<LogoIconProps> = ({ className }) => (
    <svg
        width="24"
        height="24"
        viewBox="0 0 24 24"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className={className}
    >
        <defs>
            <linearGradient id="shieldGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ffffff" />
                <stop offset="50%" stopColor="#bbbbbb" />
                <stop offset="100%" stopColor="#888888" />
            </linearGradient>
        </defs>
        <rect width="24" height="24" rx="4" ry="4" fill="#000000"/>
        <path d="M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z" fill="url(#shieldGradient)"/>
        <circle cx="12" cy="12" r="3" fill="#000000"/>
    </svg>
);