-- Run as fs_owner after migrations: the application may only read and append to the audit log.
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM fs_app;
GRANT SELECT, INSERT ON audit_log TO fs_app;
