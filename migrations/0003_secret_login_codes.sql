-- One-time transition to secret-code sign-in. Existing users and their IDs/roles remain unchanged.
ALTER TABLE users ADD COLUMN login_code_hash TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_login_code_hash_unique ON users(login_code_hash);
CREATE TABLE IF NOT EXISTS auth_login_attempts (
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_ip_time_idx ON auth_login_attempts(ip_hash, attempted_at);
