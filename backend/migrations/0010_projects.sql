-- The `projects` section: lightweight project management on a Kanban board.
--
-- A third section alongside `templates` and `learning`, wired the same two-level
-- way. Entering the section (a `user_sections` row, or being an admin) lets a
-- member see the boards and do the work on them — create, move, assign and
-- close cards. The finer `can_author` bit is the project lead: it adds managing
-- the board *structure* itself — creating boards, and adding, renaming or
-- removing their columns. This mirrors learning exactly, where `can_author`
-- separates the teacher who builds a test from the learner who takes it, so no
-- new access concept is introduced.
--
-- Like learning, this world references nothing in templates: it is joined to the
-- rest only through the users who hold its door.

-- 1. Open the section door. Both CHECKs on `user_sections` name the sections by
--    hand, so both have to learn about `projects`: one to allow the row at all,
--    the other to allow the authoring bit on it (a project lead, like a
--    learning teacher, may carry `can_author`; a plain member may not).
ALTER TABLE user_sections DROP CONSTRAINT user_sections_section_check;
ALTER TABLE user_sections ADD CONSTRAINT user_sections_section_check
    CHECK (section IN ('templates', 'learning', 'projects'));

ALTER TABLE user_sections DROP CONSTRAINT user_sections_check;
ALTER TABLE user_sections ADD CONSTRAINT user_sections_check
    CHECK (section IN ('learning', 'projects') OR NOT can_author);

-- 2. A board — one Kanban board, owned by the section rather than by a person:
--    any member sees it, and the lead who created it holds no special right the
--    other leads lack (authoring is section-wide, not per-row ownership, the
--    same rule learning content follows). `created_by` records who made it for
--    the log; a deleted user must not take the board with them, hence SET NULL.
CREATE TABLE project_boards (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    description TEXT,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_boards_created_idx ON project_boards (created_at DESC);

-- 3. A column (a lane / status) on a board. Ordered left-to-right by `position`,
--    the same integer-order convention `qa_blocks` and test questions use.
--    Deleting a board takes its columns with it.
CREATE TABLE project_columns (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id   UUID NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_columns_board_idx ON project_columns (board_id, position);

-- 4. A card — the unit of work. Lives in exactly one column and is ordered
--    within it by `position`; a drag between columns is a change of `column_id`
--    and `position` together. The description is authored in markdown and
--    rendered server-side exactly like a document's answer (SR-13). Both the
--    assignee and the author are SET NULL on user deletion: a card outlives the
--    people it once named, and the card's own history is not worth blocking an
--    account deletion over.
CREATE TABLE project_cards (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    column_id   UUID NOT NULL REFERENCES project_columns(id) ON DELETE CASCADE,
    title       TEXT NOT NULL,
    description TEXT,
    assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
    due_date    DATE,
    position    INTEGER NOT NULL DEFAULT 0,
    created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_cards_column_idx ON project_cards (column_id, position);
CREATE INDEX project_cards_assignee_idx ON project_cards (assignee_id);
