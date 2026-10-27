ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN avatar_url TEXT NOT NULL DEFAULT '';
ALTER TABLE classes ADD COLUMN invite_code TEXT;

UPDATE users SET display_name = username WHERE display_name = '';
UPDATE classes SET invite_code = lower(hex(randomblob(4))) WHERE invite_code IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS classes_invite_code_idx ON classes(invite_code);
