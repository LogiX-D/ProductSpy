-- Run AFTER migrations with a database administrator in psql.
-- Create the login with an interactive password prompt; do not commit a real password.
CREATE ROLE productspy_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE productspy TO productspy_app;
GRANT USAGE ON SCHEMA public TO productspy_app;
GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO productspy_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO productspy_app;
-- In psql: \password productspy_app
