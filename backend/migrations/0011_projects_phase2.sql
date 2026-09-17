-- Projects, phase 2: priority, labels, and comments on cards.
--
-- All additive to the phase-1 board. Priority is a column on the card; labels
-- are a board-scoped vocabulary a card can carry several of; comments are a
-- per-card thread. Filtering and the "my cards" view need no schema of their
-- own — they are queries over what is already here.

-- 1. Priority — a fixed four-step scale, defaulting to the middle so every
--    existing card keeps a sensible value without a backfill.
ALTER TABLE project_cards
    ADD COLUMN priority TEXT NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'urgent'));

-- 2. Labels live on a board: the same "Bug" / "Frontend" set is shared by every
--    card on it, and vanishes with the board. `color` is a token from a fixed
--    palette, not a raw hex string, so the UI paints from a known set and a
--    crafted value cannot inject arbitrary CSS.
CREATE TABLE project_labels (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    board_id UUID NOT NULL REFERENCES project_boards(id) ON DELETE CASCADE,
    name     TEXT NOT NULL,
    color    TEXT NOT NULL DEFAULT 'gray'
             CHECK (color IN ('gray', 'red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink')),
    UNIQUE (board_id, name)
);
CREATE INDEX project_labels_board_idx ON project_labels (board_id);

-- 3. Which labels a card carries. Both sides cascade: a deleted card drops its
--    tags, a deleted label drops off every card.
CREATE TABLE project_card_labels (
    card_id  UUID NOT NULL REFERENCES project_cards(id) ON DELETE CASCADE,
    label_id UUID NOT NULL REFERENCES project_labels(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, label_id)
);
CREATE INDEX project_card_labels_label_idx ON project_card_labels (label_id);

-- 4. A comment thread on a card. The author is kept as an id (SET NULL when the
--    user is deleted, like everywhere else in this world) so the thread survives
--    a departed teammate; the body is authored markdown, rendered server-side.
CREATE TABLE project_card_comments (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    card_id    UUID NOT NULL REFERENCES project_cards(id) ON DELETE CASCADE,
    author_id  UUID REFERENCES users(id) ON DELETE SET NULL,
    body       TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX project_card_comments_card_idx ON project_card_comments (card_id, created_at);
