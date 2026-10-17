export interface AccountUser {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface AccountSession {
  user: AccountUser;
  subscription: { plan: 'free' | 'pro'; status: string };
  usage: { products: number; ai: number };
  limits: { products: number; ai: number };
  billingEnabled: boolean;
}

export interface AccountJob {
  id: string;
  kind: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
}
