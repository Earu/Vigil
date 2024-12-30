import React from 'react';

interface StatusIconProps {
    className?: string;
    color?: string;
    style?: React.CSSProperties;
}

export const SuccessIcon: React.FC<StatusIconProps> = ({ className, color = '#10b981', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
    >
        <path d="M20 6L9 17l-5-5" />
    </svg>
);

export const ErrorIcon: React.FC<StatusIconProps> = ({ className, color = '#ef4444', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
    >
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
    </svg>
);

export const InfoIcon: React.FC<StatusIconProps> = ({ className, color = '#3b82f6', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
    >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12" y2="8" />
    </svg>
);

export const WarningIcon: React.FC<StatusIconProps> = ({ className, color = '#f59e0b', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
    >
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="16" />
        <line x1="12" y1="8" x2="12" y2="16" />
    </svg>
);

export const SpinnerIcon: React.FC<StatusIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        className={className}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        style={style}
    >
        <circle className="spinner-circle" cx="12" cy="12" r="10" />
    </svg>
);

export const BreachWarningIcon: React.FC<StatusIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
    >
        <path d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
);

export const SecurityShieldIcon: React.FC<StatusIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        className={className}
        style={style}
    >
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
    </svg>
);