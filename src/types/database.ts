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
	// Which of Title/UserName/URL/Notes the file holds as a ProtectedValue.
	// KeePass's database-wide memory protection settings can mark any of them,
	// and the flag has to survive a round trip: the four fields above are
	// plain strings so the whole UI can read them, so this is where the
	// protection they came in with is remembered. Password is not listed
	// because it is always written back protected
	protectedFields?: string[];
	modified: Date;
	attachments: Attachment[];
	expires: boolean;
	expiryTime?: Date;
	customFields: CustomField[];
	tags: string[];
}

export interface Entry {
	id: string;
	// KeePass standard icon index (kdbxweb.Consts.Icons); undefined reads as
	// the default key icon
	icon?: number;
	// UUID (base64, as kdbxweb keys meta.customIcons) of a custom icon stored
	// in the database; wins over the standard icon when set
	customIcon?: string;
	// The user removed a favicon-derived icon: show no website favicon for
	// this entry and keep promotion away. Persisted in entry customData
	suppressFavicon?: boolean;
	// Group this entry sat in before it was moved, as kdbx records it. Set on
	// the way into the recycle bin, which is what makes restoring put an entry
	// back where it came from instead of dropping it at the root
	previousParentGroup?: string;
	title: string;
	username: string;
	password: string | kdbxweb.ProtectedValue;
	url?: string;
	notes?: string;
	// See EntryVersion.protectedFields
	protectedFields?: string[];
	created: Date;
	modified: Date;
	attachments: Attachment[];
	history: EntryVersion[];
	expires: boolean;
	expiryTime?: Date;
	customFields: CustomField[];
	// kdbx stores these as one delimited string, so a tag can hold no ';', ','
	// or ':'. Everything writing here goes through normalizeTags
	tags: string[];
}

export interface Group {
	id: string;
	name: string;
	// Same pair as Entry: standard icon index and custom icon UUID
	icon?: number;
	customIcon?: string;
	groups: Group[];
	entries: Entry[];
	isRecycleBin?: boolean;
}

export interface Database {
	name: string;
	groups: Group[];
	root: Group;
	// Which convertKdbxToDatabase call built this model (copies made from it
	// inherit the value). The save path compares it against when an object
	// first became visible to models, to tell a deliberate deletion from a
	// model that simply predates the object
	generation?: number;
}