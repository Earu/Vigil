import React from 'react';

interface AuthIconProps {
	className?: string;
	color?: string;
	style?: React.CSSProperties;
}

export const LockAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		strokeWidth="2"
		className={className}
		style={style}
	>
		<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
		<path d="M7 11V7a5 5 0 0 1 10 0v4" />
	</svg>
);

export const UploadAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		strokeWidth="2"
		strokeLinecap="round"
		strokeLinejoin="round"
		className={className}
		style={style}
	>
		<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
		<polyline points="17 8 12 3 7 8" />
		<line x1="12" y1="3" x2="12" y2="15" />
	</svg>
);

export const BrowseAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		strokeWidth="2"
		className={className}
		style={style}
	>
		<path d="M20 11.08V8l-6-6H6a2 2 0 0 0-2 2v16c0 1.1.9 2 2 2h12a2 2 0 0 0 2-2v-3.08" />
		<path d="M14 3v5h5M18 21v-6M15 18h6" />
	</svg>
);

export const BiometricAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => {
	const isWindows = navigator.userAgent.includes('Windows');

	if (isWindows) {
		return (
			<svg version="1.0" xmlns="http://www.w3.org/2000/svg"
				viewBox="0 0 800.000000 680.000000"
				preserveAspectRatio="xMidYMid meet"
				className={className}
				style={style}
				stroke={color}>

				<g transform="translate(0.000000,680.000000) scale(0.100000,-0.100000)" fill={color} stroke="none">
					<path d="M1711 6789 c-416 -56 -758 -373 -842 -781 -17 -85 -20 -126 -16 -238
						5 -155 22 -236 75 -358 123 -284 367 -491 671 -568 121 -32 333 -35 449 -9
						303 69 547 263 683 540 71 145 93 246 93 425 0 86 -5 170 -13 205 -87 393
						-384 689 -773 770 -92 20 -238 26 -327 14z"/>
					<path d="M6018 6785 c-317 -52 -594 -250 -733 -525 -76 -151 -105 -275 -105
						-454 0 -181 25 -296 98 -441 122 -246 320 -414 594 -506 176 -59 418 -57 605
						6 503 168 779 680 647 1200 -49 192 -179 387 -343 517 -209 165 -509 245 -763
						203z"/>
					<path d="M400 2966 c-112 -31 -201 -88 -278 -178 -57 -67 -90 -135 -109 -222
						-40 -190 46 -383 336 -756 317 -408 670 -733 1122 -1032 654 -433 1270 -660
						2049 -755 182 -22 731 -25 915 -5 779 84 1433 321 2094 760 435 288 761 583
						1070 967 332 413 433 629 387 828 -66 281 -357 463 -630 392 -143 -37 -227
						-103 -369 -288 -303 -393 -660 -740 -1025 -995 -543 -380 -1110 -577 -1792
						-623 -530 -35 -1176 99 -1675 348 -531 266 -1036 698 -1473 1260 -153 197
						-234 260 -378 298 -69 18 -181 18 -244 1z"/>
				</g>
			</svg>
		);
	}

	// Generic biometrics logo (fingerprint)
	return (
		<svg
			viewBox="0 0 24 24"
			fill="none"
			xmlns="http://www.w3.org/2000/svg"
			className={className}
			style={style}
			stroke={color}>

			<path d="M13.1427 20.9999C10.8077 19.5438 9.25254 16.9522 9.25254 13.9968C9.25254 12.4783 10.4833 11.2476 12.0008 11.2476C13.5184 11.2476 14.7491 12.4783 14.7491 13.9968C14.7491 15.5153 15.9798 16.746 17.4974 16.746C19.0149 16.746 20.2457 15.5153 20.2457 13.9968C20.2457 9.44139 16.5544 5.74922 12.0017 5.74922C7.44907 5.74922 3.75781 9.44139 3.75781 13.9968C3.75781 15.0122 3.87145 16.001 4.08038 16.954M8.49027 20.2989C7.23938 18.5138 6.50351 16.3419 6.50351 13.9968C6.50351 10.9599 8.96405 8.49844 11.9992 8.49844C15.0343 8.49844 17.4948 10.9599 17.4948 13.9968M17.7927 19.4806C17.6937 19.4861 17.5966 19.4953 17.4967 19.4953C14.4616 19.4953 12.0011 17.0338 12.0011 13.9969M19.6734 6.47682C17.7993 4.34802 15.0593 3 12.0004 3C8.94141 3 6.20138 4.34802 4.32734 6.47682" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
		</svg>
	);
};

export const ShowPasswordIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		strokeWidth="2"
		className={className}
		style={style}
	>
		<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
		<circle cx="12" cy="12" r="3" />
	</svg>
);

export const HidePasswordIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		strokeWidth="2"
		className={className}
		style={style}
	>
		<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
		<line x1="1" y1="1" x2="23" y2="23" />
	</svg>
);

export const UnlockAuthIcon: React.FC<AuthIconProps> = ({ className, color = 'currentColor', style }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke={color}
		strokeWidth="2"
		className={className}
		style={style}
	>
		<rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
		<path d="M7 11V7a5 5 0 0 1 9.9-1" />
	</svg>
);