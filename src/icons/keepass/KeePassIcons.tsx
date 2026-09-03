import React from 'react';

// The 69 KeePass standard client icons (kdbxweb.Consts.Icons), drawn as
// monochrome line glyphs in the app's icon style rather than the classic
// full-color set. Index order is the kdbx IconID order and must not change.

const GLYPHS: React.ReactNode[] = [
	// 0 Key
	<><circle cx="7.5" cy="15.5" r="4" /><path d="M10.5 12.5 L20 3 M15 8l3 3M17.5 5.5l3 3" /></>,
	// 1 World
	<><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></>,
	// 2 Warning
	<><path d="M12 3 22 20H2Z" /><line x1="12" y1="9" x2="12" y2="14" /><line x1="12" y1="17" x2="12" y2="17" /></>,
	// 3 NetworkServer
	<><rect x="3" y="4" width="18" height="7" rx="1" /><rect x="3" y="13" width="18" height="7" rx="1" /><line x1="6.5" y1="7.5" x2="6.5" y2="7.5" /><line x1="6.5" y1="16.5" x2="6.5" y2="16.5" /></>,
	// 4 MarkedDirectory
	<><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><line x1="16" y1="11" x2="16" y2="16" /><path d="M16 11h3v2.5h-3" /></>,
	// 5 UserCommunication
	<><circle cx="9" cy="8" r="3.5" /><path d="M3.5 20c0-3 2.5-5 5.5-5s5.5 2 5.5 5" /><path d="M16 4h5v4h-2l-1.5 1.5V8H16Z" /></>,
	// 6 Parts
	<><circle cx="7" cy="7" r="3" /><circle cx="17" cy="7" r="3" /><circle cx="12" cy="16" r="3" /></>,
	// 7 Notepad
	<><rect x="5" y="4" width="14" height="16" rx="1" /><line x1="8" y1="9" x2="16" y2="9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></>,
	// 8 WorldSocket
	<><circle cx="10" cy="12" r="7" /><path d="M3 12h14M10 5a11 11 0 0 1 0 14" /><path d="M17 9v6M21 10v4" /></>,
	// 9 Identity
	<><rect x="3" y="5" width="18" height="14" rx="1" /><circle cx="8.5" cy="11" r="2" /><path d="M5.5 16c0-1.5 1.4-2.5 3-2.5s3 1 3 2.5" /><line x1="14" y1="10" x2="18.5" y2="10" /><line x1="14" y1="14" x2="18.5" y2="14" /></>,
	// 10 PaperReady
	<><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /><path d="M9 14l2 2 4-4" /></>,
	// 11 Digicam
	<><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="12" cy="13.5" r="4" /><path d="M8 7l1.5-3h5L16 7" /></>,
	// 12 IRCommunication
	<><path d="M5 12a7 7 0 0 1 14 0" /><path d="M8 12a4 4 0 0 1 8 0" /><line x1="12" y1="12" x2="12" y2="19" /></>,
	// 13 MultiKeys
	<><circle cx="6.5" cy="16.5" r="3" /><path d="M9 14 17 6M13.5 9.5l2.5 2.5M15.5 7.5l2.5 2.5" /><circle cx="17.5" cy="17.5" r="2.5" /></>,
	// 14 Energy
	<><path d="M13 2 5 14h5l-1 8 8-12h-5Z" /></>,
	// 15 Scanner
	<><rect x="3" y="10" width="18" height="8" rx="1" /><line x1="6" y1="14" x2="14" y2="14" /><path d="M6 10l10-5" /></>,
	// 16 WorldStar
	<><circle cx="10" cy="13" r="7" /><path d="M3 13h14M10 6a11 11 0 0 1 0 14" /><path d="m18.5 3 .9 1.8 2 .3-1.5 1.4.4 2-1.8-1-1.8 1 .4-2L15.6 5.1l2-.3Z" /></>,
	// 17 CDRom
	<><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="2.5" /></>,
	// 18 Monitor
	<><rect x="3" y="4" width="18" height="12" rx="1" /><line x1="9" y1="20" x2="15" y2="20" /><line x1="12" y1="16" x2="12" y2="20" /></>,
	// 19 EMail
	<><rect x="3" y="5" width="18" height="14" rx="1" /><path d="m3 7 9 6 9-6" /></>,
	// 20 Configuration
	<><line x1="5" y1="4" x2="5" y2="20" /><line x1="12" y1="4" x2="12" y2="20" /><line x1="19" y1="4" x2="19" y2="20" /><circle cx="5" cy="9" r="2" /><circle cx="12" cy="15" r="2" /><circle cx="19" cy="7" r="2" /></>,
	// 21 ClipboardReady
	<><rect x="5" y="5" width="14" height="16" rx="1" /><path d="M9 5a3 3 0 0 1 6 0" /><path d="M9 14l2 2 4-4" /></>,
	// 22 PaperNew
	<><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /><line x1="12" y1="11" x2="12" y2="17" /><line x1="9" y1="14" x2="15" y2="14" /></>,
	// 23 Screen
	<><rect x="3" y="5" width="18" height="14" rx="1" /><path d="M7 12l3-3M7 16l7-7" /></>,
	// 24 EnergyCareful
	<><path d="M11 2 4 13h4l-1 8 7-11h-4Z" /><line x1="18" y1="8" x2="18" y2="13" /><line x1="18" y1="16" x2="18" y2="16" /></>,
	// 25 EMailBox
	<><path d="M3 13h5l1.5 2h5L16 13h5" /><path d="M3 13v6h18v-6" /><path d="M5 13V6h14v7" /></>,
	// 26 Disk
	<><path d="M4 4h13l3 3v13H4Z" /><rect x="8" y="4" width="7" height="5" /><rect x="7" y="13" width="10" height="7" /></>,
	// 27 Drive
	<><rect x="3" y="8" width="18" height="8" rx="1" /><line x1="17.5" y1="12" x2="17.5" y2="12" /><line x1="6" y1="12" x2="10" y2="12" /></>,
	// 28 PaperQ
	<><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /><path d="M10 11a2 2 0 1 1 3 1.7c-.7.4-1 .8-1 1.6" /><line x1="12" y1="17" x2="12" y2="17" /></>,
	// 29 TerminalEncrypted
	<><rect x="3" y="4" width="18" height="14" rx="1" /><path d="m6 8 3 3-3 3" /><rect x="14" y="11" width="5" height="4" rx="0.5" /><path d="M15 11v-1.5a1.5 1.5 0 0 1 3 0V11" /></>,
	// 30 Console
	<><rect x="3" y="4" width="18" height="16" rx="1" /><path d="m6 9 3 3-3 3" /><line x1="11" y1="16" x2="16" y2="16" /></>,
	// 31 Printer
	<><path d="M7 8V3h10v5" /><rect x="3" y="8" width="18" height="8" rx="1" /><rect x="7" y="13" width="10" height="8" /></>,
	// 32 ProgramIcons
	<><rect x="4" y="4" width="7" height="7" /><rect x="13" y="4" width="7" height="7" /><rect x="4" y="13" width="7" height="7" /><rect x="13" y="13" width="7" height="7" /></>,
	// 33 Run
	<><path d="M7 4l13 8-13 8Z" /></>,
	// 34 Settings
	<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></>,
	// 35 WorldComputer
	<><circle cx="9" cy="9" r="6" /><path d="M3 9h12M9 3a9 9 0 0 1 0 12" /><rect x="13" y="13" width="8" height="6" rx="1" /><line x1="15.5" y1="21" x2="18.5" y2="21" /></>,
	// 36 Archive
	<><rect x="4" y="4" width="16" height="5" rx="0.5" /><path d="M5 9v11h14V9" /><line x1="10" y1="13" x2="14" y2="13" /></>,
	// 37 Homebanking
	<><path d="M3 9l9-6 9 6" /><line x1="4" y1="9" x2="20" y2="9" /><line x1="6" y1="12" x2="6" y2="17" /><line x1="12" y1="12" x2="12" y2="17" /><line x1="18" y1="12" x2="18" y2="17" /><line x1="3" y1="20" x2="21" y2="20" /></>,
	// 38 DriveWindows
	<><rect x="3" y="8" width="18" height="8" rx="1" /><line x1="6" y1="12" x2="9" y2="12" /><path d="M14 10.5h5M14 13.5h5M16.5 10.5v3" /></>,
	// 39 Clock
	<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" /></>,
	// 40 EMailSearch
	<><path d="M3 5h16v7" /><path d="m3 7 8 5 8-5" /><path d="M3 5v12h8" /><circle cx="16.5" cy="16.5" r="3.5" /><line x1="19" y1="19" x2="21.5" y2="21.5" /></>,
	// 41 PaperFlag
	<><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /><path d="M10 17v-6h4.5l-1.5 1.5 1.5 1.5H10" /></>,
	// 42 Memory
	<><rect x="5" y="7" width="14" height="10" rx="1" /><path d="M8 7V4M12 7V4M16 7V4M8 20v-3M12 20v-3M16 20v-3" /></>,
	// 43 TrashBin
	<><path d="M4 7h16" /><path d="M9 7V4h6v3" /><path d="M6 7l1 13h10l1-13" /><line x1="10" y1="11" x2="10" y2="16" /><line x1="14" y1="11" x2="14" y2="16" /></>,
	// 44 Note
	<><path d="M4 4h16v10l-6 6H4Z" /><path d="M14 20v-6h6" /></>,
	// 45 Expired
	<><circle cx="12" cy="12" r="9" /><path d="m9 9 6 6M15 9l-6 6" /></>,
	// 46 Info
	<><circle cx="12" cy="12" r="9" /><line x1="12" y1="11" x2="12" y2="16" /><line x1="12" y1="8" x2="12" y2="8" /></>,
	// 47 Package
	<><path d="M12 3 21 7.5v9L12 21 3 16.5v-9Z" /><path d="M3 7.5 12 12l9-4.5M12 12v9" /></>,
	// 48 Folder
	<><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /></>,
	// 49 FolderOpen
	<><path d="M3 6a1 1 0 0 1 1-1h5l2 2h8v2" /><path d="M3 18l3-8h16l-3 8Z" /></>,
	// 50 FolderPackage
	<><path d="M3 6a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z" /><rect x="9.5" y="11" width="5" height="5" /></>,
	// 51 LockOpen
	<><rect x="5" y="11" width="14" height="9" rx="1" /><path d="M8 11V7a4 4 0 0 1 7.8-1.3" /><line x1="12" y1="14.5" x2="12" y2="16.5" /></>,
	// 52 PaperLocked
	<><path d="M6 3h8l4 4v14H6Z" /><path d="M14 3v4h4" /><rect x="9" y="13" width="6" height="4.5" rx="0.5" /><path d="M10 13v-1.5a2 2 0 0 1 4 0V13" /></>,
	// 53 Checked
	<><circle cx="12" cy="12" r="9" /><path d="m8 12 3 3 5-6" /></>,
	// 54 Pen
	<><path d="m14 4 6 6L9 21H3v-6Z" /><line x1="12" y1="6" x2="18" y2="12" /></>,
	// 55 Thumbnail
	<><rect x="3" y="4" width="18" height="16" rx="1" /><circle cx="8.5" cy="9.5" r="1.5" /><path d="m3 17 5-5 4 4 4-4 5 5" /></>,
	// 56 Book
	<><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5Z" /><path d="M20 17v4H6.5a2.5 2.5 0 0 1 0-4" /></>,
	// 57 List
	<><line x1="9" y1="6" x2="20" y2="6" /><line x1="9" y1="12" x2="20" y2="12" /><line x1="9" y1="18" x2="20" y2="18" /><line x1="4.5" y1="6" x2="4.5" y2="6" /><line x1="4.5" y1="12" x2="4.5" y2="12" /><line x1="4.5" y1="18" x2="4.5" y2="18" /></>,
	// 58 UserKey
	<><circle cx="9" cy="8" r="3.5" /><path d="M3.5 20c0-3 2.5-5 5.5-5 1 0 2 .2 2.8.6" /><circle cx="16" cy="17" r="2.5" /><path d="M18 15l4-4M20 13l1.5 1.5" /></>,
	// 59 Tool
	<><path d="M14.5 6.5a4.5 4.5 0 0 1 6-4.3L17 5.7l1.3 1.3 3.5-3.5a4.5 4.5 0 0 1-5.8 6L7 18.5a2 2 0 0 1-2.8-2.8Z" /></>,
	// 60 Home
	<><path d="M3 11 12 3l9 8" /><path d="M5 10v10h14V10" /><path d="M10 20v-6h4v6" /></>,
	// 61 Star
	<><path d="m12 3 2.7 5.6 6.3.9-4.5 4.3 1 6.2-5.5-3-5.5 3 1-6.2L3 9.5l6.3-.9Z" /></>,
	// 62 Tux
	<><path d="M12 3c-2.5 0-4 2-4 4.5 0 2-2.5 5.5-2.5 8.5 0 3 3 5 6.5 5s6.5-2 6.5-5c0-3-2.5-6.5-2.5-8.5C16 5 14.5 3 12 3Z" /><path d="M9.5 8h.01M14.5 8h.01" /><path d="M10.5 10.5c.5.7 2.5.7 3 0" /></>,
	// 63 Feather
	<><path d="M20 4c-6 0-12 4-14 10l-3 7" /><path d="M20 4c1 5-2 12-9 13H7" /><path d="M9 12h6" /></>,
	// 64 Apple
	<><path d="M12 8c-1-2-3-2.5-4.5-1.5C5 8 4.5 12 6.5 16c1.3 2.6 3 4 4.5 3.4.4-.2 1.6-.2 2 0 1.5.6 3.2-.8 4.5-3.4 2-4 1.5-8-1-9.5C15 5.5 13 6 12 8Z" /><path d="M12 7c0-2 1-3.5 3-4" /></>,
	// 65 Wiki
	<><rect x="3" y="3" width="18" height="18" rx="1" /><path d="m6.5 8 2 8 2.5-6.5L13.5 16l2-8" /></>,
	// 66 Money
	<><circle cx="12" cy="12" r="9" /><path d="M15 8.5c-.6-.9-1.7-1.5-3-1.5-1.8 0-3 1-3 2.5s1.3 2.1 3 2.5 3 1 3 2.5-1.2 2.5-3 2.5c-1.3 0-2.4-.6-3-1.5" /><line x1="12" y1="5" x2="12" y2="19" /></>,
	// 67 Certificate
	<><circle cx="12" cy="9" r="5" /><path d="m9.5 13 -1.5 8 4-2.5 4 2.5-1.5-8" /></>,
	// 68 BlackBerry
	<><rect x="7" y="3" width="10" height="18" rx="2" /><line x1="10" y1="18" x2="14" y2="18" /><line x1="9" y1="6" x2="15" y2="6" /></>,
];

// Human-readable names for pickers and tooltips, same index order
export const KEEPASS_ICON_NAMES: string[] = [
	'Key', 'Globe', 'Warning', 'Server', 'Flagged folder', 'Chat', 'Parts',
	'Notepad', 'Network globe', 'Identity card', 'Checked document', 'Camera',
	'Wireless', 'Key ring', 'Lightning', 'Scanner', 'Starred globe', 'Disc',
	'Monitor', 'Email', 'Configuration', 'Clipboard', 'New document', 'Screen',
	'Power warning', 'Inbox', 'Floppy disk', 'Drive', 'Help document',
	'Encrypted terminal', 'Console', 'Printer', 'App grid', 'Run', 'Settings',
	'Networked computer', 'Archive', 'Bank', 'Windows drive', 'Clock',
	'Email search', 'Flagged document', 'Memory', 'Recycle bin', 'Note',
	'Expired', 'Info', 'Package', 'Folder', 'Open folder', 'Packed folder',
	'Open lock', 'Locked document', 'Checked', 'Pen', 'Picture', 'Book',
	'List', 'User key', 'Wrench', 'Home', 'Star', 'Penguin', 'Feather',
	'Apple', 'Wiki', 'Money', 'Certificate', 'Phone',
];

interface KeePassIconProps {
	index?: number;
	className?: string;
}

export const KEEPASS_ICON_COUNT = GLYPHS.length;

export const KeePassIcon: React.FC<KeePassIconProps> = ({ index, className }) => (
	<svg
		xmlns="http://www.w3.org/2000/svg"
		viewBox="0 0 24 24"
		fill="none"
		stroke="currentColor"
		strokeWidth="1.8"
		strokeLinecap="round"
		strokeLinejoin="round"
		className={className}
	>
		{GLYPHS[index ?? 0] ?? GLYPHS[0]}
	</svg>
);
