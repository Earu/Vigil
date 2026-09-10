import { useEffect, useRef, useState } from 'react';
import { Modal } from '../Modal';
import { ActiveShare, SecretShareService, SharePart, ShareOptions } from '../../services/SecretShareService';
import { ChevronActionIcon } from '../../icons/actions/ActionIcons';
import { SharePanel } from './SharePanel';
import '../BrowserPairingDialog.css';
import '../PasskeyConsentDialog.css';
import './Share.css';

interface ShareModalProps {
	entryTitle: string;
	// Everything on the entry that could go into the file
	parts: SharePart[];
	// One per person this entry has been shared with, oldest first
	shares: ActiveShare[];
	// Remembered between shares, so the name is typed once
	defaultSenderName: string;
	onShare: (options: ShareOptions) => void;
	onStop: (id: string) => void;
	onCancel: () => void;
	busy: boolean;
}

// What the row says beside the name: the state that matters, not the mechanism
const summaryOf = (share: ActiveShare): string => {
	if (!share.schedule) return 'Opens forever';
	if (Date.now() >= SecretShareService.expiresAt(share.schedule).getTime()) return 'Expired';
	return `Until ${SecretShareService.expiresAt(share.schedule).toLocaleDateString()}`;
};

export const ShareModal = ({ entryTitle, parts, shares, defaultSenderName, onShare, onStop, onCancel, busy }: ShareModalProps) => {
	const [creating, setCreating] = useState(shares.length === 0);
	const [openId, setOpenId] = useState<string | null>(shares.length > 0 ? shares[shares.length - 1].id : null);
	const [senderName, setSenderName] = useState(defaultSenderName);
	const [recipient, setRecipient] = useState('');
	const [message, setMessage] = useState('Change this once you are in.');
	const [include, setInclude] = useState<string[]>(() => SecretShareService.defaultSelection(parts));

	const toggle = (id: string) => setInclude(current =>
		current.includes(id) ? current.filter(part => part !== id) : [...current, id]);

	// Files are the only part that changes the size of what you send, so it is
	// the only one worth counting
	const attached = parts
		.filter(part => part.kind === 'file' && include.includes(part.id))
		.reduce((total, part) => total + (part.bytes ?? 0), 0);

	// A share that just landed becomes the open row, so the code to read out is
	// on screen without hunting for it
	const seen = useRef(shares.length);
	useEffect(() => {
		if (shares.length === seen.current) return;
		const added = shares.length > seen.current;
		seen.current = shares.length;
		if (added) {
			setCreating(false);
			setRecipient('');
			setOpenId(shares[shares.length - 1].id);
		} else if (shares.length === 0) {
			setCreating(true);
		}
	}, [shares]);

	const submit = () => {
		if (busy) return;
		onShare({ include, recipient: recipient.trim(), senderName: senderName.trim(), message: message.trim() });
	};


	const back = () => {
		if (busy) return;
		if (shares.length > 0) setCreating(false);
		else onCancel();
	};

	return (
		<Modal
			overlayClassName="pairing-overlay"
			className="pairing-dialog passkey-dialog share-dialog"
			labelledBy="share-title"
			onClose={busy ? undefined : onCancel}
		>
			<h3 id="share-title">
				{creating && shares.length > 0 ? `Share "${entryTitle}" with someone else` : `Share "${entryTitle}"`}
			</h3>

			{!creating && (
				<>
					<div className="share-list">
						{shares.map(share => {
							const open = openId === share.id;
							return (
								<div className="share-item" key={share.id}>
									<button
										type="button"
										className="share-item-head"
										aria-expanded={open}
										onClick={() => setOpenId(open ? null : share.id)}
									>
										<ChevronActionIcon className={open ? 'share-item-chevron share-item-chevron-open' : 'share-item-chevron'} />
										<span className="share-item-name">{share.recipient || 'Someone'}</span>
										<span className="share-item-meta">{summaryOf(share)}</span>
									</button>
									{open && (
										<div className="share-item-body">
											<SharePanel share={share} />
											<div className="share-item-actions">
												<button className="share-stop-button" onClick={() => onStop(share.id)}>
													Stop sharing
												</button>
											</div>
										</div>
									)}
								</div>
							);
						})}
					</div>

					<div className="pairing-actions share-actions-split">
						<button className="share-add-button" onClick={() => setCreating(true)}>
							Share with someone else
						</button>
						<button className="pairing-cancel-button" onClick={onCancel}>Close</button>
					</div>
				</>
			)}

			{creating && (
				<>
					<p className="share-dialog-lead">
						Vigil gives you a link to send, or a file when there is too much for a link. Either one
						shows nothing until you give them a code, and both stop working for good a day from now.
					</p>

					<div className="share-field">
						<label id="share-parts-label">What goes in it</label>
						<div className="share-parts" role="group" aria-labelledby="share-parts-label">
							{parts.map(part => (
								<label className="share-part" key={part.id}>
									<input
										type="checkbox"
										checked={include.includes(part.id)}
										onChange={() => toggle(part.id)}
									/>
									<span className="share-part-label">{part.label}</span>
									{part.detail && <span className="share-part-detail">{part.detail}</span>}
								</label>
							))}
						</div>
						{attached > 0 && (
							<p className="share-choice-note share-parts-size">
								Files make the share {SecretShareService.formatSize(attached)} bigger.
							</p>
						)}
					</div>

					<div className="share-field-row">
						<div className="share-field">
							<label htmlFor="share-sender">Your name</label>
							<input
								id="share-sender"
								type="text"
								className="pairing-name-input"
								placeholder="Shown to them"
								value={senderName}
								onChange={(e) => setSenderName(e.target.value)}
							/>
						</div>
						<div className="share-field">
							<label htmlFor="share-recipient">Who is it for</label>
							<input
								id="share-recipient"
								type="text"
								className="pairing-name-input"
								placeholder="Names this share"
								value={recipient}
								onChange={(e) => setRecipient(e.target.value)}
							/>
						</div>
					</div>

					<div className="share-field">
						<label htmlFor="share-message">Note for them</label>
						<input
							id="share-message"
							type="text"
							className="pairing-name-input"
							value={message}
							onChange={(e) => setMessage(e.target.value)}
						/>
					</div>

					<div className="pairing-actions">
						<button className="pairing-cancel-button" onClick={back} disabled={busy}>
							{shares.length > 0 ? 'Back' : 'Cancel'}
						</button>
						<button
							className="pairing-allow-button"
							onClick={submit}
							disabled={busy || include.length === 0}
						>
							{busy ? 'Sharing' : 'Share'}
						</button>
					</div>
				</>
			)}
		</Modal>
	);
};
