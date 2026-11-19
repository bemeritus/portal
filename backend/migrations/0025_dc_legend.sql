-- The plan legend collapsed to its button or open (FEEDBACK-5 §2), kept per
-- user with the module's other personal settings.
ALTER TABLE user_settings
    ADD COLUMN dc_legend_collapsed BOOLEAN NOT NULL DEFAULT false;
