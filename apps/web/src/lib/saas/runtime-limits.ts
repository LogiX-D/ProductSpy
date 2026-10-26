function integerSetting(name: string, fallback: number, maximum: number): number {
  const source = process.env[name];
  if (source === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(source))
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  const value = Number(source);
  if (!Number.isSafeInteger(value) || value > maximum)
    throw new Error(`${name} must be an integer between 1 and ${maximum}.`);
  return value;
}

/** Per process. Web and independent workers each have their own PostgreSQL pool. */
export function databasePoolMax(): number {
  return integerSetting('PRODUCTSPY_DB_POOL_MAX', 12, 20);
}

/** Per worker process, not a global limit across worker replicas. */
export function workerConcurrency(): number {
  return integerSetting('PRODUCTSPY_WORKER_CONCURRENCY', 2, 10);
}
