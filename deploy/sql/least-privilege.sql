-- Least-privilege PostgreSQL roles for FireSafety.
-- Run ONCE as a superuser on an empty database, BEFORE the first server start:
--   psql -v owner_pw="'...'" -v app_pw="'...'" -d firesafety -f least-privilege.sql
-- Then set:
--   MIGRATION_DATABASE_URL=postgres://fs_owner:<owner_pw>@db:5432/firesafety   (runs migrations, owns the schema)
--   DATABASE_URL=postgres://fs_app:<app_pw>@db:5432/firesafety                 (used by the running server)

CREATE ROLE fs_owner LOGIN PASSWORD :owner_pw;
CREATE ROLE fs_app   LOGIN PASSWORD :app_pw;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO fs_owner;
GRANT USAGE ON SCHEMA public TO fs_app;

-- Every table/sequence/function created later by fs_owner (i.e. by migrations):
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO fs_app;          -- no TRUNCATE, REFERENCES or TRIGGER
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO fs_app;
ALTER DEFAULT PRIVILEGES FOR ROLE fs_owner IN SCHEMA public
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

-- After the first migration run (fs_owner), restrict the audit log to append-only for the app.
-- Re-run this block after future migrations that touch audit_log:
--   REVOKE UPDATE, DELETE ON audit_log FROM fs_app;
