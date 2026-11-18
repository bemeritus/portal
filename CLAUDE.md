# CLAUDE.md

Conventions for working in this repository. `README.md` holds the platform's
own conventions (auth extractors, error shape, migrations, audit, `just ci`);
they apply too.

## Language

- Everything is written in English: commit messages, PR titles and
  descriptions, code comments, docs.
- Refer to UI modes and themes by their ids, not by their Russian labels:
  themes `studio` / `drawing` / `light`; modes `schema` / `realistic` /
  `fill` / `power`.
- Russian and Uzbek appear only inside the i18n locale files
  (`frontend/src/i18n/locales/`) and in tests that check UI text.
