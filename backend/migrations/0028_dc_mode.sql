-- The room view's last mode, per user (FEEDBACK-6 §1). NULL = the theme's
-- default: realistic in studio and light; drawing opens on the plan.
ALTER TABLE user_settings
    ADD COLUMN dc_mode TEXT CHECK (dc_mode IN ('schema', 'realistic', 'fill', 'power'));
