-- Personal settings of the server room module (SPEC §10.1, §3.2): the theme
-- and the display unit for lengths. A separate table, so `users` is not
-- altered; a missing row means the defaults (theme from the app's light/dark
-- preference, unit cm). Storage and the API stay in integer millimetres.
CREATE TABLE user_settings (
    user_id  UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    -- NULL = follow the app's light/dark preference
    dc_theme TEXT CHECK (dc_theme IN ('studio', 'drawing', 'light')),
    dc_unit  TEXT NOT NULL DEFAULT 'cm' CHECK (dc_unit IN ('mm', 'cm', 'm'))
);
