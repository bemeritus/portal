-- Documents no longer carry 👍/👎 feedback or tags.
--
-- The feedback tally and the tag vocabulary (with its document join table) are
-- both retired: the document view drops the thumbs, the editor drops the tag
-- field, and the analytics page keeps only its view-based ranking. Dropping the
-- tables here is what makes that permanent.
DROP TABLE IF EXISTS document_feedback CASCADE;
DROP TABLE IF EXISTS document_tags CASCADE;
DROP TABLE IF EXISTS tags CASCADE;
