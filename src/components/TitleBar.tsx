import { useEffect, useState } from 'react';
import { LogoIcon, LockIcon, MinimizeIcon, MaximizeIcon, CloseIcon } from '../icons';
import { SettingsIcon } from '../icons/SettingsIcon';
import { SecurityShieldIcon } from '../icons/status/StatusIcons';
import './TitleBar.css';

interface TitleBarProps {
	inPasswordView?: boolean;
	onLock?: () => void;
	searchQuery?: string;
	onSearch?: (query: string) => void;
	onOpenSettings?: () => void;
	onOpenSecurityReport?: () => void;
}

export function TitleBar({ inPasswordView, onLock, searchQuery = '', onSearch, onOpenSettings, onOpenSecurityReport }: TitleBarProps) {
	const [isMaximized, setIsMaximized] = useState(false);
	const [isMacOS, setIsMacOS] = useState(false);
	const [isFullscreen, setIsFullscreen] = useState(false);
	// The input is its own source of truth while typing; the vault-wide
	// filter (a full scan and sort per change) follows a beat behind instead
	// of running on every keystroke
	const [localQuery, setLocalQuery] = useState(searchQuery);

	// External rewrites of the query (a tag click) land in the box too
	useEffect(() => {
		setLocalQuery(searchQuery);
	}, [searchQuery]);

	useEffect(() => {
		if (localQuery === searchQuery) return;
		const timer = setTimeout(() => onSearch?.(localQuery), 150);
		return () => clearTimeout(timer);
	}, [localQuery]);

	useEffect(() => {
		// Only run in electron environment
		if (!window.electron) return;

		const unsubscribe = window.electron.onMaximizeChange((maximized: boolean) => {
			setIsMaximized(maximized);
		});
		const unsubscribeFullscreen = window.electron.on('fullscreen-change', (fullscreen: boolean) => {
			setIsFullscreen(fullscreen);
		});

		// Check if we're on macOS
		window.electron.getPlatform().then(platform => {
			setIsMacOS(platform === 'darwin');
		});

		return () => {
			unsubscribe();
			unsubscribeFullscreen();
		};
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
		<div className={`title-bar ${inPasswordView ? 'in-password-view' : ''} ${isMacOS ? 'macos' : ''} ${isFullscreen ? 'fullscreen' : ''}`}>
			<div className="title-bar-drag-area">
				<LogoIcon className="title-bar-logo" />
				<span className="title-bar-text">Vigil</span>
				{inPasswordView && (
					<div className="title-bar-controls">
						<div className="search-container">
							{/* Focused as the vault opens so the first keystroke
							    searches instead of going nowhere. The whole
							    title bar is a fresh mount at that point (App
							    swaps branches on `database`), so this fires
							    once per unlock rather than on every render */}
							<input
								type="text"
								className="search-input"
								placeholder="Search passwords..."
								value={localQuery}
								autoFocus
								onChange={(e) => setLocalQuery(e.target.value)}
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
					{onOpenSecurityReport && (
						<button className="settings-button" onClick={onOpenSecurityReport} title="Security report">
							<SecurityShieldIcon />
						</button>
					)}
					<button className="settings-button" onClick={onOpenSettings} title="Settings">
						<SettingsIcon />
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
				<>
					{onOpenSecurityReport && (
						<button className="settings-button macos-settings macos-report" onClick={onOpenSecurityReport} title="Security report">
							<SecurityShieldIcon />
						</button>
					)}
					<button className="settings-button macos-settings" onClick={onOpenSettings} title="Settings">
						<SettingsIcon />
					</button>
				</>
			)}
		</div>
	);
}