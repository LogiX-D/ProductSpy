const KEY = 'productspy.bridge-token.v1';

export async function bridgeToken(): Promise<string | undefined> {
  const stored: Record<string, unknown> = await chrome.storage.local.get(KEY);
  const value = stored[KEY];
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

export async function rememberBridgeToken(token: string): Promise<void> {
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('工作台返回了无效连接凭据，请重试配对。');
  await chrome.storage.local.set({ [KEY]: token });
}

export async function forgetBridgeToken(): Promise<void> {
  await chrome.storage.local.remove(KEY);
}
