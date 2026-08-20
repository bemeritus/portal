-- Knowledge Base / Q&A platform — initial schema.
-- Requires the pgcrypto extension for gen_random_uuid().
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 6.1 users -----------------------------------------------------------------
CREATE TABLE users (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    can_read      BOOLEAN NOT NULL DEFAULT TRUE,
    can_write     BOOLEAN NOT NULL DEFAULT FALSE,
    can_edit      BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete    BOOLEAN NOT NULL DEFAULT FALSE,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by    UUID REFERENCES users(id) ON DELETE SET NULL
);

-- 6.2 categories ------------------------------------------------------------
CREATE TABLE categories (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL UNIQUE,
    slug        TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 6.3 documents -------------------------------------------------------------
CREATE TABLE documents (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE RESTRICT,
    author_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Filtering: by title (ILIKE) and by category.
CREATE INDEX documents_title_idx ON documents (lower(title));
CREATE INDEX documents_category_idx ON documents (category_id);

-- 6.4 qa_blocks -------------------------------------------------------------
CREATE TABLE qa_blocks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id UUID NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    question    TEXT NOT NULL,
    answer      TEXT NOT NULL,
    position    INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX qa_blocks_document_idx ON qa_blocks (document_id, position);

-- 6.5 uploads ---------------------------------------------------------------
CREATE TABLE uploads (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_path     TEXT NOT NULL,
    original_name TEXT NOT NULL,
    uploaded_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
