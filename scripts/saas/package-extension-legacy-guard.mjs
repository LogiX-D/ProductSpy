import { resolve } from 'node:path';

export function assertLegacyPackaging(env = process.env) {
  if (
    env.PRODUCTSPY_MODE !== 'legacy' ||
    env.NEXT_PUBLIC_PRODUCTSPY_MODE !== 'legacy' ||
    env.VITE_PRODUCTSPY_MODE !== 'legacy'
  )
    throw new Error(
      'Historical packaging is disabled for SaaS. Use package:saas:extension for a new preview; legacy requires PRODUCTSPY_MODE, NEXT_PUBLIC_PRODUCTSPY_MODE and VITE_PRODUCTSPY_MODE=legacy explicitly.',
    );
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  try {
    assertLegacyPackaging();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
