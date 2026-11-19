-- Body finishes of catalog items (FEEDBACK-4 §2): the 3D templates take the
-- colour and the surface from the item (`props.finish`), not from its subtype.
-- New installs get them from the seed (backend/seeds/dc/cooling.json and the
-- room's rack, shelf and air conditioner); this fills them in where the seed
-- ran before they existed. Items that already have a finish are left alone.

-- Datasheet items: the values of backend/seeds/dc/cooling.json, by model.
UPDATE dc_catalog_items c
   SET props = c.props || jsonb_build_object(
           'finish', jsonb_build_object('color', v.color, 'kind', v.kind)),
       props_src = c.props_src || jsonb_build_object(
           'finish', jsonb_strip_nulls(jsonb_build_object(
               'src', 'photo',
               'url', c.props->>'source_url',
               'note', 'the manufacturer''s product photos')))
  FROM (VALUES
    ('Midea', 'MSAFB-12HRDN1-QC0 (Jungle Inverter)', '#f3f4f5', 'white_plastic'),
    ('Midea', 'MSAF-24CRDN1 (Forest Inverter)', '#f3f4f5', 'white_plastic'),
    ('Midea', 'MTIU-12HWFNX-QRD0W(GA) (A6 Duct)', '#c3c7cb', 'galvanised'),
    ('Midea', 'MTIU-18HWFNX-QRD0W(GA) (A6 Duct)', '#c3c7cb', 'galvanised'),
    ('Midea', 'MTI-24HWFNX-QRD0W(GA) (A6 Duct)', '#c3c7cb', 'galvanised'),
    ('Gree', 'GWH12AEC-K6DNA1A (G-Tech)', '#f3f4f5', 'white_plastic'),
    ('Gree', 'GWH24YE-K6DNA1A (Amber)', '#f3f4f5', 'white_plastic'),
    ('Gree', 'GFH24K (duct, outdoor GUHD24N)', '#c3c7cb', 'galvanised'),
    ('Gree', 'GFH36K (duct, outdoor GUHD36N)', '#c3c7cb', 'galvanised'),
    ('Gree', 'GFH48K (duct, outdoor GUHD48N)', '#c3c7cb', 'galvanised'),
    ('Daikin', 'FTXM35R + RXM35R', '#f3f4f5', 'white_plastic'),
    ('Daikin', 'FTXM50R + RXM50R', '#f3f4f5', 'white_plastic'),
    ('Daikin', 'FTXM60R + RXM60R', '#f3f4f5', 'white_plastic'),
    ('Daikin', 'FDXM35F9 (slim duct)', '#c3c7cb', 'galvanised'),
    ('Daikin', 'FDXM50F9 (slim duct)', '#c3c7cb', 'galvanised'),
    ('Daikin', 'FDXM60F9 (slim duct)', '#c3c7cb', 'galvanised'),
    ('Vertiv', 'Liebert CRV CRD10 (DX, air-cooled)', '#16171a', 'powder'),
    ('Vertiv', 'Liebert CRV CRD25 (DX, air-cooled)', '#16171a', 'powder'),
    ('Vertiv', 'Liebert CRV CRD35 (DX, air-cooled)', '#16171a', 'powder'),
    ('Vertiv', 'Liebert PDX PX011 (DX, perimeter)', '#16171a', 'powder')
  ) AS v(manufacturer, model, color, kind)
 WHERE c.kind = 'cooling'
   AND c.manufacturer = v.manufacturer
   AND c.model = v.model
   AND NOT c.props ? 'finish';

-- The room's own racks and shelf: black powder coat, as on the photos.
UPDATE dc_catalog_items
   SET props = props || '{"finish": {"color": "#16171a", "kind": "powder"}}',
       props_src = props_src || jsonb_build_object('finish', jsonb_build_object(
           'src', 'photo',
           'note', CASE kind WHEN 'rack' THEN 'black powder coat (photos 03, 08)'
                             ELSE 'black metal (photo 02)' END))
 WHERE kind IN ('rack', 'shelf')
   AND manufacturer = ''
   AND NOT props ? 'finish';

-- The room's air conditioners of unknown model: galvanised ducted casings.
UPDATE dc_catalog_items
   SET props = props || '{"finish": {"color": "#c3c7cb", "kind": "galvanised"}}',
       props_src = props_src || '{"finish": {"src": "photo", "note": "galvanised casing (photos 02, 06)"}}'
 WHERE kind = 'cooling'
   AND props->>'model_known' = 'false'
   AND props->>'subtype' = 'ducted'
   AND NOT props ? 'finish';
