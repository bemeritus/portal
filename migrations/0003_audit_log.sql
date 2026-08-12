-- Change history: one row per change anyone makes to the platform.
--
-- The point of this table is to survive the things it describes, so it is
-- deliberately denormalized and free of foreign keys onto its subject:
--   * `target_id` has no reference — deleting a document must not erase the
--     record that it was deleted, which is exactly the entry an admin looks for.
--   * `actor_name` and `target_name` are stored as they read at the time.
--     Resolving them by join at read time would silently rewrite history when a
--     user or category is later renamed, and lose the name entirely when the
--     row is gone.
-- `actor_id` keeps its reference (nulled on delete) only so entries by the same
-- account can still be grouped after a rename.
CREATE TABLE audit_log (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    actor_id    UUID REFERENCES users(id) ON DELETE SET NULL,
    actor_name  TEXT NOT NULL,
    -- '<subject>.<verb>', e.g. 'document.create'.
    action      TEXT NOT NULL,
    -- 'user' | 'category' | 'document' | 'upload' — what the action was about.
    target_type TEXT NOT NULL,
    target_id   UUID,
    target_name TEXT NOT NULL,
    -- One line of human-readable specifics: which fields changed, from what to
    -- what. NULL when the action itself says everything.
    details     TEXT
);

-- The log is read newest-first, always.
CREATE INDEX audit_log_at_idx ON audit_log (at DESC);
-- "what happened to documents" / "what did this account do" — the two filters
-- the admin screen offers.
CREATE INDEX audit_log_target_type_idx ON audit_log (target_type, at DESC);
CREATE INDEX audit_log_actor_idx ON audit_log (actor_id);
