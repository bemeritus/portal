-- Document feedback and the signals an admin needs to spot stale or missing
-- content: helpfulness votes, an open counter, and a log of searches that
-- found nothing (a content gap someone tried to fill).

-- One vote per user per document, changeable — the PK enforces "one", the
-- write path upserts to let a reader flip 👍 ↔ 👎 or clear it.
CREATE TABLE document_feedback (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    helpful     BOOLEAN NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (document_id, user_id)
);
CREATE INDEX document_feedback_doc_idx ON document_feedback (document_id);

-- A plain open counter. "Views" here means opens, refreshes included — an
-- internal tool does not need per-visitor deduplication to answer "what do
-- people actually read".
ALTER TABLE documents ADD COLUMN view_count BIGINT NOT NULL DEFAULT 0;

-- Searches that returned nothing, so the analytics can surface the questions
-- the knowledge base cannot yet answer. Only deliberate misses are logged (the
-- write path guards on length); the user is kept for context but nullable so a
-- deleted account does not erase the gap it revealed.
CREATE TABLE search_misses (
    id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    query   TEXT NOT NULL,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX search_misses_query_idx ON search_misses (lower(query));
CREATE INDEX search_misses_at_idx ON search_misses (at DESC);
