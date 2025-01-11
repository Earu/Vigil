export interface Credentials {
  success: boolean;
  error?: string;
  username?: string;
  password?: string;
}

export interface FormFields {
  passwords: HTMLInputElement[];
  usernames: HTMLInputElement[];
}

export interface CredentialEntry {
  id: string;
  title: string;
  username: string;
  url?: string;
}

export interface MessageRequest {
  type: 'GET_CREDENTIALS' | 'GET_CONNECTION_STATE' | 'GET_AVAILABLE_ENTRIES' | 'GET_ALL_ENTRIES';
  domain?: string;
  entryIndex?: number;
  filteredEntries?: CredentialEntry[];
}