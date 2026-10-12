-- Remove the access-control model entirely.
--
-- There are no more per-category grants and no section doors: any authenticated
-- user may read and manage every document, and `users.is_admin` alone gates the
-- admin-only screens. Both grant tables are dropped.
DROP TABLE IF EXISTS user_category_permissions CASCADE;
DROP TABLE IF EXISTS user_sections CASCADE;
