import { ReactNode } from 'react';

interface SettingRowProps {
    label?: ReactNode;
    htmlFor?: string;
    help?: ReactNode;
    disabled?: boolean;
    children?: ReactNode;
}

export const helpId = (id: string) => `${id}-help`;

export const SettingRow = ({ label, htmlFor, help, disabled, children }: SettingRowProps) => (
    <div className={`setting-row${disabled ? ' disabled' : ''}`}>
        <div className="setting-row-text">
            {label && (htmlFor ? <label htmlFor={htmlFor}>{label}</label> : <span className="setting-row-label">{label}</span>)}
            {help && <p className="setting-row-help" id={htmlFor ? helpId(htmlFor) : undefined}>{help}</p>}
        </div>
        {children && <div className="setting-row-control">{children}</div>}
    </div>
);

interface ToggleProps {
    id: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (checked: boolean) => void;
}

export const Toggle = ({ id, checked, disabled, onChange }: ToggleProps) => (
    <input
        type="checkbox"
        role="switch"
        id={id}
        className="toggle"
        checked={checked}
        disabled={disabled}
        aria-describedby={helpId(id)}
        onChange={(e) => onChange(e.target.checked)}
    />
);
