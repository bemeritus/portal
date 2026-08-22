-- Sections: the outer "door" of a two-level access model.
--
-- A section is the top layer added above the existing category + Q&A world.
-- Access is checked in two steps: first the door (this table), then the finer
-- grant inside it — the per-category permissions for `templates`, the author
-- bit here for `learning`.
--
--   section_access(user, section) := user.is_admin OR row_exists(user, section)
--
--   can(user, category, action)   := user.is_admin
--       OR ( section_access(user, 'templates') AND grant(user, category, action) )
--
-- `section` is a fixed, code-level set (the Rust `Section` enum), not a lookup
-- table: a new section is always new tables + API + UI, i.e. always a code
-- change, so a data-only row could add nothing usable. The CHECK is that rule
-- written where the database can enforce it.
CREATE TABLE user_sections (
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    section    TEXT NOT NULL CHECK (section IN ('templates', 'learning')),
    -- Only meaningful for `learning`, whose content is authored by a teacher
    -- who is not an admin. A `templates` row may never carry it, so an
    -- authoring bit can never leak into templates — whose write access comes
    -- entirely from category grants. Enforced here rather than trusted to the
    -- callers: this is the guardrail that stops a repeat of the dead `can_*`
    -- columns, where a flag on the wrong row silently granted access.
    can_author BOOLEAN NOT NULL DEFAULT FALSE
               CHECK (section = 'learning' OR NOT can_author),
    granted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, section)
);

-- Reverse lookup: "who is in this section?"
CREATE INDEX user_sections_section_idx ON user_sections (section);

-- Backfill: every existing non-admin who holds any category grant must keep
-- reaching it. Without this the new templates door closes in front of grants
-- they already had — the exact dead state this layer exists to prevent. Admins
-- need no row (they bypass the door in code), so they are left out, matching
-- how they already hold no category grants either.
INSERT INTO user_sections (user_id, section, granted_by)
SELECT DISTINCT p.user_id, 'templates', NULL::uuid
FROM user_category_permissions p
WHERE p.can_read OR p.can_write OR p.can_edit OR p.can_delete
ON CONFLICT DO NOTHING;
