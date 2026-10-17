import {
  accountRequestRaw,
  clearAccountSession,
  refreshAccountSession,
  webRequest,
} from './session';
import type { AccountJob, AccountSession } from './saas-types';

export async function signIn(input: { email: string; password: string }) {
  clearAccountSession(true);
  await accountRequestRaw('/api/auth/login', { method: 'POST', body: JSON.stringify(input) });
  return refreshAccountSession(true);
}

export async function registerAccount(input: { email: string; password: string; name: string }) {
  clearAccountSession(true);
  await accountRequestRaw('/api/auth/register', { method: 'POST', body: JSON.stringify(input) });
  return refreshAccountSession(true);
}

export async function signOut(): Promise<void> {
  await accountRequestRaw('/api/auth/logout', { method: 'POST', body: '{}' });
  clearAccountSession(true);
}

export async function updateAccountName(name: string): Promise<AccountSession> {
  await webRequest('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) });
  return refreshAccountSession(true);
}

export async function changePassword(currentPassword: string, password: string): Promise<void> {
  await webRequest('/api/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, password }),
  });
  clearAccountSession(true);
}

export function getJobs(): Promise<{ jobs: AccountJob[] }> {
  return webRequest('/api/jobs');
}

export async function openBilling(kind: 'checkout' | 'portal'): Promise<string> {
  const { url } = await webRequest<{ url: string }>(`/api/billing/${kind}`, {
    method: 'POST',
    body: '{}',
  });
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') throw new Error('账单链接无效，请稍后重试。');
  return parsed.href;
}

export async function refreshBilling(): Promise<AccountSession> {
  await webRequest('/api/billing/reconcile', { method: 'POST', body: '{}' });
  return refreshAccountSession(true);
}
