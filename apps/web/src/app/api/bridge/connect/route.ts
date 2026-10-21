import {
  connectExtension,
  connectExtensionPreflight,
} from '../../../../lib/saas/extension-connect';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = connectExtension;
export const OPTIONS = connectExtensionPreflight;
