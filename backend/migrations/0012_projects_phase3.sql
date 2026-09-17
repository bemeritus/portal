-- Projects, phase 3: checklists, attachments, and per-column WIP limits.
--
-- Still all additive to the board. A card grows two child lists — a checklist of
-- subtasks and a set of attached images; a column gains an optional work-in-
-- progress cap. The calendar view needs no schema — it is a query over the due
-- dates already on cards.

-- 1. WIP limit: the most a column should hold at once. NULL means "no cap", the
--    default, so existing columns are unaffected. It is advisory — the board
--    shows a column over its cap in red rather than refusing the drop, which is
--    how a WIP limit is meant to prompt a conversation, not block work.
ALTER TABLE project_columns
    ADD COLUMN wip_limit INTEGER CHECK (wip_limit IS NULL OR wip_limit >= 0);

-- 2. Checklist items — subtasks under a card, ordered like everything else here.
--    A card's progress is just the count of `done` over the total.
CREATE TABLE project_card_checklist_items (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id  UUID NOT NULL REFERENCES project_cards(id) ON DELETE CASCADE,
    text     TEXT NOT NULL,
    done     BOOLEAN NOT NULL DEFAULT FALSE,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX project_card_checklist_card_idx ON project_card_checklist_items (card_id, position);

-- 3. Attachments — images uploaded through the shared /api/upload endpoint and
--    then pinned to a card. `url` is the path that endpoint returned; `name` is
--    the original filename, for display. The uploader is kept (SET NULL on their
--    deletion) but does not gate who may remove the attachment.
CREATE TABLE project_card_attachments (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id     UUID NOT NULL REFERENCES project_cards(id) ON DELETE CASCADE,
    url         TEXT NOT NULL,
    name        TEXT NOT NULL,
    uploaded_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_card_attachments_card_idx ON project_card_attachments (card_id, created_at);
