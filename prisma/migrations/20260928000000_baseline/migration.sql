CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shift_type') THEN
    CREATE TYPE shift_type AS ENUM ('morning', 'afternoon', 'evening', 'night');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'record_status') THEN
    CREATE TYPE record_status AS ENUM ('received', 'pending', 'dispatched');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sync_status') THEN
    CREATE TYPE sync_status AS ENUM ('synced', 'pending');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS "records" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "shift" "shift_type" NOT NULL,
    "material" TEXT NOT NULL DEFAULT '',
    "color" TEXT NOT NULL DEFAULT '',
    "row_key" TEXT NOT NULL DEFAULT '',
    "quantity" INTEGER DEFAULT 0,
    "laundry_personnel" TEXT NOT NULL DEFAULT '',
    "verified_by" TEXT NOT NULL DEFAULT '',
    "signature" TEXT NOT NULL DEFAULT '',
    "status" "record_status" NOT NULL DEFAULT 'received',
    "sync_status" "sync_status" NOT NULL DEFAULT 'pending',
    "sync_error" TEXT NOT NULL DEFAULT '',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "synced_at" TIMESTAMPTZ(6),
    CONSTRAINT "records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "records_quantity_check" CHECK ("quantity" >= 0)
);

CREATE INDEX IF NOT EXISTS "idx_records_date" ON "records"("date");
CREATE INDEX IF NOT EXISTS "idx_records_shift" ON "records"("shift");
CREATE INDEX IF NOT EXISTS "idx_records_date_shift" ON "records"("date", "shift");
CREATE INDEX IF NOT EXISTS "idx_records_monthly" ON "records"("date", "material", "color");
CREATE INDEX IF NOT EXISTS "idx_records_sync_status" ON "records"("sync_status");
CREATE INDEX IF NOT EXISTS "idx_records_status" ON "records"("status");

CREATE TABLE IF NOT EXISTS "locks" (
    "id" SERIAL NOT NULL,
    "date" DATE NOT NULL,
    "shift" "shift_type" NOT NULL,
    "locked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL DEFAULT 'Shift closed',
    CONSTRAINT "locks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "locks_date_shift_key" UNIQUE ("date", "shift")
);

CREATE INDEX IF NOT EXISTS "idx_locks_date_shift" ON "locks"("date", "shift");

CREATE TABLE IF NOT EXISTS "daily_forms" (
    "date" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "daily_forms_pkey" PRIMARY KEY ("date")
);

CREATE TABLE IF NOT EXISTS "sync_events" (
    "id" SERIAL NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "detail" JSONB,
    CONSTRAINT "sync_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "idx_sync_events_at" ON "sync_events"("at" DESC);

CREATE TABLE IF NOT EXISTS "users" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_login_at" TIMESTAMPTZ(6),
    CONSTRAINT "users_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "users_email_key" UNIQUE ("email")
);

CREATE INDEX IF NOT EXISTS "idx_users_email" ON "users"("email");