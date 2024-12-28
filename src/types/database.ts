import * as kdbxweb from 'kdbxweb';

export interface Entry {
	id: string;
	title: string;
	username: string;
	password: string | kdbxweb.ProtectedValue;
	url?: string;
	notes?: string;
	created: Date;
	modified: Date;
	breachStatus?: {
		isPwned: boolean;
		count: number;
	};
}

export interface Group {
	id: string;
	name: string;
	icon?: string;
	groups: Group[];
	entries: Entry[];
	expanded?: boolean;
	hasBreachedEntries?: boolean;
}

export interface Database {
	name: string;
	groups: Group[];
	root: Group;
}