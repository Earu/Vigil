import { useCallback, useEffect, useState } from 'react';
import { ActiveShare, SecretShareService } from '../../services/SecretShareService';
import { ClipboardService } from '../../services/ClipboardService';
import './Share.css';

interface SharePanelProps {
	share: ActiveShare;
}

// Whole units, because a code that lasts a day should not be counted out in
// minutes
const timeLeft = (endsAt: Date, now: number): string => {
	const minutes = Math.max(0, Math.ceil((endsAt.getTime() - now) / 60_000));
	if (minutes < 60) return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
	const days = Math.round(hours / 24);
	return `${days} days`;
};

// What the sender reads out when the recipient asks. The code is derived on
// demand from the entry, so nothing here is stored and nothing is consumed:
// closing the panel and coming back gives the same code until the window ends
export const SharePanel = ({ share }: SharePanelProps) => {
	const [now, setNow] = useState(() => Date.now());
	const [current, setCurrent] = useState<{ code: string; index: number; endsAt: Date } | null>(null);
	const [next, setNext] = useState<string | null>(null);
	const [showWords, setShowWords] = useState(false);

	const schedule = share.schedule;
	const expired = schedule !== null && SecretShareService.windowIndexAt(schedule, now) >= schedule.count;

	useEffect(() => {
		const timer = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(timer);
	}, []);

	// Recomputed when the window rolls over, not every tick
	const index = schedule ? SecretShareService.windowIndexAt(schedule, now) : -1;
	useEffect(() => {
		let live = true;
		if (!schedule || expired) {
			setCurrent(null);
			setNext(null);
			return;
		}
		SecretShareService.currentCode(share, now).then(result => {
			if (live) setCurrent(result);
		}).catch(() => { if (live) setCurrent(null); });
		setNext(null);
		return () => { live = false; };
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [share.secret, index, expired]);

	const revealNext = useCallback(async () => {
		if (!schedule || index + 1 >= schedule.count) return;
		const code = await SecretShareService.codeFor(share.secret, index + 1, schedule.codeLength);
		setNext(SecretShareService.formatCode(index + 1, code));
	}, [share.secret, schedule, index]);

	const copy = (value: string, label: string) => ClipboardService.copy(value, label, 'share');

	return (
		<div className="share-panel">
			{schedule && expired && (
				<p className="share-panel-note">
					This stopped working on {SecretShareService.expiresAt(schedule).toLocaleDateString()}. Nothing opens that file now.
				</p>
			)}

			{schedule && !expired && current && (
				<>
					<div className="share-code-row">
						<code className="share-code">{current.code}</code>
						<button className="share-code-copy" onClick={() => copy(current.code, 'Code')}>Copy</button>
					</div>
					<p className="share-panel-note">
						Read this out when they ask. It stops working in {timeLeft(current.endsAt, now)}.
					</p>
					{next ? (
						<div className="share-code-row">
							<code className="share-code share-code-next">{next}</code>
							<button className="share-code-copy" onClick={() => copy(next, 'Code')}>Copy</button>
						</div>
					) : (
						index + 1 < schedule.count && (
							<button className="share-panel-link" onClick={revealNext}>
								Show the next code
							</button>
						)
					)}
				</>
			)}

			{share.phrase && (
				<div className="share-words">
					<span className="share-words-label">Passphrase</span>
					{showWords ? (
						<>
							<code className="share-words-value">{share.phrase}</code>
							<button className="share-code-copy" onClick={() => copy(share.phrase, 'Passphrase')}>Copy</button>
						</>
					) : (
						<button className="share-panel-link" onClick={() => setShowWords(true)}>Show</button>
					)}
				</div>
			)}

			{!schedule && (
				<p className="share-panel-note">
					Anyone with the file and this passphrase can open it, whenever they like. Change the password to end that.
				</p>
			)}
		</div>
	);
};
