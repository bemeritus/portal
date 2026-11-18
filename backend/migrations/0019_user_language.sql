-- The UI language is a property of the user, not of the browser: it follows
-- them between machines, and server-side exports (DXF labels, CSV headers) are
-- written in it. Russian, Uzbek (Latin script) and English.
--
-- The browser still keeps a copy in localStorage, but only as a hint for the
-- first paint before /api/auth/me answers.
ALTER TABLE users
    ADD COLUMN language TEXT NOT NULL DEFAULT 'ru'
        CHECK (language IN ('ru', 'uz', 'en'));
