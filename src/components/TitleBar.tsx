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