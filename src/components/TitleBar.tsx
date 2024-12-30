import { useEffect, useState } from 'react';
import { LogoIcon, LockIcon, MinimizeIcon, MaximizeIcon, CloseIcon } from '../icons';
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

	return (
		<div className={`title-bar ${inPasswordView ? 'in-password-view' : ''}`}>
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
			<div className="window-controls">
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
		</div>
	);
}