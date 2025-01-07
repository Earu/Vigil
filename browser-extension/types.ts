export interface Credentials {
  username?: string;
  email?: string;
  password?: string;
}

export interface FormFields {
  passwords: HTMLInputElement[];
  usernames: HTMLInputElement[];
}

export interface MessageRequest {
  type: 'GET_CREDENTIALS';
  domain?: string;
} 