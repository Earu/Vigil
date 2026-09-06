import React from 'react';
import './ErrorBoundary.css';
import { ClipboardService } from '../services/ClipboardService';

interface ErrorBoundaryState {
	crashed: boolean;
}

// The last line between a thrown render or effect and a blank window. With
// nothing to catch it React unmounts the whole tree, which here takes the open
// vault, the auto-lock timer and the unsaved-changes flag with it while the
// main process still believes a vault is open.
//
// The thrown error never reaches the screen: an exception message can carry
// whatever the code that threw was holding, and this is a password manager.
// It goes to the log file instead.
export class ErrorBoundary extends React.Component<{ children: React.ReactNode }, ErrorBoundaryState> {
	state: ErrorBoundaryState = { crashed: false };

	static getDerivedStateFromError(): ErrorBoundaryState {
		return { crashed: true };
	}

	componentDidCatch(error: Error, info: React.ErrorInfo): void {
		// console.error is forwarded to the main process log by errorReporting;
		// the component stack is names only
		console.error('Renderer crashed:', error, info.componentStack);

		// The tree that held the vault is gone, so the session it stood for is
		// over: release the keys it put in the agent, drop the guard that would
		// otherwise hold the window closed on a form nothing renders any more,
		// and take back what it copied instead of waiting out the countdown
		try { ClipboardService.clearNow(); } catch { /* best effort on the way down */ }
		window.electron?.setUnsavedChanges(false).catch(() => {});
		window.electron?.reportVaultClosed().catch(() => {});
	}

	render() {
		if (!this.state.crashed) return this.props.children;
		return (
			// Draggable because the custom title bar went down with the tree,
			// leaving a frameless window the user could not otherwise move
			<div className="crash-screen" role="alert">
				<div className="crash-panel">
					<h1>Vigil hit an unexpected error</h1>
					<p>
						The vault was closed and any unsaved changes are gone. What went wrong
						is in the log file. Reload to unlock again.
					</p>
					<button className="crash-reload" onClick={() => window.location.reload()} autoFocus>
						Reload
					</button>
				</div>
			</div>
		);
	}
}
