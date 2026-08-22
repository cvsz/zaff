-- migrate:up
-- Shared disposable dev databases may hold a leftover recovery_tokens whose
-- schema_migrations row was wiped by test schema resets (FK cascade drops
-- the constraint, not the referencing table). Drop any orphan first so the
-- bare CREATE below always applies cleanly.
DROP TABLE IF EXISTS recovery_tokens;

ALTER TABLE users
  ADD COLUMN email_verified boolean NOT NULL DEFAULT false;

CREATE TABLE recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose text NOT NULL CHECK (purpose IN ('email_verify', 'password_reset')),
  token_hash text UNIQUE NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_recovery_tokens_user_id ON recovery_tokens (user_id);

CREATE INDEX idx_recovery_tokens_purpose_used_at ON recovery_tokens (purpose, used_at);

-- migrate:down
DROP TABLE IF EXISTS recovery_tokens;
ALTER TABLE users DROP COLUMN IF EXISTS email_verified;
