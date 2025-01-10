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

export interface MessageRequest {
  type: 'GET_CREDENTIALS' | 'GET_AVAILABLE_ENTRIES';
  domain?: string;
}