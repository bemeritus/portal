-- The owners mode (FEEDBACK-7 §4.7): devices coloured by owner. The room view
-- remembers it as the user's last mode like the other four.
ALTER TABLE user_settings DROP CONSTRAINT user_settings_dc_mode_check;
ALTER TABLE user_settings
    ADD CONSTRAINT user_settings_dc_mode_check
    CHECK (dc_mode IN ('schema', 'realistic', 'fill', 'power', 'owners'));
