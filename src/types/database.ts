import * as kdbxweb from 'kdbxweb';

export interface Attachment {
	name: string;
	data: ArrayBuffer | kdbxweb.ProtectedValue;
}

export interface CustomField {
	key: string;
	value: string | kdbxweb.ProtectedValue;
	protected: boolean;
}

export interface EntryVersion {
	title: string;
	username: string;
	password: string | kdbxweb.ProtectedValue;
	url?: string;
	notes?: string;
	modified: Date;
	attachments: Attachment[];
	expires: boolean;
	expiryTime?: Date;
	customFields: CustomField[];
}

export interface Entry {
	id: string;
	// Group this entry sat in before it was moved, as kdbx records it. Set on
	// the way into the recycle bin, which is what makes restoring put an entry
	// back where it came from instead of dropping it at the root
	previousParentGroup?: string;
	title: string;
	username: string;
	password: string | kdbxweb.ProtectedValue;
	url?: string;
	notes?: string;
	created: Date;
	modified: Date;
	attachments: Attachment[];
	history: EntryVersion[];
	expires: boolean;
	expiryTime?: Date;
	customFields: CustomField[];
}

export interface Group {
	id: string;
	name: string;
	icon?: string;
	groups: Group[];
	entries: Entry[];
	isRecycleBin?: boolean;
}

export interface Database {
	name: string;
	groups: Group[];
	root: Group;
}