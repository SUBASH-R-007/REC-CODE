-- Prisma stores DateTime in timestamp(3) columns as UTC wall-clock time. The
-- judge lease, blob authorisation and reconciler SQL compare those columns
-- with now(), and DB-side DEFAULT CURRENT_TIMESTAMP fills them, so every
-- session must run in UTC regardless of the server's configured TimeZone.
DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'UTC');
END
$$;
