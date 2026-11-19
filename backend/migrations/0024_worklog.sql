-- Server-room work log (§ server operations journal).
--
-- A parallel to `documents`, but structured rather than Q&A: each row is one
-- piece of work carried out in the server room — who did it, when, where, what,
-- why, with what result, and any photos or videos taken. Sysadmins and
-- technicians fill it in as they go.
--
-- Unlike `documents` there is no revision history here (phase 1); changes are
-- tracked through the audit log. The author (`author_id`) is whoever recorded
-- the entry, which is a different thing from who did the work — that is the
-- performers, below, because server-room work is often done by several people
-- or by an outside technician who has no account here.

CREATE TABLE work_logs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Optional short label for the list view. When absent the UI falls back to
    -- "<location> · <date>", so an entry is never nameless.
    title      TEXT,
    -- When the work was carried out — distinct from `created_at`, since an
    -- entry is often written up after the fact.
    performed_at TIMESTAMPTZ NOT NULL,
    -- "Qatda ishladi": free text, e.g. "Row 2, rack R-07". Linking this to the
    -- DC module's racks is left for a later phase.
    location   TEXT NOT NULL,
    -- "Nima ish qildi": the work itself.
    work       TEXT NOT NULL,
    -- "Qilingan ish sababi" / "natijasi": optional.
    reason     TEXT,
    result     TEXT,
    -- External performers with no account here, kept as plain names alongside
    -- the linked users in `work_log_performers`.
    external_performers TEXT[] NOT NULL DEFAULT '{}',
    -- Who recorded the entry. Kept even if the account is later deleted, so the
    -- journal does not lose its provenance.
    author_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The list is ordered by when the work happened, newest first.
CREATE INDEX work_logs_performed_at_idx ON work_logs (performed_at DESC);
CREATE INDEX work_logs_location_idx ON work_logs (lower(location));

-- "Kim ishladi" — the registered users who did the work. A join table rather
-- than an array so it references real accounts; external people stay in
-- `work_logs.external_performers`.
CREATE TABLE work_log_performers (
    work_log_id UUID NOT NULL REFERENCES work_logs(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (work_log_id, user_id)
);

-- "Rasm, Video" — the photos and videos attached to an entry. The file itself
-- is written to the uploads directory exactly like a document's images; this
-- row records which entry it belongs to and whether it is a picture or a clip.
CREATE TABLE work_log_media (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    work_log_id   UUID NOT NULL REFERENCES work_logs(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN ('image', 'video')),
    -- A bare filename under the uploads directory (no path separators); the URL
    -- is reconstructed as `/uploads/<file_path>`. Kept out of a full URL so the
    -- uploads location can move without rewriting every row.
    file_path     TEXT NOT NULL,
    original_name TEXT NOT NULL,
    position      INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX work_log_media_log_idx ON work_log_media (work_log_id, position);
