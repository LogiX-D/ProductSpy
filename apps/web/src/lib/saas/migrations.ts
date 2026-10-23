/** Idempotent bootstrap migration. Run with a migration role before production traffic. */
export const migrationSQL = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
  name text NOT NULL DEFAULT '', created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('web','extension')), extension_origin text,
  expires_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id, expires_at);
CREATE TABLE IF NOT EXISTS extension_codes (
  code_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  origin text, expires_at timestamptz NOT NULL, used_at timestamptz
);
CREATE TABLE IF NOT EXISTS workspace_documents (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, name text NOT NULL,
  payload jsonb NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,name),
  CHECK (name IN ('products.json','templates.json','comparisons.json','content-plans.json','analysis-usage.json'))
);
CREATE TABLE IF NOT EXISTS subscriptions (
  user_id text PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan text NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro')),
  status text NOT NULL DEFAULT 'active', customer_id text UNIQUE, subscription_id text UNIQUE,
  current_period_end timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS checkout_attempt_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS checkout_started_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS checkout_session_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS checkout_request jsonb;
CREATE TABLE IF NOT EXISTS usage_events (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, id text NOT NULL,
  kind text NOT NULL, period text NOT NULL, quantity integer NOT NULL DEFAULT 1 CHECK(quantity>0),
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,id)
);
CREATE INDEX IF NOT EXISTS usage_period_idx ON usage_events(user_id,period,kind);
CREATE TABLE IF NOT EXISTS jobs (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, id text NOT NULL,
  kind text NOT NULL, status text NOT NULL, payload jsonb NOT NULL DEFAULT '{}', result jsonb,
  attempts integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(), error text, PRIMARY KEY(user_id,id)
);
CREATE INDEX IF NOT EXISTS jobs_status_idx ON jobs(user_id,status,created_at);
CREATE INDEX IF NOT EXISTS jobs_history_idx ON jobs(user_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS job_dispatch (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(user_id,id)
);
CREATE TABLE IF NOT EXISTS capture_events (
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE, id text NOT NULL,
  payload_hash text NOT NULL, product_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(user_id,id)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id text PRIMARY KEY, user_id text REFERENCES users(id) ON DELETE CASCADE,
  action text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_user_idx ON audit_events(user_id,created_at);
CREATE TABLE IF NOT EXISTS webhook_events (id text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS api_rate_limits (key text PRIMARY KEY, window_start timestamptz NOT NULL, count integer NOT NULL);
CREATE TABLE IF NOT EXISTS ai_channel_settings (
  id text PRIMARY KEY CHECK(id='global'), revision bigint NOT NULL CHECK(revision>0),
  encrypted_payload text NOT NULL, updated_by text NOT NULL REFERENCES users(id),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE ai_channel_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_channel_settings FORCE ROW LEVEL SECURITY;
DO $ai_channels$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename='ai_channel_settings' AND policyname='ai_configuration_scope') THEN
    CREATE POLICY ai_configuration_scope ON ai_channel_settings
      USING (current_setting('app.ai_configuration_access',true)='trusted-server')
      WITH CHECK (current_setting('app.ai_configuration_access',true)='trusted-server');
  END IF;
END $ai_channels$;
DO $migration$
DECLARE tenant_table text;
BEGIN
  FOREACH tenant_table IN ARRAY ARRAY['workspace_documents','subscriptions','usage_events','jobs','capture_events','audit_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',tenant_table);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',tenant_table);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname=current_schema() AND tablename=tenant_table AND policyname='tenant_scope') THEN
      EXECUTE format('CREATE POLICY tenant_scope ON %I USING (user_id = NULLIF(current_setting(''app.user_id'',true),'''')) WITH CHECK (user_id = NULLIF(current_setting(''app.user_id'',true),''''))',tenant_table);
    END IF;
  END LOOP;
END $migration$;
`;
