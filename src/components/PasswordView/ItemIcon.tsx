import { ReactNode } from 'react';
import { KeepassDatabaseService } from '../../services/KeepassDatabaseService';
import { KeePassIcon } from '../../icons/keepass/KeePassIcons';

// The one place the icon precedence lives: a stored custom icon beats a
// chosen standard icon, and anything below that (a network favicon, a
// default glyph, nothing at all) is the caller's fallback.

interface ItemIconProps {
	icon?: number;
	customIcon?: string;
	className?: string;
	fallback?: ReactNode;
}

export const ItemIcon = ({ icon, customIcon, className, fallback = null }: ItemIconProps) => {
	const customUrl = KeepassDatabaseService.getCustomIconUrl(customIcon);
	if (customUrl) return <img src={customUrl} alt="" className={className} />;
	if (icon !== undefined) return <KeePassIcon index={icon} className={className} />;
	return <>{fallback}</>;
};
