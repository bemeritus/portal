-- The DC rules the database enforces on its own, with the API bypassed.
-- Run by `just test-db` against a freshly migrated scratch database. The script
-- makes its own fixtures — a room, a 42U rack type, two racks, a safe and a
-- 14 × 3 shelf — in one transaction that is rolled back; any assertion that
-- fails raises and stops the script.
\set ON_ERROR_STOP 1
BEGIN;

INSERT INTO dc_rooms (name, floor_plan, height_mm, measurements, settings)
    VALUES ('test', '[[0,0],[5000,0],[5000,4000],[0,4000]]', 2400, '{}', '{}');
INSERT INTO dc_catalog_items (kind, model, width_mm, depth_mm, height_mm, props) VALUES
    ('rack', 'rack 42U', 600, 1000, 2040, '{"units": 42, "u1_height_mm": 100}'),
    ('structure', 'safe', 500, 400, 1200, '{"subtype": "safe"}'),
    ('shelf', 'shelf', 4500, 900, 1800,
     '{"boards_mm": [100, 948, 1795], "cells_per_board": 14, "sections": [14], "plated_boards": 2}');
INSERT INTO dc_objects (room_id, catalog_id, name, x0_mm, z0_mm, contents_known)
    SELECT r.id, c.id, o.name, o.x0, 0, o.known
      FROM dc_rooms r,
           (VALUES ('Стойка 1', 'rack 42U', 0, true), ('Стойка 2', 'rack 42U', 700, true),
                   ('Сейф', 'safe', 1400, false), ('Стелаж colocation (Tower)', 'shelf', 0, false))
               AS o(name, model, x0, known)
      JOIN dc_catalog_items c ON c.model = o.model
     WHERE r.name = 'test';

CREATE TEMP VIEW r AS
    SELECT (SELECT id FROM dc_objects WHERE name = 'Стойка 1') AS r1,
           (SELECT id FROM dc_objects WHERE name = 'Стойка 2') AS r2,
           (SELECT id FROM dc_objects WHERE name = 'Сейф') AS safe,
           (SELECT id FROM dc_objects WHERE name = 'Стелаж colocation (Tower)') AS shelf;

INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
    SELECT r1, 10, 2, 'front', 'server', 'A (U10-11 front)' FROM r;

DO $$
DECLARE r1 BIGINT; r2 BIGINT; safe BIGINT; shelf BIGINT;
BEGIN
    SELECT r.r1, r.r2, r.safe, r.shelf INTO r1, r2, safe, shelf FROM r;

    -- Same face, sharing U11.
    BEGIN
        INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
            VALUES (r1, 11, 1, 'front', 'switch', 'overlap');
        RAISE EXCEPTION 'FAIL: an overlapping front device was accepted';
    EXCEPTION WHEN exclusion_violation THEN NULL;
    END;

    -- A full-depth device conflicts with the front one.
    BEGIN
        INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
            VALUES (r1, 9, 2, 'both', 'server', 'overlap both');
        RAISE EXCEPTION 'FAIL: a both-faces device over a front one was accepted';
    EXCEPTION WHEN exclusion_violation THEN NULL;
    END;

    -- Moving a device into another's units is refused just the same.
    INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
        VALUES (r1, 20, 1, 'front', 'patch', 'mover');
    BEGIN
        UPDATE dc_devices SET u_bottom = 11 WHERE name = 'mover';
        RAISE EXCEPTION 'FAIL: moving a device onto another was accepted';
    EXCEPTION WHEN exclusion_violation THEN NULL;
    END;

    -- Units past the top of a 42U rack.
    BEGIN
        INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
            VALUES (r1, 42, 2, 'front', 'server', 'too tall');
        RAISE EXCEPTION 'FAIL: a device past U42 was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- A device in something that is not a rack.
    BEGIN
        INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
            VALUES (safe, 1, 1, 'front', 'server', 'in the safe');
        RAISE EXCEPTION 'FAIL: a device in a safe was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- Unknown power is NULL; a source without a value is refused.
    BEGIN
        INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name, power_src)
            VALUES (r1, 30, 1, 'front', 'server', 'no value', 'measured');
        RAISE EXCEPTION 'FAIL: a power source without power was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- A shelf cell past the shelf's 42.
    BEGIN
        INSERT INTO dc_shelf_cells (shelf_id, cell_no, name) VALUES (shelf, 43, 'x');
        RAISE EXCEPTION 'FAIL: cell 43 was accepted';
    EXCEPTION WHEN check_violation THEN NULL;
    END;

    -- A rack with devices cannot be deleted from under them.
    BEGIN
        DELETE FROM dc_objects WHERE id = r1;
        RAISE EXCEPTION 'FAIL: a rack with devices was deleted';
    EXCEPTION WHEN foreign_key_violation THEN NULL;
    END;
END $$;

-- What must still work: the rear face of the same units, and a neighbour.
INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
    SELECT r1, 10, 2, 'rear', 'patch', 'rear of U10-11' FROM r;
INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
    SELECT r1, 12, 1, 'both', 'server', 'U12 full depth' FROM r;
INSERT INTO dc_devices (rack_id, u_bottom, u_height, face, kind, name)
    SELECT r2, 10, 2, 'front', 'server', 'same units, other rack' FROM r;

\echo dc_constraints: all checks passed
ROLLBACK;
