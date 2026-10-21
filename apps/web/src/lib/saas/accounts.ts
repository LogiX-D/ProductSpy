import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { z } from 'zod';
import { query, dbTransaction } from './database';
import { currentUserId, withTenant } from './context';
import { accountCookie, extensionOriginPattern } from './config';
import { rateLimit, requestToken, tokenHash, type AccountUser } from './security';
import { AppError } from '../server/errors';

const scrypt = promisify(scryptCallback);
const credentialsSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().max(254),
    password: z.string().min(12).max(256),
    name: z.string().trim().min(1).max(80).optional(),
  })
  .strict();
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString('hex');
  const key = (await scrypt(password, salt, 64)) as Buffer;
  return `scrypt$${salt}$${key.toString('hex')}`;
}
async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const parts = encoded.split('$');
  const valid =
    parts.length === 3 &&
    parts[0] === 'scrypt' &&
    /^[a-f0-9]{32}$/.test(parts[1]) &&
    /^[a-f0-9]{128}$/.test(parts[2]);
  const key = (await scrypt(
    password,
    valid ? parts[1] : '00000000000000000000000000000000',
    64,
  )) as Buffer;
  return valid && timingSafeEqual(key, Buffer.from(parts[2], 'hex'));
}
export async function issueSession(
  userId: string,
  kind: 'web' | 'extension',
  origin?: string,
): Promise<{ token: string; expiresAt: string }> {
  const token = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + (kind === 'web' ? 7 : 30) * 86400_000).toISOString();
  await query(
    'INSERT INTO sessions(token_hash,user_id,kind,extension_origin,expires_at) VALUES($1,$2,$3,$4,$5)',
    [tokenHash(token), userId, kind, origin ?? null, expiresAt],
  );
  return { token, expiresAt };
}
export async function signIn(
  body: unknown,
  register: boolean,
): Promise<{ user: AccountUser; cookie: string }> {
  const parsed = credentialsSchema.safeParse(body);
  if (!parsed.success) throw new AppError(400, '请输入有效邮箱、12–256 位密码和姓名');
  const input = parsed.data;
  // Reject globally throttled traffic before creating caller-selected email keys.
  await rateLimit('account-auth-global', 200, 60);
  await rateLimit(`login:${input.email}`, 10, 900);
  let userId: string | undefined;
  if (register) {
    const encoded = await passwordHash(input.password);
    const user: AccountUser = {
      id: randomUUID(),
      email: input.email,
      name: input.name ?? input.email.split('@')[0],
      createdAt: new Date().toISOString(),
    };
    userId = user.id;
    try {
      await dbTransaction(async () => {
        await query(
          'INSERT INTO users(id,email,password_hash,name,created_at) VALUES($1,$2,$3,$4,$5)',
          [user.id, user.email, encoded, user.name, user.createdAt],
        );
        await query("SELECT set_config('app.user_id',$1,true)", [user.id]);
        await query(
          "INSERT INTO subscriptions(user_id,plan,status,updated_at) VALUES($1,'free','active',now())",
          [user.id],
        );
      });
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === '23505')
        throw new AppError(409, '此邮箱已注册，请登录');
      throw error;
    }
  } else {
    // Identify the lock owner only. Credentials must be read again after acquiring it.
    const { rows } = await query<{ id: string }>('SELECT id FROM users WHERE email=$1', [
      input.email,
    ]);
    userId = rows[0]?.id;
  }
  if (!userId) {
    await passwordMatches(input.password, '');
    throw new AppError(401, '邮箱或密码不正确');
  }
  return withTenant(userId, async () => {
    const { rows } = await query<{
      id: string;
      email: string;
      name: string;
      password_hash: string;
      created_at: string | Date;
    }>('SELECT id,email,name,password_hash,created_at FROM users WHERE id=$1', [userId]);
    const row = rows[0];
    const matches = await passwordMatches(input.password, row?.password_hash ?? '');
    if (!row || !matches) throw new AppError(401, '邮箱或密码不正确');
    const user: AccountUser = {
      id: row.id,
      email: row.email,
      name: row.name,
      createdAt: new Date(row.created_at).toISOString(),
    };
    // Password changes hold the same tenant lock, so verification and issuance are indivisible.
    const session = await issueSession(user.id, 'web');
    return { user, cookie: accountCookie(session.token) };
  });
}
export async function signOut(request: Request): Promise<void> {
  await query('UPDATE sessions SET revoked_at=now() WHERE token_hash=$1 AND user_id=$2', [
    tokenHash(requestToken(request)),
    currentUserId(),
  ]);
}
export async function changePassword(body: unknown): Promise<void> {
  const parsed = z
    .object({ currentPassword: z.string().max(256), password: z.string().min(12).max(256) })
    .strict()
    .safeParse(body);
  if (!parsed.success) throw new AppError(400, '新密码至少 12 位，最多 256 位');
  const userId = currentUserId();
  await rateLimit(`password:${userId}`, 5, 900);
  const { rows } = await query<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id=$1',
    [userId],
  );
  if (!rows[0] || !(await passwordMatches(parsed.data.currentPassword, rows[0].password_hash)))
    throw new AppError(403, '当前密码不正确');
  const encoded = await passwordHash(parsed.data.password);
  await dbTransaction(async () => {
    await query('UPDATE users SET password_hash=$1 WHERE id=$2', [encoded, userId]);
    await query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1', [userId]);
    await query('UPDATE extension_codes SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [
      userId,
    ]);
  });
}
export async function cloudPairCode(body: unknown): Promise<{ code: string; expiresAt: string }> {
  const parsed = z
    .object({ extensionOrigin: z.string().regex(extensionOriginPattern) })
    .strict()
    .safeParse(body);
  if (!parsed.success) throw new AppError(400, '请输入插件页面显示的 Chrome 扩展 ID');
  const code = randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 120_000).toISOString();
  await query(
    'INSERT INTO extension_codes(code_hash,user_id,origin,expires_at) VALUES($1,$2,$3,$4)',
    [tokenHash(code), currentUserId(), parsed.data.extensionOrigin, expiresAt],
  );
  return { code, expiresAt };
}
export async function cloudPair(
  request: Request,
  body: unknown,
): Promise<{ token: string; user: AccountUser; expiresAt: string }> {
  const parsed = z
    .object({ code: z.string().regex(/^[a-f0-9]{32}$/) })
    .strict()
    .safeParse(body);
  if (!parsed.success) throw new AppError(400, '请输入 SaaS 工作台生成的授权码');
  const origin = request.headers.get('origin') ?? '';
  await rateLimit(`pair:${origin}`, 20);
  const codeHash = tokenHash(parsed.data.code);
  const candidates = await query<{ user_id: string }>(
    'SELECT user_id FROM extension_codes WHERE code_hash=$1 AND origin=$2 AND expires_at>now() AND used_at IS NULL',
    [codeHash, origin],
  );
  const userId = candidates.rows[0]?.user_id;
  if (!userId) throw new AppError(401, '授权码无效、已使用、已过期或扩展 ID 不匹配');
  // Acquire the tenant lock before any transaction/code row lock, matching password changes.
  return withTenant(userId, () =>
    dbTransaction(async () => {
      const { rows } = await query<{ user_id: string }>(
        'UPDATE extension_codes SET used_at=now() WHERE code_hash=$1 AND origin=$2 AND expires_at>now() AND used_at IS NULL RETURNING user_id',
        [codeHash, origin],
      );
      if (!rows[0] || rows[0].user_id !== userId)
        throw new AppError(401, '授权码无效、已使用、已过期或扩展 ID 不匹配');
      const result = await query<{
        id: string;
        email: string;
        name: string;
        created_at: string | Date;
      }>('SELECT id,email,name,created_at FROM users WHERE id=$1', [rows[0].user_id]);
      const row = result.rows[0];
      const session = await issueSession(row.id, 'extension', origin);
      return {
        ...session,
        user: {
          id: row.id,
          email: row.email,
          name: row.name,
          createdAt: new Date(row.created_at).toISOString(),
        },
      };
    }),
  );
}
