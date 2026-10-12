-- Remove the learning and projects sections entirely.
--
-- Both were independent worlds (their own tables, API and UI) layered above the
-- original templates section. They are being retired, so everything they owned
-- goes: the tables, the per-user section rows, and the CHECKs that named them.
-- `templates` is the only section left — a one-value set, but the two-level
-- door/grant model it belongs to is unchanged.

-- 1. Drop the user_sections rows for the retired sections, and tighten both
--    CHECKs back to templates-only. The author bit never applied to templates,
--    so its CHECK collapses to "never set".
DELETE FROM user_sections WHERE section IN ('learning', 'projects');

ALTER TABLE user_sections DROP CONSTRAINT user_sections_section_check;
ALTER TABLE user_sections ADD CONSTRAINT user_sections_section_check
    CHECK (section IN ('templates'));

ALTER TABLE user_sections DROP CONSTRAINT user_sections_check;
ALTER TABLE user_sections ADD CONSTRAINT user_sections_check
    CHECK (NOT can_author);

-- 2. Drop the content tables. CASCADE clears the join/child tables and any
--    foreign keys between them regardless of order.
DROP TABLE IF EXISTS learning_test_attempt_answers CASCADE;
DROP TABLE IF EXISTS learning_test_attempts CASCADE;
DROP TABLE IF EXISTS learning_test_options CASCADE;
DROP TABLE IF EXISTS learning_test_questions CASCADE;
DROP TABLE IF EXISTS learning_tests CASCADE;
DROP TABLE IF EXISTS learning_lab_progress CASCADE;
DROP TABLE IF EXISTS learning_labs CASCADE;
DROP TABLE IF EXISTS learning_resources CASCADE;

DROP TABLE IF EXISTS project_card_comments CASCADE;
DROP TABLE IF EXISTS project_card_labels CASCADE;
DROP TABLE IF EXISTS project_labels CASCADE;
DROP TABLE IF EXISTS project_card_attachments CASCADE;
DROP TABLE IF EXISTS project_card_checklist_items CASCADE;
DROP TABLE IF EXISTS project_cards CASCADE;
DROP TABLE IF EXISTS project_columns CASCADE;
DROP TABLE IF EXISTS project_boards CASCADE;
