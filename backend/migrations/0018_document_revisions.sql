-- Document history: every state a document has ever been in, so an edit can be
-- read back and restored (GitHub-style history, not an undo buffer).
--
-- Why whole snapshots rather than stored deltas:
--
--   * A document is a title, a status, a category and a handful of Q&A blocks —
--     kilobytes. Storing the full state costs little and makes reading *any*
--     revision a single row read instead of replaying a chain.
--   * A delta chain is only as good as its weakest link: one lost or mis-applied
--     delta corrupts every later version. Snapshots are independent.
--   * Diffs are what the reader wants, and those are computed on read from two
--     snapshots. Computing them is cheap; reconstructing a lost state is not.
--
-- The blocks are frozen into JSONB rather than referencing `qa_blocks`: that
-- table is rewritten wholesale on every save (ids change), so a reference would
-- not survive the very edit this table exists to record.
--
-- Invariant maintained by the write paths: every document has at least one
-- revision, and its highest-numbered revision equals the live document.

CREATE TABLE document_revisions (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id   UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    -- Per-document counter, 1-based. A timestamp would not do: two saves can
    -- share a millisecond, and "#4" is what a person refers to.
    revision      INTEGER NOT NULL,
    -- Why this revision exists. Machine-readable so the UI can say it in the
    -- reader's own language instead of showing a stored English sentence.
    --   created  — the document's first save
    --   edited   — an ordinary save
    --   restored — an older revision was put back; see `restored_from`
    --   baseline — the state at the moment history started being kept, for
    --              documents that already existed before this table did
    kind          TEXT NOT NULL CHECK (kind IN ('created', 'edited', 'restored', 'baseline')),
    restored_from INTEGER,
    title         TEXT NOT NULL,
    -- The category may be deleted later; the revision stays readable without
    -- it, so this is nullable rather than RESTRICT. Restoring then asks for a
    -- category instead of resurrecting one.
    category_id   UUID REFERENCES categories(id) ON DELETE SET NULL,
    status        TEXT NOT NULL,
    -- [{"question": "...", "answer": "..."}] in display order.
    blocks        JSONB NOT NULL,
    -- Deleting a user keeps their edits in the history, unattributed.
    edited_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    edited_at     TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE (document_id, revision),
    -- `restored_from` only means something on a restore, and a restore always
    -- names its source.
    CHECK ((kind = 'restored') = (restored_from IS NOT NULL))
);

-- The history page reads one document's revisions, newest first.
CREATE INDEX document_revisions_doc_idx ON document_revisions (document_id, revision DESC);

-- Backfill: give every existing document a first revision from its current
-- state, so no document opens on an empty history. These are `baseline`, not
-- `created` — the state they record is "when history started", and claiming it
-- is the document's original form would be a lie this table cannot support.
INSERT INTO document_revisions
    (document_id, revision, kind, title, category_id, status, blocks, edited_by, edited_at)
SELECT d.id,
       1,
       'baseline',
       d.title,
       d.category_id,
       d.status,
       COALESCE(
           (SELECT jsonb_agg(jsonb_build_object('question', b.question, 'answer', b.answer)
                             ORDER BY b.position, b.created_at)
            FROM qa_blocks b WHERE b.document_id = d.id),
           '[]'::jsonb
       ),
       d.author_id,
       d.updated_at
FROM documents d;
