export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS workspace (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  icon        TEXT,
  color       TEXT,
  sort_order  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS runtime (
  id          TEXT PRIMARY KEY,
  kind        TEXT NOT NULL,
  version     TEXT NOT NULL,
  path        TEXT NOT NULL,
  is_default  INTEGER DEFAULT 0,
  source      TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS project (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  display_name  TEXT,
  path          TEXT NOT NULL,
  type          TEXT NOT NULL,
  framework     TEXT,
  runtime_id    TEXT REFERENCES runtime(id),
  tags          TEXT,
  description   TEXT,
  last_run_at   TEXT,
  created_at    TEXT DEFAULT (datetime('now')),
  updated_at    TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_project_workspace ON project(workspace_id);

CREATE TABLE IF NOT EXISTS project_remote (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,
  platform    TEXT NOT NULL DEFAULT 'other',
  is_default  INTEGER DEFAULT 0,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_remote_project ON project_remote(project_id);

CREATE TABLE IF NOT EXISTS project_config (
  project_id      TEXT PRIMARY KEY REFERENCES project(id) ON DELETE CASCADE,
  run_command     TEXT,
  hidden_run_commands TEXT NOT NULL DEFAULT '[]',
  run_env         TEXT,
  build_env       TEXT,
  run_cwd         TEXT,
  port            INTEGER,
  auto_restart    INTEGER DEFAULT 0,
  extra           TEXT
);

CREATE TABLE IF NOT EXISTS deploy_target (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  host          TEXT,
  port          INTEGER DEFAULT 22,
  username      TEXT,
  auth_type     TEXT,
  credential_key TEXT,
  registry_url  TEXT,
  image_name    TEXT,
  remote_path   TEXT,
  pre_command   TEXT,
  post_command  TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task_history (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  status        TEXT NOT NULL,
  command       TEXT,
  log_path      TEXT,
  pid           INTEGER,
  exit_code     INTEGER,
  started_at    TEXT DEFAULT (datetime('now')),
  ended_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_task_project ON task_history(project_id);
CREATE INDEX IF NOT EXISTS idx_task_type_status ON task_history(type, status);

CREATE TABLE IF NOT EXISTS git_account (
  id            TEXT PRIMARY KEY,
  workspace_id  TEXT NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  username      TEXT NOT NULL,
  credential_key TEXT,
  base_url      TEXT,
  created_at    TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS task (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  tag         TEXT NOT NULL DEFAULT 'chore',
  done        INTEGER DEFAULT 0,
  sort_order  INTEGER DEFAULT 0,
  group_name  TEXT,
  created_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_task_todo ON task(project_id, done);

CREATE TABLE IF NOT EXISTS service (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  group_name      TEXT,
  command         TEXT NOT NULL,
  cwd             TEXT,
  port            INTEGER,
  autostart       INTEGER DEFAULT 0,
  source          TEXT NOT NULL DEFAULT 'manual',
  native_id       TEXT,
  description     TEXT,
  last_status     TEXT,
  last_started_at TEXT,
  created_at      TEXT DEFAULT (datetime('now')),
  updated_at      TEXT DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_service_native ON service(source, native_id) WHERE native_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ai_config (
  id         TEXT PRIMARY KEY DEFAULT 'default',
  provider   TEXT NOT NULL DEFAULT 'ollama',
  base_url   TEXT NOT NULL DEFAULT '',
  api_key    TEXT NOT NULL DEFAULT '',
  model      TEXT NOT NULL DEFAULT '',
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT DEFAULT (datetime('now'))
);
`

export const SEED_SQL = `
INSERT OR IGNORE INTO workspace (id, name, kind, icon, sort_order) VALUES
  ('ws-personal', '个人', 'personal', 'User', 0),
  ('ws-company',  '公司', 'company',  'OfficeBuilding', 1);
`
