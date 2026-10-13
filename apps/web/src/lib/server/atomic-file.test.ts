import { describe, expect, it, vi } from 'vitest';
import { publishAtomicFile } from './atomic-file';

describe('bounded atomic publication on Windows', () => {
  it('recovers a transient sharing violation without repeating the logical operation', async () => {
    const error = Object.assign(new Error('Locked'), { code: 'EPERM' });
    const rename = vi.fn().mockRejectedValueOnce(error).mockResolvedValue(undefined);
    const delay = vi.fn().mockResolvedValue(undefined);
    await publishAtomicFile('complete.tmp', 'products.json', { rename, delay, windows: true });
    expect(rename.mock.calls).toEqual([
      ['complete.tmp', 'products.json'],
      ['complete.tmp', 'products.json'],
    ]);
    expect(delay.mock.calls).toEqual([[20]]);
  });
  it('bounds permanent locks and preserves the original error instead of deleting the destination', async () => {
    const error = Object.assign(new Error('Permanent lock'), { code: 'EACCES' });
    const rename = vi.fn().mockRejectedValue(error);
    const delay = vi.fn().mockResolvedValue(undefined);
    await expect(
      publishAtomicFile('complete.tmp', 'products.json', { rename, delay, windows: true }),
    ).rejects.toBe(error);
    expect(rename).toHaveBeenCalledTimes(5);
    expect(delay.mock.calls).toEqual([[20], [50], [100], [200]]);
  });
  it.each(['ENOSPC', 'ENOENT', 'EINVAL'])('never retries permanent %s failures', async (code) => {
    const rename = vi.fn().mockRejectedValue(Object.assign(new Error(code), { code }));
    const delay = vi.fn();
    await expect(
      publishAtomicFile('complete.tmp', 'products.json', { rename, delay, windows: true }),
    ).rejects.toThrow(code);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
  it('does not add Windows retry behavior on other systems', async () => {
    const rename = vi.fn().mockRejectedValue(Object.assign(new Error('Locked'), { code: 'EPERM' }));
    const delay = vi.fn();
    await expect(
      publishAtomicFile('complete.tmp', 'products.json', { rename, delay, windows: false }),
    ).rejects.toThrow('Locked');
    expect(rename).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });
});
