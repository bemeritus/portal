-- Categories no longer carry a description: a name and its slug are the whole
-- of a category now, so the column is dropped along with the UI that fed it.
ALTER TABLE categories DROP COLUMN IF EXISTS description;
