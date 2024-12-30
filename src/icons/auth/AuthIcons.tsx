import React from 'react';

interface AuthIconProps {
    className?: string;
    color?: string;
    style?: React.CSSProperties;
}

export const LockAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        className={className}
        style={style}
    >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
);

export const UploadAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
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
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
        <polyline points="17 8 12 3 7 8" />
        <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
);

export const BrowseAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        className={className}
        style={style}
    >
        <path d="M20 11.08V8l-6-6H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2v-3.08" />
        <path d="M14 3v5h5M18 21v-6M15 18h6" />
    </svg>
);

export const BiometricAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        className={className}
        style={style}
    >
        <path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2z"/>
        <path d="M12 6c-1.7 0-3 1.3-3 3v1c0 1.7 1.3 3 3 3s3-1.3 3-3V9c0-1.7-1.3-3-3-3z"/>
        <path d="M18 12c0 3.3-2.7 6-6 6s-6-2.7-6-6"/>
    </svg>
);

export const ShowPasswordIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        className={className}
        style={style}
    >
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
    </svg>
);

export const HidePasswordIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        className={className}
        style={style}
    >
        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
        <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
);

export const UnlockAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
    <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth="2"
        className={className}
        style={style}
    >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 9.9-1" />
    </svg>
);