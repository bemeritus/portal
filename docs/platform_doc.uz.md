# Texnik topshiriq (TT)
## Bilimlar bazasi / Texnik hujjatlar platformasi

*English: [platform_doc.md](./platform_doc.md)*

**Texnologiya:** Rust (Axum) backend + React (TypeScript) frontend
**Versiya:** 2.0 — JSON API va bir sahifali ilovaga ajratildi; §3, §7, §8 va
§10 yangi shakl uchun qayta yozildi. Domen modeli, ruxsat qoidasi va
ma'lumotlar bazasi sxemasi 1.2 dagidek qoldi.
**Sana:** 2026

> Ushbu hujjat platforma **nima qilishini** tasvirlaydi. Oldingi versiya kod
> hech qachon qabul qilmagan niyatni tasvirlagan joylarda, bo'lim buni ochiq
> aytadi — o'quvchi buni qorovul kodidan topib olishiga qoldirilmaydi. Ochiq
> masalalar §12 da va README ning *Ma'lum kamchiliklar* bo'limida to'plangan.

---

## 1. Loyiha haqida umumiy ma'lumot

Platforma — **ichki bilimlar bazasi**, unda ruxsat berilgan foydalanuvchilar
texnik hujjatlar (maqolalar) yaratadi va o'qiydi. Bu hujjatlar oddiy maqola
emas — ular **savol-javob** ko'rinishida tuzilgan. Har bir hujjat ketma-ket
savollardan va ularga mos javoblardan iborat.

Asosiy g'oyalar:
- **Ochiq ro'yxatdan o'tish yo'q.** Foydalanuvchini faqat **admin** yarata oladi.
- Har bir foydalanuvchining ruxsatlari (o'qish / yozish / tahrirlash / o'chirish)
  **kategoriya bo'yicha** beriladi — admin bo'lmagan foydalanuvchi aynan o'ziga
  berilgan kategoriyalarga yetadi.
- Hujjatlar **kategoriyalarga** ajratiladi.
- Hujjatlarni **sarlavha** va **kategoriya** bo'yicha filtrlash mumkin.
- Mazmun matn va rasmlar aralashmasidan iborat.

---

## 2. Maqsad va vazifalar

| Maqsad | Tavsif |
|------|-------------|
| Markazlashgan bilim | Texnik hujjatlarni bitta joyda saqlash |
| Nazorat ostidagi kirish | Faqat admin tasdiqlagan foydalanuvchilar kira oladi |
| Tuzilgan mazmun | Savol-javob shakli ma'lumotni oson kuzatishga imkon beradi |
| Tez topish | Sarlavha va kategoriya bo'yicha filtrlash |

---

## 3. Texnologiyalar to'plami

Platforma — **ikkita dastur**, birga versiyalanadi va bitta narsa sifatida
joylashtiriladi:

| | | |
|---|---|---|
| `backend/` | Rust | `/api` ostidagi JSON API; ishlab chiqarishda frontend uchun statik server ham |
| `frontend/` | TypeScript | bir sahifali ilova; brauzer faqat shu bilan gaplashadi |

Ular aynan bitta joyda uchrashadi — §7 dagi HTTP shartnomasi — va boshqa hech
qayerda. 1.x versiyasi yagona Leptos dasturi edi, unda bir xil Rust tiplari
ham server, ham brauzer uchun kompilyatsiya qilinardi; bu chegarani yashirin va
tekin qilardi. Endi u ochiq va narxi bor: `frontend/src/api/types.ts`
`backend/src/models.rs` ni **qo'lda** takrorlaydi va buni hech narsa
tekshirmaydi. Bu — ajratishning narxi, va uni ongli ravishda to'lash kerak:
bir tomonda o'zgargan struktura ikkinchi tomonga qarz bo'lib qoladi.

### Backend
- **Til:** Rust (stable, qurishlar uchun 1.96 ga qadalgan)
- **Veb-freymvork:** Axum 0.8
- **BD drayveri:** SQLx 0.8, **ish vaqtida tekshiriladigan** so'rovlar
  (`query`/`query_as`, kompilyatsiya vaqtidagi `query!` makroslari emas — shu
  sababli qurish paytida hech narsa bazaga tegmaydi, va aynan shu Docker
  tasvirini bazasiz qurish imkonini beradi)
- **Ma'lumotlar bazasi:** PostgreSQL 15
- **Migratsiyalar:** `sqlx-cli` (`sqlx migrate`); shuningdek ikkilik faylga
  joylashtirilgan va ishga tushishda qo'llanadi
- **Statik fayllar:** `tower-http` ning `ServeDir` i, `index.html` ga
  qaytadigan zaxira bilan — shunda chuqur havolalar mijoz routeriga tegishli
  bo'ladi

### Autentifikatsiya va xavfsizlik
- **Sessiyalar:** `tower-sessions` 0.14, xotiradagi ombor, `HttpOnly` cookie
- **Parol xeshlash:** `argon2` 0.5
- **Qorovullar:** Axum ekstraktorlari (`CurrentUser`, `AdminUser`) — ularni
  qabul qiladigan ishlovchi ularsiz ishga tusha olmaydi
- **CSRF himoyasi:** *amalga oshirilmagan.* API `SameSite=Lax` sessiya cookie
  siga va SPA bilan bir xil origin da bo'lishga tayanadi. Token — keyingi
  qadam bo'lardi.
- **Validatsiya:** har bir ishlovchida qo'lda (bo'sh bo'lmagan foydalanuvchi
  nomi, parol ≥ 6 belgi, holat normallashtiriladi, yuklama uchun MIME oq
  ro'yxati).

### Frontend
- **Freymvork:** React 19, **Vite 6** bilan quriladi
- **Til:** TypeScript, `strict`
- **Marshrutlash:** `react-router-dom` 7 (mijoz tomonda)
- **Server holati:** TanStack Query 5 — keshlash, so'rovni bekor qilish va
  logga kerak bo'lgan "keyingi sahifa yuklanayotganda eski qatorlarni saqlab
  turish" xatti-harakati
- **Uslub:** bitta qo'lda yozilgan uslublar fayli,
  `frontend/src/styles/main.css`, to'rtta mavzu (freymvorksiz)
- **Mazmunni tahrirlash:** textarea ichida Markdown; rasmlar joyida yuklanadi

### Fayllar (rasmlar)
- **Yuklash:** `POST /api/upload` dagi Axum multipart ishlovchisi
- **Saqlash:** mahalliy `uploads/` papkasi, `ServeDir` orqali va **sessiya
  ortida** beriladi

### Ular qanday ishlaydi

```
ishlab chiqish                        ishlab chiqarish
──────────────                        ────────────────
brauzer → Vite :5173                  brauzer → Axum :3000
            │  /api, /uploads                    ├── /api/*      JSON
            └─ :3000 ga proksi                   ├── /uploads/*  fayllar, sessiya ortida
                                                 └── /*          index.html + aktivlar
```

Ishlab chiqishda frontendni to'g'ridan-to'g'ri `:3000` ga qaratish o'rniga
proksi ishlatiladi, va bu qulaylik emas, xavfsizlik qarori: proksi orqali
sessiya cookie si ishlab chiqishda ham, ishlab chiqarishdagi kabi, bir xil
origin da bo'ladi. To'g'ridan-to'g'ri API ga qaratilsa, u cross-site bo'lardi,
`SameSite=Lax` uni tashlab yuborardi, va ilova tizimga kirib, darhol chiqib
ketgandek ko'rinardi. `CORS_ORIGINS` ham shu sababdan bor va ishlab chiqarishda
bo'sh — u yerda ruxsat beriladigan cross-origin narsaning o'zi qolmaydi.

---

## 4. Foydalanuvchi rollari va ruxsatlar tizimi

### 4.1. Rollar

| Rol | Tavsif |
|------|-------------|
| **Admin** | Foydalanuvchilarni va ularning ruxsatlarini yaratadi, o'chiradi, boshqaradi. Barcha huquqlarga ega. |
| **Foydalanuvchi** | Admin bergan ruxsatlar doirasida ishlaydi. |

### 4.2. Ruxsatlar

Quyidagi ruxsatlar har bir foydalanuvchi uchun **har bir kategoriyada** alohida
yoqiladi/o'chiriladi:

| Ruxsat | Imkoniyat |
|------------|-----------|
| `READ` | O'sha kategoriyadagi hujjatlarni ko'rish va filtrlash |
| `WRITE` | O'sha kategoriyada yangi hujjat (savol-javob) yaratish |
| `EDIT` | O'sha kategoriyadagi mavjud hujjatlarni tahrirlash |
| `DELETE` | O'sha kategoriyadagi hujjatlarni o'chirish |

> **Eslatma:** Ruxsatlar bir-biridan mustaqil. Foydalanuvchi bitta kategoriyada
> faqat `READ`, boshqasida `READ`+`WRITE` ushlab turishi mumkin. Yolg'iz `WRITE`
> foydalanuvchiga hujjat yaratishga imkon beradi, lekin keyin uni tahrirlay
> olmaydi: muallifllik — ruxsat emas (§4.2.1), shuning uchun o'zgartirish uchun
> o'sha kategoriyada `EDIT` ham kerak.

### 4.2.1. Qamrov: ruxsatlar — kategoriya grantlari

Admin bo'lmagan foydalanuvchi ushlab turgan har bir ruxsat — **bitta kategoriya
uchun grant**, u `user_category_permissions` (§6.6) dagi qator sifatida
saqlanadi. Ikkinchi qamrov yo'q:

```
ruxsat(foydalanuvchi, kategoriya, amal) =
      foydalanuvchi.is_admin                    // adminlar hamma joyda hamma narsani ushlaydi
   OR grant(foydalanuvchi, kategoriya, amal)    // shu kategoriyaga berilgan grant
```

Bu — `src/models.rs` dagi `User::has_in`, va `backend::require_in_category`
biror narsani avtorizatsiya qilishning yagona yo'li. O'sha qorovulning
kategoriyasiz varianti ataylab yo'q: kategoriyasiz ruxsat aynan shu — bitta
bayroqning foydalanuvchiga hech qachon berilmagan kategoriyalarga cho'zilishiga
yo'l qo'yadigan narsa.

Ushbu qoidaning oqibatlari:

- Foydalanuvchi o'ziga grant berilgan kategoriyalar bilan **chegaralangan**.
  Admin bo'lmagan hisobning yagona shakli shu; unga "platforma bo'ylab kirish"
  — bu barcha kategoriyalarni berish, yoki umuman bermaslik.
- Kategoriyaga granti bo'lmagan foydalanuvchi uni ko'ra olmaydi: uning
  hujjatlari ro'yxatlardan chiqarib tashlanadi va u kategoriya ro'yxatlarida
  ko'rinmaydi.
- Ruxsat tekshiruvlari doim **hujjat turgan kategoriyaga** nisbatan qilinadi.
  Shuning uchun hujjatni boshqa kategoriyaga ko'chirish manbada ham, borish
  joyida ham huquq talab qiladi (SR-8).
- **Muallifllik hech narsa bermaydi.** O'z hujjatini o'qish, tahrirlash va
  o'chirish — har biri hujjat hozir turgan kategoriya uchun grantni talab qiladi
  (§12, hal qilingan 1).

#### Eskirgan global ustunlar

`users.can_read` / `can_write` / `can_edit` / `can_delete` sxemada hamon mavjud
va hamon `User` struktura ichiga o'qiladi, lekin **birorta qorovul ularni
o'qimaydi**: `create_user` ularni `FALSE` holicha qoldiradi, admin oynasida
ular uchun katakcha yo'q, va `update_permissions` degan server funksiyasi ham
yo'q. Ularni faqat `seed_admin` o'rnatadi — u ham baribir `is_admin` bo'lgan
qatorda.

Demak ular harakatsiz. Yo ularni migratsiya bilan olib tashlash, yo
`User::has_in` ga `|| self.can_<perm>` qo'shib, qo'shiluvchi qoidani tiklash
kerak — ammo shulardan biri bo'lmaguncha, faqat sxemani o'qigan odam kim nima
qila olishi haqida noto'g'ri xulosa chiqaradi; ushbu paragraf shu sababli bor.

### 4.3. Autentifikatsiya oqimi

```
Admin  --->  Foydalanuvchi yaratadi (nom + dastlabki parol + admin bayrog'i
             + kategoriya bo'yicha ruxsatlar)
Foydalanuvchi --->  Tizimga kiradi (nom + parol)
Server --->  Sessiya cookie sini beradi
Har bir so'rov  --->  Sessiya + (tegishli kategoriya uchun) ruxsat
                      tekshiriladi (qorovul)
```

- **Ro'yxatdan o'tish yo'q.** `/register` marshruti umuman mavjud emas.
- Faqat `/login` bor.
- Parolni tiklashni ham admin bajaradi.
- `/login`, `/pkg/*` va server funksiyalari nuqtalaridan boshqa hamma narsaga
  qilingan anonim so'rovlarni Axum middleware i `/login` ga yo'naltiradi — biror
  belgi render qilinishidan oldin. Mijoz tomonidagi tekshiruv avval sahifani
  oqizib, keyin uni tuzatishga majbur bo'lardi; bu ham mazmunni oshkor qiladi,
  ham noto'g'ri sahifaning ko'rinib ketishiga olib keladi. `/api/upload`
  **ozod qilinmagan**: u o'z avtorizatsiyasiga ega bo'lmagan oddiy ishlovchi.

---

## 5. Funksional talablar

### 5.1. Autentifikatsiya
- FR-1: Foydalanuvchi nomi va parol bilan kiradi.
- FR-2: Noto'g'ri ma'lumotda aniq xato ko'rsatiladi (lekin "foydalanuvchi
  topilmadi" va "parol noto'g'ri" farqlanmaydi — xavfsizlik uchun).
- FR-3: Holat sessiya cookie si orqali saqlanadi; chiqish tugmasi mavjud.
- FR-4: Faol bo'lmagan foydalanuvchi (`is_active = false`) kira olmaydi.

### 5.2. Admin panel (foydalanuvchilarni boshqarish)
- FR-5: Admin yangi foydalanuvchi yaratadi: nom, parol, admin bayrog'i va
  kategoriya bo'yicha ruxsatlar.
- FR-6: ~~Admin foydalanuvchining global ruxsatlarini o'zgartiradi.~~ **v1.2 da
  bekor qilindi** — o'zgartiriladigan global ruxsatlar yo'q (§4.2.1). Huquqlar
  kategoriya matritsasi orqali o'zgartiriladi, FR-22.
- FR-7: Admin foydalanuvchini bloklaydi/faollashtiradi.
- FR-8: Admin foydalanuvchining parolini tiklaydi.
- FR-22: Admin kategoriya bo'yicha ruxsatlarni matritsa sifatida (kategoriya ×
  READ/WRITE/EDIT/DELETE) tayinlaydi — ham yaratishda, ham keyinroq. Saqlash
  foydalanuvchining grantlarini butunlay almashtiradi; hech nimasi belgilanmagan
  kategoriya umuman grantsiz saqlanadi.
- FR-23: Foydalanuvchilar ro'yxati har bir foydalanuvchi uchun uning rolini,
  grantlarini saqlaydigan yig'iladigan Kategoriyalar katagini, faollik holatini
  va parolni tiklashni ko'rsatadi.

### 5.3. Kategoriyalar
- FR-9: Admin kategoriya yaratadi/tahrirlaydi/o'chiradi.
- FR-10: Har bir hujjat aynan bitta kategoriyaga tegishli.
- FR-24: Kategoriyani o'chirish unga tegishli har bir grantni ham olib tashlaydi
  (`ON DELETE CASCADE`); ammo unga hujjatlar bog'liq ekan, o'chirish baribir
  muvaffaqiyatsiz tugaydi.

### 5.4. Hujjatlar (savol-javob shakli)
- FR-11: Tanlangan kategoriyada `WRITE` ga ega foydalanuvchi yangi hujjat
  yaratadi: sarlavha + kategoriya.
- FR-12: Hujjat bir nechta **savol-javob blokidan** iborat.
- FR-13: Javob matniga rasmlar joylashtirilishi mumkin.
- FR-14: Savol-javob bloklari tartiblangan (position bo'yicha).
- FR-15: Hujjatning joriy kategoriyasida `EDIT` ga ega foydalanuvchi hujjatni va
  uning bloklarini tahrirlay oladi. Hujjat kategoriyasini o'zgartirish borish
  joyidagi kategoriyada qo'shimcha ravishda `WRITE` yoki `EDIT` talab qiladi.
- FR-16: Hujjat holati: `draft` yoki `published`, muharrirda o'rnatiladi va
  hujjatda ko'rsatiladi. **U hech qanday kirish nazoratini ta'minlamaydi**:
  qoralama o'z kategoriyasini `READ` qila oladigan har kimga ko'rinadi. Aynan
  `"published"` bo'lmagan har qanday qiymat `"draft"` sifatida saqlanadi. Qarang:
  §12, hali ochiq.

### 5.5. Ko'rish va filtrlash
- FR-17: Hujjatlar ro'yxati ko'rsatiladi (sarlavha, kategoriya, muallif, sana),
  SQL da chaqiruvchi `READ` qila oladigan kategoriyalar bilan chegaralanadi
  (admin hammasini ko'radi). **Chaqiruvchining o'zi yozgan, ammo u o'qiy
  olmaydigan kategoriyadagi hujjatlari kiritilmaydi** — so'rov faqat kategoriya
  bo'yicha filtrlaydi. Qarang: §12, hali ochiq.
- FR-18: Sarlavha bo'yicha qidiruv/filtr (matn maydoni orqali).
- FR-19: **Kategoriya** bo'yicha filtr (ro'yxatdan tanlash). Ro'yxat faqat
  chaqiruvchi ko'ra oladigan kategoriyalarni taklif qiladi.
- FR-20: Ikkala filtr birga ishlay oladi.
- FR-21: Hujjat ochilganda barcha savol-javob bloklari ketma-ket ko'rsatiladi.
- FR-25: Muharrirning kategoriya tanlagichi faqat chaqiruvchi yoza yoki
  tahrirlay oladigan kategoriyalarni taklif qiladi.

### 5.6. O'zgarishlar tarixi (loglar)
- FR-26: Platformadagi har bir o'zgarish yoziladi: foydalanuvchi yaratildi,
  kategoriya bo'yicha ruxsatlar o'zgardi, foydalanuvchi bloklandi/faollashtirildi,
  parol tiklandi, kategoriya yaratildi/nomi o'zgardi/o'chirildi, hujjat
  yaratildi/tahrirlandi/o'chirildi, rasm yuklandi.
- FR-27: Har bir yozuv **kim** (foydalanuvchi nomi), **qachon** (vaqt belgisi),
  **qanday amal** (`<obyekt>.<harakat>`, masalan `document.update`), **nimaga**
  (nishonning o'sha paytdagi nomi) va **tafsilotlar** — qaysi maydonlar va
  nimadan nimaga o'zgarganini qayd etadi.
- FR-28: Log faqat administratorlarga ko'rinadi, `/admin/logs` da, eng yangisi
  birinchi bo'lib, erkin matnli qidiruv va tur bo'yicha filtr bilan
  (foydalanuvchilar / kategoriyalar / hujjatlar / yuklamalar).
- FR-29: Log faqat qo'shiladi. Platformada hech narsa yozuvni tahrirlamaydi yoki
  o'chirmaydi, va yozuv o'zi tasvirlagan qatordan uzoqroq yashaydi — hujjatni
  o'chirish o'chirilgani haqidagi yozuvni, jumladan uning sarlavhasini,
  qoldiradi.

---

## 6. Ma'lumotlar bazasi sxemasi

### 6.1. `users`
| Ustun | Tur | Izoh |
|--------|------|------|
| id | UUID (PK) | |
| username | TEXT (unikal) | |
| password_hash | TEXT | argon2 |
| is_admin | BOOLEAN | admin bayrog'i — kategoriyadan tashqariga chiqishning yagona sababi |
| can_read | BOOLEAN | **eskirgan, harakatsiz** — birorta qorovul o'qimaydi |
| can_write | BOOLEAN | **eskirgan, harakatsiz** |
| can_edit | BOOLEAN | **eskirgan, harakatsiz** |
| can_delete | BOOLEAN | **eskirgan, harakatsiz** |
| is_active | BOOLEAN | bloklangan/faol; faol bo'lmagan foydalanuvchi kira olmaydi va sessiya davomida ham yo'q deb qaraladi |
| created_at | TIMESTAMPTZ | |
| created_by | UUID (FK → users.id) | kim yaratgani |

> To'rtta `can_*` ustuni endi hech narsani avtorizatsiya qilmaydi — §4.2.1 ning
> oxiriga qarang. Admin bo'lmagan foydalanuvchining barcha huquqlari
> `user_category_permissions` (§6.6) dan keladi. Yangi foydalanuvchilar to'rtala
> ustun `FALSE` holida yaratiladi; ularni faqat `seed_admin` o'rnatadi.

### 6.2. `categories`
| Ustun | Tur | Izoh |
|--------|------|------|
| id | UUID (PK) | |
| name | TEXT (unikal) | |
| slug | TEXT (unikal) | URL lar uchun |
| description | TEXT | ixtiyoriy |
| created_at | TIMESTAMPTZ | |

### 6.3. `documents`
| Ustun | Tur | Izoh |
|--------|------|------|
| id | UUID (PK) | |
| title | TEXT | qidiruv/filtr uchun |
| category_id | UUID (FK → categories.id) | |
| author_id | UUID (FK → users.id) | |
| status | TEXT | 'draft' \| 'published' |
| created_at | TIMESTAMPTZ | |
| updated_at | TIMESTAMPTZ | |

Indekslar: `title` (`GIN`/trigram yoki oddiy `ILIKE` orqali qidiruv uchun),
`category_id`.

### 6.4. `qa_blocks` (hujjat ichidagi savol-javob)
| Ustun | Tur | Izoh |
|--------|------|------|
| id | UUID (PK) | |
| document_id | UUID (FK → documents.id, ON DELETE CASCADE) | |
| question | TEXT | savol |
| answer | TEXT | javob (markdown, rasm havolalari bilan) |
| position | INTEGER | tartib |
| created_at | TIMESTAMPTZ | |

### 6.5. `uploads` (rasmlar)
| Ustun | Tur | Izoh |
|--------|------|------|
| id | UUID (PK) | |
| file_path | TEXT | saqlangan yo'l/URL |
| original_name | TEXT | |
| uploaded_by | UUID (FK → users.id) | |
| uploaded_at | TIMESTAMPTZ | |

### 6.6. `user_category_permissions` (kategoriya grantlari)
| Ustun | Tur | Izoh |
|--------|------|------|
| user_id | UUID (FK → users.id, ON DELETE CASCADE) | PK 1-qism |
| category_id | UUID (FK → categories.id, ON DELETE CASCADE) | PK 2-qism |
| can_read | BOOLEAN | grant, standart `false` |
| can_write | BOOLEAN | grant, standart `false` |
| can_edit | BOOLEAN | grant, standart `false` |
| can_delete | BOOLEAN | grant, standart `false` |
| granted_by | UUID (FK → users.id, ON DELETE SET NULL) | qaysi admin tayinlagani |
| granted_at | TIMESTAMPTZ | |

Birlamchi kalit `(user_id, category_id)` — har bir juftlik uchun ko'pi bilan
bitta qator. To'rtala bayrog'i `false` bo'lgan qator grantsizlikka teng va
saqlanmaydi. Teskari izlash uchun ("bu kategoriyaga kim tegishi mumkin?")
`category_id` bo'yicha indeks.

### 6.7. Bog'lanishlar diagrammasi
```
users (1) ────< documents (N)
categories (1) ────< documents (N)
documents (1) ────< qa_blocks (N)
users (1) ────< uploads (N)

users (1) ────< user_category_permissions (N) >──── (1) categories

users (1) ────< audit_log (N)      # faqat aktor; nishon id + nom orqali, bog'lanishsiz
```

### 6.8. `audit_log` (o'zgarishlar tarixi)
| Ustun | Tur | Izoh |
|--------|------|------|
| id | UUID | PK |
| at | TIMESTAMPTZ | qachon, standart `now()` |
| actor_id | UUID (FK → users.id, ON DELETE SET NULL) | kim; nom o'zgargandan keyin guruhlash uchun |
| actor_name | TEXT | kim — o'sha paytdagi nomi bilan |
| action | TEXT | `<obyekt>.<harakat>`, masalan `category.delete` |
| target_type | TEXT | `user` \| `category` \| `document` \| `upload` |
| target_id | UUID, **FK yo'q** | amal qilingan qator, agar id si bo'lsa |
| target_name | TEXT | uning o'sha paytdagi nomi/sarlavhasi |
| details | TEXT, nullable | nima o'zgargani, bir qatorda; amalning o'zi hammasini aytsa `NULL` |

Ataylab denormallashtirilgan. `target_id` da **FK yo'q**, chunki yozuv o'z
obyektidan omon qolishi shart: FK bilan hujjatni o'chirish uning o'chirilgani
haqidagi yozuvni ham o'chirib yuborardi — ya'ni admin eng ko'p ehtiyoj
sezadigan yozuvni. Ikkala nom ustuni ham shu sababdan join emas, saqlangan
qiymat — hamda join foydalanuvchi yoki kategoriya keyinroq qayta nomlanganda
tarixni jimgina qayta yozib qo'yardi. Indekslar `at DESC`, `(target_type, at
DESC)` va `actor_id` bo'yicha — admin oynasi uni shu uch yo'l bilan o'qiydi.

---

## 7. HTTP API

Hammasi `/api` ostida JSON. 1.x versiyasi Leptos server funksiyalarini
ishlatardi — ular tarmoqdan o'tadigan Rust chaqiruvlari edi; bular esa oddiy
nuqtalar, shuning uchun natijani xato satri ichidagi prefiks emas, status kodi
tashiydi.

**Barcha xatoliklar bitta shaklda** — `{"error": "foydalanuvchiga
ko'rsatiladigan gap"}` — status esa qaysi turdaligini aytadi:

| Status | Ma'nosi |
|---|---|
| `400` | So'rovning o'zi noto'g'ri: bo'sh sarlavha, 6 belgidan qisqa parol, o'qib bo'lmaydigan multipart. |
| `401` | Sessiya yo'q, yoki u endi faol foydalanuvchiga olib bormaydi. |
| `403` | Autentifikatsiyadan o'tgan, lekin bu amal uchun ruxsati yo'q. |
| `404` | Bunday qator yo'q, yoki bunday nuqta yo'q. |
| `409` | Chaqiruvchi hal qila oladigan unikal yoki tashqi kalit cheklovi: band foydalanuvchi nomi, hujjatlari bor kategoriya. |
| `413` | `MAX_UPLOAD_BYTES` dan oshgan. |
| `500` | Bizniki. Sabab serverda logga yoziladi; chaqiruvchi bitta umumiy gap oladi va tizim ichki tuzilishi haqida hech narsa emas. |

### Auth
| | |
|---|---|
| `POST /api/auth/login` | `{username, password}` → `User`. Foydalanuvchini qaytaradi, shuning uchun mijozga ikkinchi so'rov kerak emas. Sessiya id sini almashtiradi (fixation). |
| `POST /api/auth/logout` | → `204` |
| `GET /api/auth/me` | → `User`, yoki `401`. SPA yuklanganda ilovani ko'rsatishni yoki kirish sahifasini ko'rsatishni shu orqali hal qiladi. |

### Kategoriyalar
| | |
|---|---|
| `GET /api/categories` | Chaqiruvchi **ko'ra oladigan** kategoriyalar: admin uchun hammasi, aks holda granti borlari. |
| `GET /api/categories/writable` | Ular `WRITE` yoki `EDIT` qila oladigan qismi — muharrirning tanlagichi shuni taklif qiladi (FR-25). |
| `POST /api/categories` | `{name, description}` → `Category`, `201`. Admin. |
| `PUT /api/categories/{id}` | `{name, description}` → `204`. Admin. |
| `DELETE /api/categories/{id}` | → `204`. Admin. Hujjatlari bor ekan `409`. |

### Hujjatlar
| | |
|---|---|
| `GET /api/documents?title=&category=` | **SQL da** chaqiruvchining `READ` kategoriyalari bilan toraytiriladi. Ikkala filtr ixtiyoriy va birga ishlaydi. |
| `POST /api/documents` | `{title, category_id, status, blocks}` → `{id}`, `201`. `category_id` da `WRITE` talab qiladi. |
| `GET /api/documents/{id}` | → `DocumentWithBlocks`, javoblar allaqachon tozalangan HTML ga aylantirilgan. Kategoriyasida `READ` talab qiladi. |
| `GET /api/documents/{id}/draft` | O'sha hujjat muharrir uchun xom Markdown ko'rinishida. `EDIT` talab qiladi. |
| `PUT /api/documents/{id}` | Joriy kategoriyada `EDIT` talab qiladi; ko'chirish uchun borish joyida qo'shimcha `WRITE`/`EDIT` kerak (SR-8). Bloklar butunlay qayta yoziladi — aynan shu ularning tartibini saqlaydi (FR-14). |
| `DELETE /api/documents/{id}` | → `204`. Kategoriyasida `DELETE` talab qiladi; bloklar kaskad bilan ketadi. |

> Bularning birortasida ham muallifllik uchun zaxira yo'l yo'q: muallifllik —
> ruxsat emas (§4.2.1). Qorovul muallif uchun ham, boshqa har kim uchun ham
> bir xil.

### Foydalanuvchilar (faqat admin)
| | |
|---|---|
| `GET /api/users` | Har bir foydalanuvchi grantlari bilan (FR-23). |
| `POST /api/users` | `{username, password, is_admin, category_perms}` → `{id}`, `201`. Hech nimasi belgilanmagan grantlar tashlanadi, bitta kategoriya uchun takrorlangan qatorlar esa saqlashdan oldin OR bilan birlashtiriladi. |
| `PUT /api/users/{id}/permissions` | `{category_perms}` → `204`. Grantlarni butunlay almashtiradi. |
| `PUT /api/users/{id}/active` | `{active}` → `204`. O'z hisobini o'chirishga urinsa `400`. |
| `PUT /api/users/{id}/password` | `{new_password}` → `204`. |

> Global `can_*` bayroqlari uchun nuqta yo'q: ular harakatsiz ekan (§4.2.1),
> o'rnatadigan narsa qolmaydi. API ularni yubormaydi ham — `User` da bunday
> maydonning o'zi yo'q, ya'ni birorta mijoz ularga bog'lanib qola olmaydi.

### Fayllar
| | |
|---|---|
| `POST /api/upload` | multipart `file` → `{url, markdown}`. `markdown` — muharrir to'g'ridan-to'g'ri qo'yadigan `![alt](url)` parchasi. |
| `GET /uploads/{file}` | Saqlangan rasm. `/api` dan tashqarida, lekin o'sha sessiya ortida. |

### O'zgarishlar tarixi (faqat admin)
| | |
|---|---|
| `GET /api/audit?target_type=&search=&limit=` | Eng yangisi birinchi. `target_type` bitta turga toraytiradi, `search` aktor / nishon / amal / tafsilotlar bo'yicha mos keladi, `limit` serverda 1..500 ga cheklanadi. |

> Yozuvni yozadigan, tahrirlaydigan yoki o'chiradigan nuqta ataylab **yo'q**.
> Yozuvlarni ular tasvirlaydigan amallarning o'zi yozadi — `audit::audit_tx`
> orqali (o'zgarishni amalga oshirayotgan tranzaksiya ichida, shunda yozuv va
> o'zgarish birga commit bo'ladi) yoki `audit::audit_now` orqali (allaqachon
> commit bo'lgan o'zgarishdan keyin — u yerda muvaffaqiyatsiz insert serverda
> logga yoziladi va hech qachon foydalanuvchi ko'radigan xatoga aylanmaydi,
> chunki o'zgarish sodir bo'lgan).

### Boshqa
| | |
|---|---|
| `GET /api/health` | `{"status":"ok"}`. Bazaga tegmaydi, shuning uchun Postgres o'chiq bo'lsa ham javob beradi — aynan shu holat haqida so'ray olish eng kerak. |

> **Qorovullar — ekstraktorlar.** `CurrentUser` oladigan ishlovchi sessiyasiz
> ishga tusha olmaydi, `AdminUser` oladigani esa admin bo'lmagan uchun umuman
> ishlamaydi, chunki so'rov tanaga yetib bormaydi — 1.x da esa har bir server
> funksiyasini `require_user().await?` bilan boshlash va hech kim unutmasligiga
> ishonish kerak edi. Ekstraktor hal qila olmaydigan narsa — *kategoriya*, u
> so'rov qaysi hujjatni atashiga bog'liq; `require_in_category` ochiq chaqiruv
> bo'lib qoladi va, avvalgidek, kategoriyasiz varianti yo'q.

> **`/api` ostidagi mos kelmagan yo'llar JSON `404` qaytaradi**, SPA ning
> `index.html` ini emas. Aks holda xato yozilgan nuqta `200` status bilan
> hujjat ko'rinishida qaytadi va mijoz uni tahlil qilishda tushib, haqiqiy
> xato o'rniga sintaksis xatosini xabar qiladi.

---

## 8. Sahifalar (marshrutlar) va interfeys

| Marshrut | Sahifa | Kirish |
|-------|------|--------|
| `/login` | Kirish formasi | Ochiq |
| `/` | Hujjatlar ro'yxati + filtrlar | Har qanday sessiya (mazmuni `READ` kategoriyalari bilan toraytiriladi) |
| `/docs/:id` | Bitta hujjat (savol-javob ko'rinishi) | O'sha hujjat kategoriyasida `READ` |
| `/docs/new` | Yangi hujjat yaratish | Kamida bitta kategoriyada `WRITE` |
| `/docs/:id/edit` | Hujjatni tahrirlash | O'sha hujjat kategoriyasida `EDIT` |
| `/categories` | Kategoriyalarni boshqarish | Admin |
| `/admin/users` | Foydalanuvchilarni boshqarish | Admin |
| `/admin/logs` | O'zgarishlar tarixi | Admin |

Bular — `react-router-dom` ga tegishli **mijoz tomonidagi** marshrutlar
(`frontend/src/App.tsx`). Server ularni bilmaydi: u tanimagan har qanday yo'l
uchun `index.html` beradi, shuning uchun `/docs/<id>/edit` da chuqur havola
yoki sahifani yangilash 404 ga emas, mijoz routeriga tushadi.

"Kirish" ustuni interfeys nimani *ko'rsatishini* tasvirlaydi. Bu sahifalarning
har biri qiladigan so'rovlarni server qaytadan tekshiradi (SR-9); bu yerdagi
qorovullar anonim tashrifchi kirish sahifasiga yuborilishidan oldin sahifa
ramkasini ko'rmasligi uchun, va `/admin/users` ni yozgan admin bo'lmagan odam
muvaffaqiyatsiz so'rovlarga to'la bo'sh jadval o'rniga bitta gap olishi uchun
bor.

**Umumiy bezak (`/login` dan tashqari har bir sahifada):**
- **Yuqori panel**: brend, "New" yorlig'i (foydalanuvchi biror joyda `WRITE`
  qila olsa ko'rsatiladi), mavzu almashtirgich va kirgan foydalanuvchi nomi.
- **Chap tik panel**: bo'limlar — Hujjatlar, admin uchun esa Kategoriyalar /
  Foydalanuvchilar / Loglar — va pastida **Log out**, xavf rangida, boshqa bo'lim
  havolasi bilan adashtirilmasligi uchun.
- `/login` da **ikkalasi ham yo'q**: bu yagona ochiq sahifa va unda navigatsiya
  qiladigan narsa yo'q, shuning uchun u bo'sh oynadagi markazlashgan kirish
  panelidan iborat.
- 760px dan pastda tik panel yuqori paneldagi ☰ tugmasi ortiga yig'iladi;
  ikkalasini ham render qiladigan layout komponenti bitta ochiq/yopiq holatni
  ushlab turadi. Bo'lim havolasini bosish uni yopadi — aks holda panel endigina
  so'ralgan sahifa ustida ochiq qolib ketardi.

**Bosh sahifa (`/`) tarkibi:**
- Yuqorida qidiruv paneli: sarlavha maydoni + kategoriya ro'yxati.
- Pastda hujjatlar ro'yxati, kartochkalar ko'rinishida.
- Ikkala filtr ham URL ning so'rov satrida yashaydi, shuning uchun filtrlangan
  ro'yxatga havola berish mumkin va u sahifa yangilanganda ham saqlanadi.
- Sarlavha filtri **kechiktiriladi**: har bir tugma bosilishida emas, yozishdagi
  har bir pauzada bitta so'rov ketadi, va har bir yangi so'rov oldingisini
  bekor qiladi. Aks holda "postgres" ni yozish — bir-biri bilan poyga qilayotgan
  sakkizta so'rov, va ro'yxat qaysi biri oxirida kelsa, o'shanda to'xtaydi.

**Hujjat sahifasi (`/docs/:id`):**
- Sarlavha, kategoriya, muallif, holat.
- Savol-javob bloklari ketma-ket, har biri "Savol → Javob" ko'rinishida;
  beshtadan ortiq savol bo'lsa, yuqorida o'tish ro'yxati paydo bo'ladi.
- Javoblar HTML sifatida qo'yiladi, va bu faqat shuning uchun xavfsizki, ularni
  **server** render qilgan va tozalagan (§3). Brauzerda render qilingan
  Markdown tozalagichni brauzer chetlab o'ta oladigan joyga qo'yardi.
- Tahrirlash / O'chirish tugmalari faqat ko'ruvchi o'sha ruxsatni **shu hujjat
  kategoriyasida** ushlab turgandagina paydo bo'ladi. Hujjatni yozgan bo'lish
  ularni u yerga qo'ymaydi.

**Muharrir (`/docs/new`, `/docs/:id/edit`):**
- Sarlavha, kategoriya va holat, so'ng savol-javob bloklari tartib bilan.
  Bloklarni qo'shish, o'chirish va ko'chirish mumkin; massiv tartibi —
  hujjatning tartibi (FR-14).
- Har bir blokda **Insert image** tugmasi bor: fayl darhol yuklanadi va
  qaytgan Markdown o'sha blok javobidagi kursor joyiga tushadi.
- Sarlavha va kategoriya bo'lmaguncha Saqlash o'chirilgan bo'ladi va qaysi biri
  yetishmayotganini aytadi — o'lik tugma qoldirmaydi.
- Holat maydoni ochiq aytadi: bu yorliq, ruxsat emas (§12.9). Oldingi
  versiyaning izohi qoralamalar "boshqa o'quvchilardan yashirin qoladi" derdi,
  bu esa hech qachon rost bo'lmagan.

**Foydalanuvchilar sahifasi (`/admin/users`):**
- "Foydalanuvchi yaratish" formasi: nom, dastlabki parol, admin bayrog'i, so'ng
  **kategoriya matritsasi** — har bir kategoriya uchun bitta qator, O'qish /
  Yozish / Tahrir / O'chirish katakchalari bilan.
- Foydalanuvchilar jadvali: nom, rol, foydalanuvchining joriy grantlari bilan
  oldindan to'ldirilgan o'sha matritsani saqlaydigan yig'iladigan
  **Kategoriyalar** katagi (o'z Saqlash tugmasi bilan), bloklash/faollashtirish,
  parolni tiklash.
- Adminlar uchun Kategoriyalar ustunida "all" ko'rinadi — tahrirlaydigan narsa
  yo'q.
- Hech qayerda global ruxsat katakchalari yo'q, chunki global ruxsatlarning
  o'zi yo'q (§4.2.1).

**Loglar sahifasi (`/admin/logs`):**
- Jadval: Qachon (UTC) / Kim / Amal / Nishon / Tafsilotlar, eng yangisi birinchi.
- Erkin matnli qidiruv va "Tur" ro'yxati (hammasi / foydalanuvchilar /
  kategoriyalar / hujjatlar / yuklamalar); yangi filtr birinchi sahifadan qayta
  boshlaydi.
- "Load more" to'liq sahifa qaytgan ekan chegarani 100 taga oshiradi.
- Vaqtlar **UTC** da ko'rsatiladi va ustun buni aytib turadi — brauzerning
  siljishi serverniki emas, va vaqtlarni jimgina siljitadigan log zonasini ochiq
  aytadiganidan yomonroq.
- Hujjat nishoni hujjatga havola qiladi, faqat yozuv uning o'chirilganini qayd
  etgan hollardan tashqari (u havola faqat 404 bera olardi).

---

## 9. Xavfsizlik talablari

- SR-1: Parollar **argon2** bilan xeshlanadi, hech qachon ochiq saqlanmaydi.
- SR-2: Sessiya cookie lari `HttpOnly` va `SameSite=Lax`. `Secure` muhitdagi
  `SECURE_COOKIE` dan keladi — mahalliy HTTP uchun standart holda o'chiq va har
  qanday TLS joylashtirishida yoqilishi shart (`DEPLOY.uz.md`, 6-qadam). 1.x da
  bu kod tahriri edi, ya'ni unutilgan tahrir cookie larni ochiq holda yuboradigan
  qilib yetkazardi. Kirishda sessiya id si almashtiriladi, shuning uchun undan
  oldin qo'lga kiritilgan cookie keyin ishlamaydi (fixation).
- SR-3: Har bir nuqtada ruxsat qorovuli majburiy. Autentifikatsiya —
  ekstraktor, shuning uchun ishlovchi usiz ishga tusha olmaydi (§7); kategoriya
  tekshiruvi esa ochiq chaqiruv va `require_in_category` ning kategoriyasiz
  varianti yo'q.
- SR-4: Ro'yxatdan o'tish nuqtasi umuman mavjud emas. API ga anonim so'rovlar
  `401` oladi va SPA tashrifchini `/login` ga yuboradi; `/uploads/*` ham sessiya
  ortida, ya'ni rasm URL i buni chetlab o'tish yo'li emas.
- SR-5: Fayl yuklashda MIME turi va hajmi tekshiriladi: faqat `image/png`,
  `image/jpeg`, `image/gif`, `image/webp`, va ≤ `MAX_UPLOAD_BYTES` (standart
  5 MB). Saqlanadigan fayl nomi — yangi UUID va *tekshirilgan MIME turidan*
  olingan kengaytma; hech qachon mijoz yuborgan nomdan emas.
- SR-6: SQL in'ektsiyasidan himoya — SQLx parametrlangan so'rovlari.
- SR-7: Kirish urinishlarini cheklash — **amalga oshirilmagan**; tavsiya
  etiladi.
- SR-8: Hujjatning kategoriyasini o'zgartirish borish joyiga yozish deb
  qaraladi: u yerda huquq bo'lmasa, ko'chirish rad etiladi. Aks holda
  foydalanuvchi hujjatni o'zi tegolmaydigan kategoriyaga surib, unga kirishni
  yo'qotishi — yoki mazmunni hech qachon mo'ljallanmagan joyga qo'yishi mumkin
  edi.
- SR-9: Kategoriya cheklovi server tomonda, SQL da, yakka yozuvlar uchun ham,
  ro'yxatlar uchun ham qo'llanadi. `frontend/src/permissions.ts` da xuddi shu
  qoida bor, lekin faqat nimani *ko'rsatish* kerakligini hal qilish uchun: u
  mijozda ishlaydi, ya'ni mijoz uni boshqaradi. Uning ortidagi har bir so'rov
  qaytadan tekshiriladi.
- SR-10: Joriy foydalanuvchining qatori **va** grantlari har bir so'rovda
  bazadan qayta o'qiladi, shuning uchun bekor qilingan grant — yoki
  faolsizlantirilgan hisob — keyingi kirishda emas, darhol kuchga kiradi.
- SR-11: O'zgarishlar tarixi serverda faqat adminlar uchun (`list_audit_log`
  ichida `require_admin`), navigatsiyada yashirilibgina qolmay: u kim admin
  bo'lmagan odam boshqa yo'l bilan ko'ra olmaydigan hisoblarga nima qilganini
  aytadi.
- SR-12: Tarix faqat qo'shiladi va hech qanday sirni saqlamaydi. Parolni tiklash
  sodir bo'lgani, kim tomonidan va qachon qayd etiladi — parolning o'zi hech
  qachon.
- SR-13: Markdown **serverda** render qilinadi va tozalanadi. Frontend natijani
  HTML sifatida qo'yadi, ya'ni tozalagich muallif yozgan `<script>` bilan
  keyingi har bir o'quvchi orasida turgan narsa; uni brauzerda ishlatish bu
  nazoratni brauzer chetlab o'ta oladigan joyga qo'yardi.
- SR-14: `CORS_ORIGINS` ishlab chiqarishda bo'sh. U faqat ishlab chiqish
  proksisi uchun bor va `*` emas, aniq originlarni ataydi — wildcard cookie
  tashiy olmaydi, cookie esa bu yerdagi butun masala.

---

## 10. Loyiha tuzilishi

Qurilgan holdagi tuzilma. Ikki crate ga arziydigan ajratish, bitta
repozitoriya.

Backend tomonda auth alohida katalog emas: sessiyalar, qorovullar va xeshlash —
bitta masala va `auth.rs` da yashaydi. "Faqat server uchun" ham endi
kompilyatsiya bayrog'i emas — butun crate faqat serverga tegishli, shuning
uchun ilgari deyarli har bir elementda turgan `#[cfg(feature = "ssr")]` shunchaki
yo'q bo'ldi.

```
platform/
├── bootstrap.sh                # bir buyruqli mahalliy sozlash
├── justfile                    # dev, ci, db-*, migrate-*
├── flake.nix                   # qadalgan Rust + Node + PostgreSQL 15
├── Dockerfile                  # node qurish → rust qurish → yengil runtime
├── docker-compose.yml          # bitta xostda ilova + Postgres
├── uploads/                    # yuklangan rasmlar (ish vaqtidagi holat)
│
├── backend/
│   ├── Cargo.toml
│   ├── migrations/             # sqlx migratsiyalari, ikkilik faylga joylashtirilgan
│   │   ├── 0001_init.sql                    # users, categories, documents, qa_blocks, uploads
│   │   ├── 0002_category_permissions.sql    # user_category_permissions
│   │   └── 0003_audit_log.sql               # audit_log
│   └── src/
│       ├── main.rs             # router, sessiya qatlami, CORS, yuklamalar, SPA, to'xtatish
│       ├── config.rs           # muhit, bir marta o'qiladi
│       ├── db.rs               # pool, migratsiyalar, urug' admin, AppState
│       ├── models.rs           # tarmoq tiplari + ruxsat qoidasi (`has_in`)
│       ├── auth.rs             # argon2, sessiyalar, CurrentUser / AdminUser ekstraktorlari
│       ├── audit.rs            # audit_tx / audit_now
│       ├── content.rs          # markdown → tozalangan HTML, slugify
│       ├── error.rs            # ApiError → status + {"error": …}
│       └── routes/
│           ├── mod.rs          # /api daraxti va uning JSON 404 i
│           ├── auth.rs
│           ├── categories.rs
│           ├── documents.rs
│           ├── users.rs
│           ├── uploads.rs
│           └── audit.rs        # o'zgarishlar tarixini o'qish (admin)
│
└── frontend/
    ├── package.json
    ├── vite.config.ts          # dev server + /api va /uploads proksilari
    ├── index.html              # qobiq, hamda render oldidan ishlaydigan mavzu skripti
    └── src/
        ├── main.tsx            # React ildizi, QueryClient, provayderlar
        ├── App.tsx             # marshrutlar jadvali
        ├── api/
        │   ├── types.ts        # backend/src/models.rs ni takrorlaydi — qo'lda (§3)
        │   ├── client.ts       # fetch o'ramchisi, ApiError, credentials: "include"
        │   └── endpoints.ts    # har bir nuqta uchun bitta tiplangan funksiya
        ├── auth/AuthContext.tsx  # kim tizimga kirgan
        ├── permissions.ts      # ruxsat qoidasining mijozdagi nusxasi
        ├── format.ts           # sanalar va logning UTC vaqt belgilari
        ├── components/         # Layout, RequireAuth, ConfirmButton, ThemeSelect,
        │                       #   Flash, Loading
        ├── pages/              # Login, Home, Document, Editor, Categories,
        │                       #   AdminUsers, AuditLog
        └── styles/main.css     # butun uslublar fayli, to'rtta mavzu
```

---

## 11. Ishlab chiqish bosqichlari (yo'l xaritasi)

### 1-bosqich — Poydevor
- Loyiha skeleti (Leptos + Axum + SQLx).
- BD ulanishi va migratsiyalar.
- `users` jadvali va admin hisobi (urug').

### 2-bosqich — Autentifikatsiya
- Kirish/chiqish, sessiya, qorovul.
- Admin panel: foydalanuvchi yaratish + ruxsatlar.

### 3-bosqich — Mazmun
- Kategoriyalar CRUD.
- Hujjat yaratish (savol-javob bloklari bilan).
- Rasm yuklash.

### 4-bosqich — Ko'rish va filtrlash
- Hujjatlar ro'yxati.
- Sarlavha + kategoriya filtri.
- Hujjat sahifasi (savol-javob ko'rinishi).

### 5-bosqich — Sayqal
- Tahrirlash (`EDIT`), holat (draft/published).
- Xavfsizlik tekshiruvlari, xatolarni qayta ishlash, dizayn.

### 6-bosqich — Kategoriya bo'yicha ruxsatlar
- `user_category_permissions` jadvali va hal qilish qoidasi (§4.2.1).
- Har bir hujjat server funksiyasida kategoriyani hisobga oluvchi qorovullar;
  ro'yxatlar SQL da toraytiriladi.
- Admin interfeysi: foydalanuvchi yaratishda va har bir mavjud foydalanuvchida
  kategoriya matritsasi.
- Global `can_*` bayroqlari hal qilish qoidasidan ham, interfeysdan ham chiqib
  ketdi; ustunlar esa qolib ketdi. §4.2.1 bu qayerga olib kelganini qayd etadi.

### 7-bosqich — Navigatsiya va o'zgarishlar tarixi
- Bo'limlar yuqori paneldan chap tik panelga ko'chirildi; `/login` dan barcha
  bezaklar olib tashlandi; chiqish tugmasi tik panelning pastiga ko'chirildi
  (§8).
- `audit_log` jadvali (§6.8) va ikkita yozuv yordamchisi.
- Har bir o'zgartiruvchi amal kim/qachon/nima/nima o'zgargani bilan yoziladi:
  foydalanuvchilar, kategoriya bo'yicha ruxsatlar, kategoriyalar, hujjatlar,
  yuklamalar (§5.6).
- `/admin/logs` — qidiruv, tur filtri va sahifalash bilan faqat adminga
  ko'rinadigan ro'yxat.

### 8-bosqich — Qadoqlash va operatsiyalar
- `bootstrap.sh`: klondan ishlayotgan ilovagacha bitta buyruqda, Nix bilan ham,
  usiz ham.
- `justfile`: mahalliy klasterning porti va rolini to'g'ri saqlaydigan
  retseptlar.
- `Dockerfile` + `docker-compose.yml`, toolchain versiyalari build argumentlari
  sifatida qadalgan holda — jumladan `wasm-opt` pini, usiz release to'plami
  ishlatib bo'lmaydigan sahifaga gidratsiya bo'ladi.
- `DEPLOY.uz.md`: Ubuntu da systemd + nginx + Let's Encrypt.

### 9-bosqich — Backend va frontendga ajratish (v2.0)
- Leptos olib tashlandi. `backend/` oddiy Axum JSON API ga aylandi (§7);
  `frontend/` esa Vite + React bir sahifali ilovasiga.
- Qorovullar ekstraktorlarga aylandi; xatoliklar bitta JSON shakli bilan status
  kodlariga aylandi.
- Ruxsat qoidasi, sxema, audit log va uslublar fayli o'zgarishsiz ko'chirildi —
  bu yetkazish usulining o'zgarishi edi, xatti-harakatning emas.
- Boshqacha bo'libgina qolmay, *yaxshilangan* yagona narsa — yuklamalar.
  `![alt](url)` parchasini olib yuradigan JSON javobi muharrirga rasmni ayni
  yozilayotgan javobga qo'yish imkonini berdi; SSR versiyasi esa yuklamani
  faqat yangi oynada ocha olardi, muallif URL ni qo'lda ko'chirib olishi uchun.
- Yomonlashgan yagona narsa — tiplar chegarasi. Bu nimaga tushishini §3 aytadi.

---

## 12. Ochiq masalalar

### Hal qilingan

1. **Foydalanuvchi `EDIT` ruxsatisiz o'zi yaratgan hujjatni tahrirlay oladimi?**
   **Yo'q.** Muallifllikning o'z huquqlari yo'q: hujjatni o'qish, tahrirlash va
   o'chirish — har biri u turgan kategoriya uchun mos grantni talab qiladi.
   Grantini yo'qotgan muallif o'zi yozgan narsaga kirolmay qoladi. Bu — amalga
   oshirish davomida teskarisiga o'zgargan yagona qaror (qorovullar avvalo
   kategoriya bo'yicha yozilgan va ularga muallifllik shoxi hech qachon
   qo'shilmagan) va uni qayta ko'rib chiqishga arziydi, chunki "kecha yozgan
   hujjatimni endi ocholmayapman" — platforma odamga aytishi g'alati bo'lgan
   gap.
2. **Kategoriyalarni faqat admin boshqaradimi yoki ruxsatli foydalanuvchilar
   ham?** **Faqat admin.** Har qanday autentifikatsiyadan o'tgan foydalanuvchi
   o'zi ko'ra oladigan kategoriyalarni *ro'yxatlashi* mumkin (filtrlarga shu
   kerak), lekin yaratish/qayta nomlash/o'chirish — `is_admin`.
3. **Rasmlar mahalliy saqlanadimi yoki bulutda (S3)?**
   **Mahalliy**, `UPLOADS_DIR` (standart `uploads/`) ostida, `ServeDir` orqali
   `/uploads/*` da beriladi. Ishlab chiqarishda bu — Postgres ushlab turmaydigan
   yagona holat, shuning uchun unga alohida zaxira kerak (`DEPLOY.uz.md`).
4. **`DELETE` ruxsati kerakmi yoki hujjatlar faqat arxivlanadimi?**
   **`DELETE` amalga oshirilgan** va haqiqatan o'chiradi; `qa_blocks` kaskad
   bilan ketadi. Audit yozuvi esa omon qoladi va hujjatning sarlavhasini olib
   yuradi.
5. **Javoblar formati: markdown, oddiy matn yoki rich-text?**
   **Markdown**, server tomonda `pulldown-cmark` render qiladi va brauzerga
   yetib borishidan oldin `ammonia` tozalaydi.
6. **Kategoriya ruxsatlari global ruxsatlar bilan qanday birlashadi?**
   **Birlashmaydi — global bayroqlar modeldan chiqib ketgan.** Admin bo'lmagan
   foydalanuvchining huquqlari aynan uning grantlari (§4.2.1). Ustunlar `users`
   da qolgan va harakatsiz; ularni olib tashlash-tashlamaslik — quyidagi 8-band.

### Hali ochiq

7. Yuklamalar ham kategoriya bo'yicha cheklanishi kerakmi? Bugun `/uploads/…`
   URL lari sessiyasi bor har kimga ochiq, uni qaysi hujjat joylashtirganidan
   qat'i nazar.
8. Harakatsiz `users.can_*` ustunlari migratsiya bilan olib tashlanishi
   kerakmi, yoki `has_in` ularni yana o'qishga o'rgatilishi kerakmi? Ularni
   shundayligicha qoldirish — sxemani keyingi o'qigan odamni chalg'itishda davom
   etadigan yagona variant (§4.2.1).
9. `draft` ko'rinuvchanlik uchun biror ma'noga ega bo'lishi kerakmi? Hozir yo'q:
   qoralama o'z kategoriyasida `READ` ga ega har kimga xuddi chop etilgan hujjat
   kabi ochiq (FR-16). Agar qoralamalar muallifga xos bo'lishi kerak bo'lsa,
   `list_documents` ga ham, `get_document` ga ham holat sharti kerak — va o'sha
   shartga muallif uchun istisno kerak bo'ladi, buni esa hozirda 1-band taqiqlab
   turibdi.
10. `list_documents` chaqiruvchining `READ` qila olmaydigan kategoriyalardagi
    o'z hujjatlarini ko'rsatishi kerakmi, FR-17 dastlab aytganidek? Bugun
    ko'rsatmaydi. Javob 1-banddan kelib chiqadi: agar muallifllik hech narsa
    bermasa, ko'rsatmasligi kerak va xato bo'lgan narsa — FR-17 ning o'zi.
11. Kirishni cheklash (SR-7) — amalga oshirilmagan. Ro'yxatdan o'tishi yo'q
    ichki platformada xavf kichik, lekin kirish nuqtasi — anonim tashrifchi
    yeta oladigan yagona narsa.
12. CSRF tokenlari (§3). `SameSite=Lax` va SPA ning bitta origin da bo'lishi
    oddiy hollarni qoplaydi, lekin bu token emas, va frontend boshqa origin ga
    ko'chgan kuni u umuman hech narsani qoplamay qo'yadi.
13. Tarmoq tiplari `backend/src/models.rs` va `frontend/src/api/types.ts`
    o'rtasida **qo'lda** takrorlanadi (§3). Ularning mos kelishini hech narsa
    tekshirmaydi — bir tomonda nomi o'zgargan maydon ikkala tomonda ham tip
    tekshiruvidan o'tadi va ish vaqtida tushadi. TypeScript ni Rust dan
    generatsiya qilish yoki shartnomani testda tasdiqlash buni yopardi;
    ikkalasi ham ajratish keltirib chiqargan ish va hech biri qilinmagan.
14. Sessiyalar xotirada, shuning uchun har bir qayta ishga tushirish hammani
    tizimdan chiqaradi va ikkinchi nusxa ularni bo'lisha olmaydi.
    `DEPLOY.uz.md` ning B ilovasida Postgres ombori bor; kodda buni to'sadigan
    narsa yo'q, shunchaki almashtirilmagan.
