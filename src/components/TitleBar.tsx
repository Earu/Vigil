import { useEffect, useState } from 'react';
import { LogoIcon, LockIcon, MinimizeIcon, MaximizeIcon, CloseIcon } from '../icons';
import './TitleBar.css';

interface TitleBarProps {
	inPasswordView?: boolean;
	onLock?: () => void;
	searchQuery?: string;
	onSearch?: (query: string) => void;
	onOpenSettings?: () => void;
}

export function TitleBar({ inPasswordView, onLock, searchQuery = '', onSearch, onOpenSettings }: TitleBarProps) {
	const [isMaximized, setIsMaximized] = useState(false);
	const [isMacOS, setIsMacOS] = useState(false);

	useEffect(() => {
		// Only run in electron environment
		if (window.electron) {
			window.electron.onMaximizeChange((maximized: boolean) => {
				setIsMaximized(maximized);
			});

			// Check if we're on macOS
			window.electron.getPlatform().then(platform => {
				setIsMacOS(platform === 'darwin');
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

	return (
		<div className={`title-bar ${inPasswordView ? 'in-password-view' : ''} ${isMacOS ? 'macos' : ''}`}>
			{isMacOS && (
				<div className="macos-window-controls">
					<button className="window-control close" onClick={handleClose} />
					<button className="window-control minimize" onClick={handleMinimize} />
					<button className="window-control maximize" onClick={handleMaximize} />
				</div>
			)}
			<div className="title-bar-drag-area">
				<LogoIcon className="title-bar-logo" />
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
							<LockIcon className="lock-icon" />
							Lock
						</button>
					</div>
				)}
			</div>
			{!isMacOS && (
				<div className="window-controls">
					<button className="settings-button" onClick={onOpenSettings} title="Settings">
						<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
							<circle cx="12" cy="12" r="3"></circle>
							<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
						</svg>
					</button>
					<button className="window-control minimize" onClick={handleMinimize}>
						<MinimizeIcon />
					</button>
					<button className="window-control maximize" onClick={handleMaximize}>
						<MaximizeIcon isMaximized={isMaximized} />
					</button>
					<button className="window-control close" onClick={handleClose}>
						<CloseIcon />
					</button>
				</div>
			)}
			{isMacOS && (
				<button className="settings-button macos-settings" onClick={onOpenSettings} title="Settings">
					<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
						<circle cx="12" cy="12" r="3"></circle>
						<path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
					</svg>
				</button>
			)}
		</div>
	);
}