export interface Credentials {
  success?: boolean;
  error?: string;
  password?: string;
  entries?: Array<{
    id: string;
    url: string;
    username: string;
  }>;
}

export interface FormFields {
  passwords: HTMLInputElement[];
  usernames: HTMLInputElement[];
}

export interface MessageRequest {
  type: 'GET_CREDENTIALS' | 'GET_AVAILABLE_ENTRIES';
  domain?: string;
  id?: string;
}