-- Tags: a cross-cutting label on documents, orthogonal to the single category
-- each document already belongs to. A support engineer can pin "network",
-- "windows" or "urgent" across categories and search them.

CREATE TABLE tags (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Case-insensitive uniqueness: "Network" and "network" are the one tag. Names
-- are stored already-normalised (trimmed, lower-cased) by the write path, so
-- this index also guards against a stray duplicate slipping in.
CREATE UNIQUE INDEX tags_name_key ON tags (lower(name));

CREATE TABLE document_tags (
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    tag_id      UUID NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
    PRIMARY KEY (document_id, tag_id)
);
-- The join is queried both ways: a document's tags, and (for search) the
-- documents carrying a tag.
CREATE INDEX document_tags_tag_idx ON document_tags (tag_id);
