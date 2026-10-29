PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT NOT NULL DEFAULT '',
  avatar_url TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  login_code_hash TEXT UNIQUE,
  role TEXT NOT NULL DEFAULT 'student' CHECK (role IN ('student','teacher','moderator','administrator')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','suspended','disabled')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  ip_hash TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS classes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  invite_code TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS class_members (
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  class_role TEXT NOT NULL DEFAULT 'student' CHECK (class_role IN ('student','teacher')),
  joined_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(class_id,user_id)
);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY,
  class_id TEXT NOT NULL REFERENCES classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  visibility TEXT NOT NULL DEFAULT 'class' CHECK (visibility IN ('class','private')),
  created_by TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(class_id,name)
);
CREATE TABLE IF NOT EXISTS channel_members (
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(channel_id,user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
  reply_to TEXT REFERENCES messages(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS messages_channel_time_idx ON messages(channel_id,created_at);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS direct_messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL CHECK(length(content) BETWEEN 1 AND 4000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  edited_at TEXT,
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS dms_conversation_time_idx ON direct_messages(conversation_id,created_at);
CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  action TEXT NOT NULL,
  target TEXT,
  result TEXT NOT NULL DEFAULT 'success',
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS audit_time_idx ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_logs(actor_id,created_at);
CREATE TABLE IF NOT EXISTS reports (
  id TEXT PRIMARY KEY,
  reporter_id TEXT NOT NULL REFERENCES users(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('user','channel_message','direct_message')),
  target_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','reviewing','resolved','dismissed')),
  assigned_to TEXT REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS reports_status_idx ON reports(status,created_at);


-- Site-wide configuration is editable through the Campusly administration console.
CREATE TABLE IF NOT EXISTS site_settings (
  setting_key TEXT PRIMARY KEY,
  setting_value TEXT NOT NULL,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- School announcements can be targeted, pinned, published, drafted, edited, or removed.
CREATE TABLE IF NOT EXISTS announcements (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  audience TEXT NOT NULL DEFAULT 'all' CHECK (audience IN ('all','students','teachers','staff')),
  pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0,1)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0,1)),
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS announcements_active_idx ON announcements(active,pinned,created_at);

CREATE TABLE IF NOT EXISTS auth_login_attempts (
  ip_hash TEXT NOT NULL,
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS auth_login_attempts_ip_time_idx ON auth_login_attempts(ip_hash, attempted_at);
