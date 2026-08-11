-- Per-category permissions.
--
-- Semantics (additive): a non-admin user may perform an action on a document
-- in category C when either the global flag on `users` is set (which grants the
-- action across *all* categories) or a row here grants it for C specifically.
-- Admins keep everything. A user with no row for C and no global flag has no
-- access to C.
CREATE TABLE user_category_permissions (
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    category_id UUID NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    can_read    BOOLEAN NOT NULL DEFAULT FALSE,
    can_write   BOOLEAN NOT NULL DEFAULT FALSE,
    can_edit    BOOLEAN NOT NULL DEFAULT FALSE,
    can_delete  BOOLEAN NOT NULL DEFAULT FALSE,
    granted_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    granted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, category_id)
);

-- Reverse lookup: "who can touch this category?"
CREATE INDEX user_category_permissions_category_idx
    ON user_category_permissions (category_id);
