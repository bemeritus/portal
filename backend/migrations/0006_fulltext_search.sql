-- Full-text search across document titles and their Q&A block bodies (FR-18,
-- widened from title-only to the whole document).
--
-- The `'simple'` text-search config is deliberate: the content is a mix of
-- Uzbek, Russian and English, so any single-language stemmer would mangle two
-- of the three. `'simple'` just folds case and tokenises — the right choice
-- for a mixed-language internal knowledge base. Substring/prefix matches while
-- typing are still handled by the query's ILIKE fallback; these vectors add
-- whole-word body search and the GIN indexes that make it fast.

ALTER TABLE documents
    ADD COLUMN search tsvector
    GENERATED ALWAYS AS (to_tsvector('simple', coalesce(title, ''))) STORED;
CREATE INDEX documents_search_idx ON documents USING GIN (search);

ALTER TABLE qa_blocks
    ADD COLUMN search tsvector
    GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(question, '') || ' ' || coalesce(answer, ''))
    ) STORED;
CREATE INDEX qa_blocks_search_idx ON qa_blocks USING GIN (search);
