-- Run in the Supabase SQL editor to publish operational table changes.
-- User credentials are deliberately excluded from Realtime.
DO $$
DECLARE
  table_name TEXT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    RAISE EXCEPTION 'Supabase publication supabase_realtime does not exist';
  END IF;

  FOREACH table_name IN ARRAY ARRAY['records', 'locks', 'daily_forms', 'shift_orders'] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime'
        AND schemaname = 'public'
        AND tablename = table_name
    ) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', table_name);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT ON TABLE public.records, public.locks, public.daily_forms, public.shift_orders TO anon, authenticated;
ALTER TABLE public.locks REPLICA IDENTITY FULL;