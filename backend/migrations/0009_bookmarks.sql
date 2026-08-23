-- Per-user bookmarks: a private shortlist of documents someone wants to find
-- again fast. Orthogonal to feedback and tags — this one is personal, never
-- aggregated or shown to anyone else.

CREATE TABLE bookmarks (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, document_id)
);
-- The list view reads "my bookmarks, newest first".
CREATE INDEX bookmarks_user_idx ON bookmarks (user_id, created_at DESC);
