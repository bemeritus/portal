-- Seed notes and rating conditions in every UI language (FEEDBACK-5 §5).
-- The seed now writes them as {"en", "ru", "uz"} objects
-- (backend/src/dc/seed.rs, SEED_TEXT); this gives catalog rows seeded before
-- the same texts. A note anyone typed (or one not from the seed) stays a
-- plain string; the UI shows a plain string as it is.

CREATE FUNCTION pg_temp.seed_text(en TEXT) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(
        (SELECT jsonb_build_object('en', t.en, 'ru', t.ru, 'uz', t.uz)
           FROM (VALUES
               ('manufacturer nominal',
                'номинал производителя',
                'ishlab chiqaruvchi nominali'),
               ('return air 37 °C, 24 % RH; outdoor 35 °C',
                'воздух на входе 37 °C, отн. влажность 24 %; снаружи 35 °C',
                'kiruvchi havo 37 °C, nisbiy namlik 24 %; tashqarida 35 °C'),
               ('converted from BTU/h',
                'пересчитано из BTU/ч',
                'BTU/soat dan qayta hisoblangan'),
               ('bottom board and the middle board''s height (equal spacing, 947.5 rounded) assumed; top board measured',
                'высота нижней и средней полки принята (равный шаг, 947,5 округлено); верхняя полка измерена',
                'pastki va o''rta polka balandligi taxmin qilingan (teng oraliq, 947,5 yaxlitlangan); yuqori polka o''lchangan'),
               ('body measured on site; length differs per unit (see the room''s measurements)',
                'корпус измерен на месте; длина у каждого блока своя (см. замеры комнаты)',
                'korpus joyida o''lchangan; uzunligi har bir blokda har xil (xona o''lchovlariga qarang)'),
               ('fixed by team decision: every rack is 600 × 1000 × 2040; measured widths are kept as tape values',
                'решение команды: каждая стойка 600 × 1000 × 2040; измеренная ширина сохранена как показания рулетки',
                'jamoa qarori: har bir stoyka 600 × 1000 × 2040; o''lchangan kengliklar ruletka qiymatlari sifatida saqlangan'),
               ('grey two-section metal locker next to the shelf at the door end (photos 02, 06); measured 506 x 400 x 1230',
                'серый двухсекционный металлический шкаф у стеллажа со стороны двери (фото 02, 06); измерено 506 × 400 × 1230',
                'eshik tomonda stellaj yonidagi kulrang ikki seksiyali metall shkaf (foto 02, 06); o''lchangan 506 × 400 × 1230'),
               ('height read as 1795–1800',
                'высота прочитана как 1795–1800',
                'balandlik 1795–1800 deb o''qilgan'),
               ('width and side height assumed from photos 04, 05',
                'ширина и высота боковины приняты по фото 04, 05',
                'kenglik va yon balandligi 04, 05 fotolar bo''yicha taxmin qilingan'),
               ('black metal (photo 02)',
                'чёрный металл (фото 02)',
                'qora metall (foto 02)'),
               ('black powder coat (photos 03, 08)',
                'чёрная порошковая окраска (фото 03, 08)',
                'qora kukunli bo''yoq (foto 03, 08)'),
               ('galvanised casing (photos 02, 06)',
                'оцинкованный корпус (фото 02, 06)',
                'ruxlangan korpus (foto 02, 06)'),
               ('the manufacturer''s product photos',
                'фотографии изделия у производителя',
                'ishlab chiqaruvchining mahsulot fotosuratlari'),
               ('top board 1-14, middle board 15-28 (plates on the boards), bottom board has no plates',
                'верхняя полка 1–14, средняя 15–28 (таблички на полках), на нижней табличек нет',
                'yuqori polka 1–14, o''rta polka 15–28 (polkalarda raqam lavhalari), pastki polkada lavha yo''q'),
               ('assumed from photos',
                'принято по фото',
                'fotolar bo''yicha taxmin qilingan'),
               ('indoor units hang on threaded rods under the ceiling above the shelf (photos 02, 06). Their supply ducts over the aisle are intentionally not modelled (team decision). Model and capacity unknown.',
                'внутренние блоки висят на шпильках под потолком над стеллажом (фото 02, 06). Их подающие воздуховоды над проходом намеренно не моделируются (решение команды). Модель и мощность неизвестны.',
                'ichki bloklar stellaj ustida shiftga rezbali shpilkalarda osilgan (foto 02, 06). Ularning o''tish joyi ustidagi havo kanallari ataylab modellashtirilmagan (jamoa qarori). Modeli va quvvati noma''lum.'),
               ('plinth and top cap of 160 mm in total assumed',
                'цоколь и верхняя крышка — всего 160 мм, принято',
                'poydevor va yuqori qopqoq jami 160 mm deb taxmin qilingan'),
               ('Fixed by decision of the team: every rack is 600 x 1000 x 2040. Units: floor(((2040 - 160) / 44.45)) = 42, U1 starts 100 mm above the floor (assumed plinth + top cap of 160 mm in total).',
                'Решение команды: каждая стойка 600 × 1000 × 2040. Юниты: floor((2040 − 160) / 44,45) = 42, U1 начинается в 100 мм от пола (принято: цоколь + верхняя крышка всего 160 мм).',
                'Jamoa qarori: har bir stoyka 600 × 1000 × 2040. Yunitlar: floor((2040 − 160) / 44,45) = 42, U1 poldan 100 mm balandda boshlanadi (taxmin: poydevor + yuqori qopqoq jami 160 mm).')
           ) AS t(en, ru, uz)
          WHERE t.en = seed_text.en),
        -- Notes with numbers in them.
        (SELECT jsonb_build_object(
                    'en', seed_text.en,
                    'ru', format('условия рейтинга Daikin UK: полная %s Вт, явная %s Вт', m[1], m[2]),
                    'uz', format('Daikin UK reyting sharoitlari: umumiy %s Vt, ochiq %s Vt', m[1], m[2]))
           FROM regexp_match(seed_text.en, '^Daikin UK rating conditions: total (\d+) W, sensible (\d+) W$') AS m
          WHERE m IS NOT NULL),
        (SELECT jsonb_build_object(
                    'en', seed_text.en,
                    'ru', format('вычислено (%s Вт / EER %s)', m[1], replace(m[2], '.', ',')),
                    'uz', format('hisoblangan (%s Vt / EER %s)', m[1], replace(m[2], '.', ',')))
           FROM regexp_match(seed_text.en, '^derived \((\d+) W / EER ([\d.]+)\)$') AS m
          WHERE m IS NOT NULL),
        (SELECT jsonb_build_object(
                    'en', seed_text.en,
                    'ru', format('пересчитано из %s CFM', m[1]),
                    'uz', format('%s CFM dan qayta hisoblangan', m[1]))
           FROM regexp_match(seed_text.en, '^(\d+) CFM converted$') AS m
          WHERE m IS NOT NULL),
        to_jsonb(en))
$$;

-- Notes on where each property came from.
UPDATE dc_catalog_items c
   SET props_src = (
       SELECT jsonb_object_agg(
                  e.key,
                  CASE WHEN jsonb_typeof(e.value->'note') = 'string'
                       THEN e.value || jsonb_build_object('note', pg_temp.seed_text(e.value->>'note'))
                       ELSE e.value END)
         FROM jsonb_each(c.props_src) AS e)
 WHERE c.props_src <> '{}';

-- The conditions a cooling unit is rated at.
UPDATE dc_catalog_items
   SET props = jsonb_set(props, '{rating_conditions}', pg_temp.seed_text(props->>'rating_conditions'))
 WHERE kind = 'cooling'
   AND jsonb_typeof(props->'rating_conditions') = 'string';
