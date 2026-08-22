-- The `learning` section: an independent world of resources, tests and labs.
--
-- Nothing here references `categories` or `documents`: learning is its own
-- structure, joined to the rest only by the user who holds both section doors.
-- Content carries an `author_id` (who wrote it); per-user state — test attempts
-- and lab progress — carries a `user_id` (who did it). The two never mix, which
-- is the "solver vs author" split written into the schema.
--
-- Who may do what is decided outside these tables: entering the section reads
-- content and records attempts/progress; the `can_author` bit on
-- `user_sections` (or being an admin) creates content; and results are read by
-- their own user, or by an admin. Authoring is section-wide, not per-row
-- ownership — the counterpart to templates' per-category (not per-author)
-- grants.

-- Resources: study material, body authored in markdown and rendered server-side
-- exactly like a document's answer.
CREATE TABLE learning_resources (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title      TEXT NOT NULL,
    body       TEXT NOT NULL,
    author_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX learning_resources_status_idx ON learning_resources (status, created_at DESC);

-- Tests: a quiz of single-choice questions.
CREATE TABLE learning_tests (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title       TEXT NOT NULL,
    description TEXT,
    author_id   UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    -- Correct answers needed to pass. NULL means the test only reports a score,
    -- with no pass/fail verdict.
    pass_score  INTEGER CHECK (pass_score IS NULL OR pass_score >= 0),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE learning_test_questions (
    id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id  UUID NOT NULL REFERENCES learning_tests(id) ON DELETE CASCADE,
    prompt   TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX learning_test_questions_test_idx ON learning_test_questions (test_id, position);

CREATE TABLE learning_test_options (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    question_id UUID NOT NULL REFERENCES learning_test_questions(id) ON DELETE CASCADE,
    label       TEXT NOT NULL,
    -- Never sent to a test-taker: the take view omits it and scoring happens on
    -- the server, so the correct answer stays out of reach of the browser.
    is_correct  BOOLEAN NOT NULL DEFAULT FALSE,
    position    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX learning_test_options_question_idx ON learning_test_options (question_id, position);

-- One submission of a test by one user. Kept per attempt rather than as a single
-- latest-score row so a retake does not erase the earlier result.
CREATE TABLE learning_test_attempts (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    test_id      UUID NOT NULL REFERENCES learning_tests(id) ON DELETE CASCADE,
    user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    score        INTEGER NOT NULL,
    max_score    INTEGER NOT NULL,
    -- NULL when the test has no `pass_score`.
    passed       BOOLEAN,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX learning_test_attempts_user_idx ON learning_test_attempts (user_id, test_id);
CREATE INDEX learning_test_attempts_test_idx ON learning_test_attempts (test_id);

-- The chosen option per question, kept so an attempt can be reviewed later.
-- `option_id` is nullable: a question left blank still belongs in the record.
CREATE TABLE learning_test_attempt_answers (
    attempt_id  UUID NOT NULL REFERENCES learning_test_attempts(id) ON DELETE CASCADE,
    question_id UUID NOT NULL REFERENCES learning_test_questions(id) ON DELETE CASCADE,
    option_id   UUID REFERENCES learning_test_options(id) ON DELETE SET NULL,
    PRIMARY KEY (attempt_id, question_id)
);

-- Labs: a practical task, its brief authored in markdown.
CREATE TABLE learning_labs (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title      TEXT NOT NULL,
    brief      TEXT NOT NULL,
    author_id  UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status     TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One user's progress on one lab. A single row per (lab, user): unlike a test,
-- a lab is a piece of work someone carries forward, not a repeatable attempt.
CREATE TABLE learning_lab_progress (
    lab_id      UUID NOT NULL REFERENCES learning_labs(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    state       TEXT NOT NULL DEFAULT 'not_started'
                CHECK (state IN ('not_started', 'in_progress', 'submitted', 'reviewed')),
    submission  TEXT,
    grade       INTEGER,
    reviewed_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (lab_id, user_id)
);
CREATE INDEX learning_lab_progress_lab_idx ON learning_lab_progress (lab_id);
