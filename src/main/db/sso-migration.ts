import type { Migration } from './migrations'

export const SSO_N = 14 // regions 12, playbook-ops 13

export const ssoMigration: Migration = {
  version: SSO_N,
  name: 'sso_login',
  up: `
ALTER TABLE vault_state ADD COLUMN pin_wrap TEXT;
ALTER TABLE vault_state ADD COLUMN pin_salt TEXT;
ALTER TABLE vault_state ADD COLUMN pin_pepper_blob TEXT;
ALTER TABLE vault_state ADD COLUMN pin_failed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE vault_state ADD COLUMN last_method TEXT CHECK (last_method IN ('touchId','pin','password'));
ALTER TABLE vault_state ADD COLUMN password_wrap TEXT;
ALTER TABLE vault_state ADD COLUMN password_kdf TEXT;
CREATE TABLE sso_binding(id INTEGER PRIMARY KEY CHECK (id = 1),
  hub_id TEXT NOT NULL, user_oid TEXT NOT NULL, user_upn TEXT NOT NULL,
  bound_at TEXT NOT NULL, last_verified_at TEXT, high_water_at TEXT);
`,
}
