import { useRef } from 'react';
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
				<div className="group-icon-grid custom-icon-grid">
					{customIcons.map(({ id, url }) => (
						<button
							key={id}
							className={`group-icon-option ${customIcon === id ? 'selected' : ''}`}
							onClick={() => onChange(undefined, id)}
							title="Custom icon stored in the database" aria-label="Custom icon stored in the database"
						>
							<img src={url} alt="" />
						</button>
					))}
				</div>
			)}
			<div className="group-icon-grid">
				{Array.from({ length: KEEPASS_ICON_COUNT }, (_, index) => (
					<button
						key={index}
						className={`group-icon-option ${!customIcon && selectedIndex === index ? 'selected' : ''}`}
						onClick={() => onChange(index === defaultIndex ? undefined : index, undefined)}
						title={index === defaultIndex ? `${KEEPASS_ICON_NAMES[index]} (default)` : KEEPASS_ICON_NAMES[index]} aria-label={index === defaultIndex ? `${KEEPASS_ICON_NAMES[index]} (default)` : KEEPASS_ICON_NAMES[index]}
					>
						<KeePassIcon index={index} />
					</button>
				))}
			</div>
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
