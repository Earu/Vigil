import { useEffect, useState } from 'react';
import './TitleBar.css';

interface TitleBarProps {
	inPasswordView?: boolean;
	onLock?: () => void;
	searchQuery?: string;
	onSearch?: (query: string) => void;
}

export function TitleBar({ inPasswordView, onLock, searchQuery = '', onSearch }: TitleBarProps) {
	const [isMaximized, setIsMaximized] = useState(false);

	useEffect(() => {
		// Only run in electron environment
		if (window.electron) {
			window.electron.onMaximizeChange((maximized: boolean) => {
				setIsMaximized(maximized);
			});
		}
	}, []);

	const handleMinimize = () => {
		window.electron?.minimizeWindow();
	};

	const handleMaximize = () => {
		window.electron?.maximizeWindow();
	};

	const handleClose = () => {
		window.electron?.closeWindow();
	};

	// Don't render title bar if not in electron
	//if (!window.electron) return null;

	return (
		<div className={`title-bar ${inPasswordView ? 'in-password-view' : ''}`}>
			<div className="title-bar-drag-area">
				<svg
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					xmlns="http://www.w3.org/2000/svg"
					className="title-bar-logo"
				>
					<path d="M12 2l7 4v6c0 5-3.5 9-7 10-3.5-1-7-5-7-10V6l7-4z" fill="#3b82f6"/>
					<circle cx="12" cy="12" r="3" fill="#ffffff"/>
					<path d="M12 5v2M12 17v2M5 12h2M17 12h2" stroke="#2563eb" strokeWidth="1.5"/>
				</svg>
				<span className="title-bar-text">Vigil</span>
				{inPasswordView && (
					<div className="title-bar-controls">
						<div className="search-container">
							<input
								type="text"
								className="search-input"
								placeholder="Search passwords..."
								value={searchQuery}
								onChange={(e) => onSearch?.(e.target.value)}
							/>
						</div>
						<button className="lock-button" onClick={onLock} title="Lock database">
							<svg
								xmlns="http://www.w3.org/2000/svg"
								viewBox="0 0 24 24"
								fill="none"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
								className="lock-icon"
							>
								<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
								<path d="M7 11V7a5 5 0 0 1 10 0v4" />
							</svg>
							Lock
						</button>
					</div>
				)}
			</div>
			<div className="window-controls">
				<button className="window-control minimize" onClick={handleMinimize}>
					<svg width="10" height="1" viewBox="0 0 10 1">
						<path d="M0 0h10v1H0z" fill="currentColor" />
					</svg>
				</button>
				<button className="window-control maximize" onClick={handleMaximize}>
					{isMaximized ? (
						<svg width="10" height="10" viewBox="0 0 10 10">
							<path d="M2.1,0v2H0v8h8V8h2V0H2.1z M7,9H1V3h6V9z" fill="currentColor" />
						</svg>
					) : (
						<svg width="10" height="10" viewBox="0 0 10 10">
							<path d="M0 0v10h10V0H0zm9 9H1V1h8v8z" fill="currentColor" />
						</svg>
					)}
				</button>
				<button className="window-control close" onClick={handleClose}>
					<svg width="10" height="10" viewBox="0 0 10 10">
						<path d="M1.41 0L0 1.41l3.59 3.59L0 8.59 1.41 10l3.59-3.59L8.59 10 10 8.59 6.41 5 10 1.41 8.59 0 5 3.59 1.41 0z" fill="currentColor" />
					</svg>
				</button>
			</div>
		</div>
	);
}