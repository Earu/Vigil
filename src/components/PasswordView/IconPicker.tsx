import React, { useRef, useState } from 'react';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { KeePassIcon, KEEPASS_ICON_COUNT, KEEPASS_ICON_NAMES } from '../../icons/keepass/KeePassIcons';

// Icon selection shared by entries and groups: the vault's stored custom
// icons, an image file of the user's own, and the standard KeePass set.
// Picking the default slot clears both the standard and the custom icon,
// which is the "remove icon" path.

interface IconPickerProps {
	// Index the item falls back to with nothing set: Key for entries,
	// Folder for groups. Selecting it reports icon undefined
	defaultIndex: number;
	icon?: number;
	customIcon?: string;
	onChange: (icon: number | undefined, customIcon: string | undefined) => void;
}

// A reasonable icon needs no more than this; larger images are downscaled
const MAX_RAW_ICON_BYTES = 64 * 1024;
const SCALED_ICON_PX = 64;

async function iconBytesFromFile(file: File): Promise<Uint8Array | null> {
	if (file.size <= MAX_RAW_ICON_BYTES) {
		return new Uint8Array(await file.arrayBuffer());
	}
	try {
		const bitmap = await createImageBitmap(file);
		const scale = Math.min(1, SCALED_ICON_PX / Math.max(bitmap.width, bitmap.height));
		const width = Math.max(1, Math.round(bitmap.width * scale));
		const height = Math.max(1, Math.round(bitmap.height * scale));
		const canvas = document.createElement('canvas');
		canvas.width = width;
		canvas.height = height;
		canvas.getContext('2d')!.drawImage(bitmap, 0, 0, width, height);
		const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
		if (!blob) return null;
		return new Uint8Array(await blob.arrayBuffer());
	} catch {
		return null;
	}
}

interface IconGridProps {
	label: string;
	className?: string;
	count: number;
	selectedIndex: number;
	nameOf: (index: number) => string;
	onPick: (index: number) => void;
	renderIcon: (index: number) => React.ReactNode;
}

// The buttons behind each icon, in DOM order
const buttonsOf = (grid: HTMLElement) => Array.from(grid.querySelectorAll<HTMLButtonElement>('.group-icon-option'));

// Columns come from layout: the first button on the second row ends the
// first. With no layout (tests) the grid is one row
const columnsOf = (buttons: HTMLElement[]) => {
	const wrap = buttons.findIndex((b, i) => i > 0 && b.offsetTop > buttons[0].offsetTop);
	return wrap < 0 ? buttons.length : wrap;
};

// One Tab stop per grid, arrows move between icons, Enter/Space pick
const IconGrid = ({ label, className = '', count, selectedIndex, nameOf, onPick, renderIcon }: IconGridProps) => {
	const [focusedIndex, setFocusedIndex] = useState(Math.max(0, selectedIndex));
	const tabbable = focusedIndex < count ? focusedIndex : 0;

	const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		const buttons = buttonsOf(e.currentTarget);
		const current = buttons.indexOf(e.target as HTMLButtonElement);
		if (current < 0) return;
		const columns = columnsOf(buttons);
		let next: number;
		switch (e.key) {
			case 'ArrowRight': next = current + 1; break;
			case 'ArrowLeft': next = current - 1; break;
			case 'ArrowDown': next = current + columns; break;
			case 'ArrowUp': next = current - columns; break;
			case 'Home': next = 0; break;
			case 'End': next = buttons.length - 1; break;
			default: return;
		}
		e.preventDefault();
		if (next < 0 || next >= buttons.length) return;
		buttons[next].focus();
	};

	return (
		<div className={`group-icon-grid ${className}`} role="group" aria-label={label} onKeyDown={handleKeyDown}>
			{Array.from({ length: count }, (_, index) => (
				<button
					key={index}
					type="button"
					className={`group-icon-option ${selectedIndex === index ? 'selected' : ''}`}
					tabIndex={tabbable === index ? 0 : -1}
					aria-pressed={selectedIndex === index}
					onFocus={() => setFocusedIndex(index)}
					onClick={() => onPick(index)}
					title={nameOf(index)} aria-label={nameOf(index)}
				>
					{renderIcon(index)}
				</button>
			))}
		</div>
	);
};

export const IconPicker = ({ defaultIndex, icon, customIcon, onChange }: IconPickerProps) => {
	const fileInputRef = useRef<HTMLInputElement>(null);
	const customIcons = KeepassDatabaseService.listCustomIcons();
	const selectedIndex = icon ?? defaultIndex;

	const handleFile = async (file: File | undefined) => {
		if (!file) return;
		const bytes = await iconBytesFromFile(file);
		if (!bytes || bytes.length === 0) {
			(window as any).showToast?.({ message: 'Could not read that image', type: 'error' });
			return;
		}
		onChange(undefined, KeepassDatabaseService.stageCustomIcon(bytes));
	};

	return (
		<div className="icon-picker">
			{customIcons.length > 0 && (
				<IconGrid
					label="Custom icons"
					className="custom-icon-grid"
					count={customIcons.length}
					selectedIndex={customIcons.findIndex(({ id }) => id === customIcon)}
					nameOf={() => 'Custom icon stored in the database'}
					onPick={(i) => onChange(undefined, customIcons[i].id)}
					renderIcon={(i) => <img src={customIcons[i].url} alt="" />}
				/>
			)}
			<IconGrid
				label="Standard icons"
				count={KEEPASS_ICON_COUNT}
				selectedIndex={customIcon ? -1 : selectedIndex}
				nameOf={(index) => index === defaultIndex ? `${KEEPASS_ICON_NAMES[index]} (default)` : KEEPASS_ICON_NAMES[index]}
				onPick={(index) => onChange(index === defaultIndex ? undefined : index, undefined)}
				renderIcon={(index) => <KeePassIcon index={index} />}
			/>
			<div className="icon-picker-actions">
				<button className="icon-picker-file-button" onClick={() => fileInputRef.current?.click()} type="button">
					Use image file...
				</button>
				{(customIcon !== undefined || (icon !== undefined && icon !== defaultIndex)) && (
					<button
						className="icon-picker-file-button"
						onClick={() => onChange(undefined, undefined)}
						title={`Back to the default ${KEEPASS_ICON_NAMES[defaultIndex].toLowerCase()} icon`}
						type="button"
					>
						Remove icon
					</button>
				)}
			</div>
			<input
				ref={fileInputRef}
				type="file"
				accept="image/*"
				hidden
				onChange={(e) => {
					handleFile(e.target.files?.[0]);
					e.target.value = '';
				}}
			/>
		</div>
	);
};
