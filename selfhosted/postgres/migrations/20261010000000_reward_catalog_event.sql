-- Founder 2026-10-09: Reward Catalog entries can be marked EVENT (an own tab in the Founder Control Center).
-- Additive and display-only; the same statement is part of selfhosted/postgres/manual/seeker-admin-mail.sql.
ALTER TABLE public.reward_catalog ADD COLUMN IF NOT EXISTS event boolean NOT NULL DEFAULT false;
