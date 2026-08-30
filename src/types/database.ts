import * as kdbxweb from 'kdbxweb';

export interface Attachment {
	name: string;
	data: ArrayBuffer | kdbxweb.ProtectedValue;
}

export interface Entry {
	id: string;
	title: string;
	username: string;
	password: string | kdbxweb.ProtectedValue;
	url?: string;
	notes?: string;
	created: Date;
	modified: Date;
	attachments: Attachment[];
}

export interface Group {
	id: string;
	name: string;
	icon?: string;
	groups: Group[];
	entries: Entry[];
}

export interface Database {
	name: string;
	groups: Group[];
	root: Group;
}