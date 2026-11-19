-- The room's notes in every UI language (FEEDBACK-5 §5, follow-up): the
-- measurement notes shown in the plan's tooltips, what to re-measure, what
-- is not modelled, conflicts, and object notes. The seed now writes them as
-- {"en", "ru", "uz"} objects (backend/src/dc/seed.rs, SEED_TEXT); this gives
-- rooms seeded before the same texts. A note anyone typed stays as typed.

CREATE OR REPLACE FUNCTION pg_temp.seed_text(en TEXT) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
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
                'Jamoa qarori: har bir stoyka 600 × 1000 × 2040. Yunitlar: floor((2040 − 160) / 44,45) = 42, U1 poldan 100 mm balandda boshlanadi (taxmin: poydevor + yuqori qopqoq jami 160 mm).'),
               ('100 cm on the drawing for every rack',
                '100 см на чертеже у каждой стойки',
                'chizmada har bir stoyka uchun 100 sm'),
               ('tape 1495-1500; with 600 mm racks and the measured gaps the remainder is 1510',
                'рулетка 1495–1500; при стойках 600 мм и измеренных зазорах остаток 1510',
                'ruletka 1495–1500; 600 mm stoykalar va o''lchangan oraliqlar bilan qoldiq 1510'),
               ('Racks are placed by the measured aisle from the shelf. The back gap then follows from room width 3845 (a 3840-3850 range): model vs tape differ by -15, +30, 0, -5 mm (r1..r4). Show both values; do not hide the difference. r2 (+30 mm) is worth re-measuring.',
                'Стойки поставлены по измеренному проходу от стеллажа. Зазор сзади тогда следует из ширины комнаты 3845 (диапазон 3840–3850): модель и рулетка расходятся на −15, +30, 0, −5 мм (стойки 1–4). Показываются оба значения; разница не скрывается. Стойку 2 (+30 мм) стоит перемерить.',
                'Stoykalar stellajdan o''lchangan o''tish joyi bo''yicha qo''yilgan. Orqadagi oraliq xona kengligi 3845 dan (3840–3850 oralig''i) kelib chiqadi: model va ruletka −15, +30, 0, −5 mm farq qiladi (1–4-stoykalar). Ikkala qiymat ko''rsatiladi; farq yashirilmaydi. 2-stoykani (+30 mm) qayta o''lchash kerak.'),
               ('left gap read as 200-300; 200 used',
                'зазор слева прочитан как 200–300; взято 200',
                'chapdagi oraliq 200–300 deb o''qilgan; 200 olingan'),
               ('drawn against the wall on the hand drawing; depth 910 is measured from the wall',
                'на эскизе нарисован вплотную к стене; глубина 910 измерена от стены',
                'qo''lda chizilgan rejada devorga taqab chizilgan; 910 chuqurlik devordan o''lchangan'),
               ('equal spacing assumed',
                'принят равный шаг',
                'teng oraliq taxmin qilingan'),
               ('30 mm from the right wall',
                '30 мм от правой стены',
                'o''ng devordan 30 mm'),
               ('drawn along the whole wall',
                'нарисован вдоль всей стены',
                'butun devor bo''ylab chizilgan'),
               ('r2: gap from back to wall (model and tape differ by 30 mm)',
                'стойка 2: зазор от задней стороны до стены (модель и рулетка расходятся на 30 мм)',
                '2-stoyka: orqa tomondan devorgacha oraliq (model va ruletka 30 mm farq qiladi)'),
               ('gap from r4 to the right wall (1495-1500 vs 1510)',
                'зазор от стойки 4 до правой стены (1495–1500 против 1510)',
                '4-stoykadan o''ng devorgacha oraliq (1495–1500 va 1510)'),
               ('shelf: left gap (200 or 300), middle board height',
                'стеллаж: зазор слева (200 или 300), высота средней полки',
                'stellaj: chapdagi oraliq (200 yoki 300), o''rta polka balandligi'),
               ('cable tray: width and exact extent',
                'кабельный лоток: ширина и точная протяжённость',
                'kabel lotogi: kengligi va aniq uzunligi'),
               ('supply ducts over the aisle, UPS units, electrical box, wall controllers, chairs, lights: seen on photos, intentionally not modelled (team decision)',
                'подающие воздуховоды над проходом, ИБП, электрощит, настенные пульты, стулья, светильники: видны на фото, намеренно не моделируются (решение команды)',
                'o''tish joyi ustidagi havo kanallari, UPS bloklari, elektr shiti, devordagi pultlar, stullar, chiroqlar: fotolarda ko''rinadi, ataylab modellashtirilmagan (jamoa qarori)'),
               ('power chain: unknown',
                'цепь питания: неизвестна',
                'elektr ta''minoti zanjiri: noma''lum'),
               ('air conditioners: supply direction, flow (m3/h) and set point not recorded',
                'кондиционеры: направление подачи, расход (м³/ч) и уставка не записаны',
                'konditsionerlar: berish yo''nalishi, oqim (m³/soat) va o''rnatilgan harorat yozilmagan'),
               ('open frame (photos 03, 08)',
                'открытая рама (фото 03, 08)',
                'ochiq rama (foto 03, 08)'),
               ('ducted unit on threaded rods under the ceiling (photos 02, 06); ducts not modelled',
                'канальный блок на шпильках под потолком (фото 02, 06); воздуховоды не моделируются',
                'shift ostida rezbali shpilkalardagi kanalli blok (foto 02, 06); havo kanallari modellashtirilmagan'),
               ('inward, leaf swings toward the shelf wall',
                'внутрь, полотно открывается к стене со стеллажом',
                'ichkariga, tabaqa stellaj turgan devor tomon ochiladi'),
               ('along the wall behind the racks only (rear aisle); there is NO tray along the left wall',
                'только вдоль стены за стойками (задний проход); вдоль левой стены лотка НЕТ',
                'faqat stoykalar orqasidagi devor bo''ylab (orqa o''tish joyi); chap devor bo''ylab lotok YO''Q')
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

-- A JSON value: a seed text in every language, anything else unchanged.
CREATE OR REPLACE FUNCTION pg_temp.local(v JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT CASE WHEN jsonb_typeof(v) = 'string' AND v #>> '{}' <> ''
                THEN pg_temp.seed_text(v #>> '{}')
                ELSE v END
$$;

-- An array of texts.
CREATE OR REPLACE FUNCTION pg_temp.local_all(a JSONB) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
    SELECT COALESCE(jsonb_agg(pg_temp.local(e.value) ORDER BY e.ord), '[]')
      FROM jsonb_array_elements(COALESCE(a, '[]')) WITH ORDINALITY AS e(value, ord)
$$;

-- The room's measurements: notes of the entries and the three lists.
UPDATE dc_rooms r
   SET measurements = r.measurements || jsonb_build_object(
           'entries', (
               SELECT COALESCE(jsonb_agg(
                          CASE WHEN e.value ? 'note'
                               THEN e.value || jsonb_build_object('note', pg_temp.local(e.value->'note'))
                               ELSE e.value END
                          ORDER BY e.ord), '[]')
                 FROM jsonb_array_elements(r.measurements->'entries') WITH ORDINALITY AS e(value, ord)),
           'remeasure', pg_temp.local_all(r.measurements->'remeasure'),
           'not_modelled', pg_temp.local_all(r.measurements->'not_modelled'),
           'conflicts', pg_temp.local_all(r.measurements->'conflicts'));

-- Object notes become JSON: a plain string as typed, or the seed's
-- translations.
ALTER TABLE dc_objects ALTER COLUMN note DROP DEFAULT;
ALTER TABLE dc_objects ALTER COLUMN note TYPE JSONB USING to_jsonb(note);
ALTER TABLE dc_objects ALTER COLUMN note SET DEFAULT '""';
UPDATE dc_objects SET note = pg_temp.local(note) WHERE note <> '""';

-- The history keeps whole snapshots and diffs them field by field: the same
-- texts there, or every seeded object would show a changed note.
UPDATE dc_room_revisions v
   SET snapshot = jsonb_set(v.snapshot, '{objects}', (
       SELECT COALESCE(jsonb_agg(
                  CASE WHEN o.value ? 'note'
                       THEN o.value || jsonb_build_object('note', pg_temp.local(o.value->'note'))
                       ELSE o.value END
                  ORDER BY o.ord), '[]')
         FROM jsonb_array_elements(v.snapshot->'objects') WITH ORDINALITY AS o(value, ord)))
 WHERE jsonb_typeof(v.snapshot->'objects') = 'array';
