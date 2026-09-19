-- PostgreSQL schema for Laundry Tracking PWA
-- This replaces the JSON file (data/records.json) as the primary data store.
-- Google Sheets remains an optional export target only.

-- Enable UUID extension (not required, but available if needed)
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ENUM types matching the application's domains
-- Use DO blocks so re-running the schema does not fail on existing types.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'shift_type') THEN
    CREATE TYPE shift_type AS ENUM ('morning', 'afternoon', 'evening', 'night');
  ELSIF NOT EXISTS (
    SELECT 1
    FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'shift_type' AND e.enumlabel = 'evening'
  ) THEN
    ALTER TYPE shift_type ADD VALUE 'evening' BEFORE 'night';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'record_status') THEN
    CREATE TYPE record_status AS ENUM ('received', 'pending', 'dispatched');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'sync_status') THEN
    CREATE TYPE sync_status AS ENUM ('synced', 'pending');
  END IF;
END
$$;

-- =========================================================================
-- records table
-- Primary entity. Maps 1:1 to the JSON "records" array.
-- Each row is one MATERIAL/QUANTITY entry on a shift sheet for a given date.
-- Uses TEXT primary key to preserve existing client-generated IDs
-- (UUIDs and fallback timestamp-based IDs like "sync-test-2026-09-18-morning-001").
-- =========================================================================
CREATE TABLE IF NOT EXISTS records (
    id              TEXT             PRIMARY KEY,
    date            DATE             NOT NULL,
    shift           shift_type       NOT NULL,
    material        TEXT             NOT NULL DEFAULT '',
    color           TEXT             NOT NULL DEFAULT '',
    row_key         TEXT             NOT NULL DEFAULT '',
    quantity        INTEGER          CHECK (quantity >= 0),
    laundry_personnel TEXT           NOT NULL DEFAULT '',
    verified_by     TEXT             NOT NULL DEFAULT '',
    signature       TEXT             NOT NULL DEFAULT '',
    status          record_status    NOT NULL DEFAULT 'received',
    sync_status     sync_status      NOT NULL DEFAULT 'pending',
    sync_error      TEXT             NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    synced_at       TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_records_date        ON records (date);
CREATE INDEX IF NOT EXISTS idx_records_shift       ON records (shift);
CREATE INDEX IF NOT EXISTS idx_records_date_shift  ON records (date, shift);
CREATE INDEX IF NOT EXISTS idx_records_monthly     ON records (date, material, color);
CREATE INDEX IF NOT EXISTS idx_records_sync_status ON records (sync_status);
CREATE INDEX IF NOT EXISTS idx_records_status      ON records (status);

ALTER TABLE records ADD COLUMN IF NOT EXISTS color TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS row_key TEXT NOT NULL DEFAULT '';
ALTER TABLE records ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT '';
ALTER TABLE records ALTER COLUMN quantity DROP NOT NULL;

-- =========================================================================
-- locks table
-- Replaces the JSON "locks" array. One lock per (date, shift) pair.
-- Locks prevent editing of historical or manually-closed shifts.
-- =========================================================================
CREATE TABLE IF NOT EXISTS locks (
    id          SERIAL PRIMARY KEY,
    date        DATE             NOT NULL,
    shift       shift_type       NOT NULL,
    locked_at   TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    reason      TEXT             NOT NULL DEFAULT 'Shift closed',
    UNIQUE (date, shift)
);

CREATE INDEX IF NOT EXISTS idx_locks_date_shift ON locks (date, shift);

-- =========================================================================
-- sync_events table
-- Replaces the JSON "syncEvents" array. Append-only log of sync attempts.
-- =========================================================================
CREATE TABLE IF NOT EXISTS sync_events (
    id          SERIAL PRIMARY KEY,
    at          TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    status      TEXT             NOT NULL,
    error       TEXT,
    detail      JSONB
);

CREATE INDEX IF NOT EXISTS idx_sync_events_at ON sync_events (at DESC);

-- =========================================================================
-- updated_at handling
-- =========================================================================
-- NOTE: there is deliberately NO trigger that rewrites updated_at on UPDATE.
-- The application sets updated_at explicitly on every write (PUT = new edit
-- timestamp; migration = preserved legacy timestamp; sync-status flips reuse
-- targeted UPDATEs of sync_status only). A BEFORE UPDATE trigger would stomp
-- those values and, worse, would rewrite updated_at on EVERY row touched by
-- a bulk upsert — making unrelated records look freshly edited and breaking
-- last-write-wins merge logic. If an updated_at default is ever needed again,
-- add it as an explicit per-query SET, not a blanket trigger.
-- =========================================================================
-- users table
-- Single universal shared login account for all workers.
-- No per-worker profiles, no roles, no registration: the application seeds
-- exactly one account (see server/seed-user.js) and the login endpoint
-- (POST /api/auth/login) authenticates against it.
-- Passwords are stored as scrypt hashes (never plain text).
-- =========================================================================
CREATE TABLE IF NOT EXISTS users (
    id            UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
    email         TEXT             NOT NULL UNIQUE,
    password_hash TEXT             NOT NULL,
    created_at    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ      NOT NULL DEFAULT NOW(),
    last_login_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users (email);
