import {
  draftSchema,
  mergeProduct,
  productKey,
  productSchema,
  type Product,
  type ProductDraft,
} from '@productspy/shared';

export interface QueuedCapture {
  captureId: string;
  draft: ProductDraft;
  attempts: number;
  nextAttemptAt: number;
  error?: string;
  blocked?: boolean;
}
interface QueueState {
  products: Record<string, Product>;
  pending: Record<string, QueuedCapture>;
  notBefore: number;
}
const locks = new Map<string, Promise<unknown>>();
const keyFor = (userId?: string) =>
  `productspy.cloud-queue.v1.${userId ? `user.${encodeURIComponent(userId)}` : '_unassigned'}`;

export class CloudCaptureQueue {
  private readonly key: string;
  constructor(userId?: string) {
    this.key = keyFor(userId);
  }

  private async read(): Promise<QueueState> {
    const saved = (await chrome.storage.local.get(this.key))[this.key] as
      Partial<QueueState> | undefined;
    const state: QueueState = {
      products: {},
      pending: {},
      notBefore: Number.isFinite(saved?.notBefore) ? saved!.notBefore! : 0,
    };
    for (const value of Object.values(saved?.products ?? {})) {
      const product = productSchema.safeParse(value);
      if (product.success) state.products[product.data.id] = product.data;
    }
    for (const value of Object.values(saved?.pending ?? {})) {
      const draft = draftSchema.safeParse(value?.draft);
      if (
        !draft.success ||
        typeof value.captureId !== 'string' ||
        !/^[\w-]{8,100}$/.test(value.captureId)
      )
        continue;
      state.pending[productKey(draft.data)] = {
        ...value,
        draft: draft.data,
        attempts: Number.isSafeInteger(value.attempts) && value.attempts >= 0 ? value.attempts : 0,
        nextAttemptAt: Number.isFinite(value.nextAttemptAt) ? value.nextAttemptAt : 0,
      };
    }
    return state;
  }

  private transaction<T>(operation: (state: QueueState) => T): Promise<T> {
    const result = (locks.get(this.key) ?? Promise.resolve()).then(async () => {
      const state = await this.read();
      const value = operation(state);
      await chrome.storage.local.set({ [this.key]: state });
      return value;
    });
    locks.set(
      this.key,
      result.catch(() => undefined),
    );
    return result;
  }

  async pending(): Promise<QueuedCapture[]> {
    await locks.get(this.key);
    const state = await this.read();
    return Object.values(state.pending).map((capture) => ({
      ...capture,
      nextAttemptAt: Math.max(capture.nextAttemptAt, state.notBefore),
    }));
  }

  async enqueue(draft: ProductDraft): Promise<{ capture: QueuedCapture; product: Product }> {
    const validated = draftSchema.parse(draft);
    return this.transaction((state) => {
      const key = productKey(validated);
      const old = state.pending[key];
      // Repeated clicks reuse the same idempotency key; changed captures get a fresh revision.
      const capture: QueuedCapture =
        old && JSON.stringify(old.draft) === JSON.stringify(validated)
          ? { ...old, blocked: false, error: undefined, attempts: 0, nextAttemptAt: 0 }
          : { captureId: crypto.randomUUID(), draft: validated, attempts: 0, nextAttemptAt: 0 };
      const previous = Object.values(state.products).find((p) => productKey(p) === key);
      const product = mergeProduct(validated, previous);
      capture.nextAttemptAt = Math.max(capture.nextAttemptAt, state.notBefore);
      state.products[product.id] = product;
      state.pending[key] = capture;
      return { capture, product };
    });
  }

  async acknowledge(capture: QueuedCapture, product: Product): Promise<boolean> {
    const validated = productSchema.parse(product);
    if (productKey(validated) !== productKey(capture.draft))
      throw new Error('云端确认的商品与采集记录不匹配。');
    return this.transaction((state) => {
      const key = productKey(capture.draft);
      if (state.pending[key]?.captureId !== capture.captureId) return false;
      for (const [id, previous] of Object.entries(state.products))
        if (productKey(previous) === key) delete state.products[id];
      state.products[validated.id] = validated;
      delete state.pending[key];
      return true;
    });
  }

  async failed(
    capture: QueuedCapture,
    error: string,
    retryable: boolean,
    retryAfterMs?: number,
    rateLimited = false,
  ): Promise<void> {
    await this.transaction((state) => {
      const current = state.pending[productKey(capture.draft)];
      if (current?.captureId !== capture.captureId) return;
      current.attempts += 1;
      current.error = error;
      current.blocked = !retryable || current.attempts >= 8;
      current.nextAttemptAt =
        Date.now() +
        Math.max(retryAfterMs ?? 0, Math.min(30 * 60_000, 30_000 * 2 ** (current.attempts - 1)));
      if (rateLimited) state.notBefore = Math.max(state.notBefore, current.nextAttemptAt);
    });
  }

  async retryBlocked(): Promise<void> {
    await this.transaction((state) => {
      for (const capture of Object.values(state.pending)) {
        capture.attempts = 0;
        capture.nextAttemptAt = state.notBefore;
        capture.blocked = false;
      }
    });
  }
}
