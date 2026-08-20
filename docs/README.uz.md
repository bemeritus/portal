# Bilimlar bazasi / Savol-javob platformasi

*English: [README.md](../README.md)*

Ichki, admin nazoratidagi bilimlar bazasi: ruxsat berilgan foydalanuvchilar
texnik hujjatlarni **savol-javob** ko'rinishida yozadi va o'qiydi. Ikkita
dastur:

| | | |
|---|---|---|
| **`backend/`** | Rust — **Axum** + **SQLx** + **PostgreSQL** | `/api` ostidagi JSON API, ishlab chiqarishda esa frontend uchun statik server |
| **`frontend/`** | TypeScript — **React** + **Vite** | bir sahifali ilova (SPA); brauzer faqat shu bilan gaplashadi |

Texnik topshiriq — [`platform_doc.uz.md`](./platform_doc.uz.md).

## Hujjatlar

| | O'zbekcha | English |
|---|---|---|
| Shu fayl — sozlash, ishga tushirish, ruxsatlar | [`README.uz.md`](./README.uz.md) | [`README.md`](../README.md) |
| Texnik topshiriq | [`platform_doc.uz.md`](./platform_doc.uz.md) | [`platform_doc.md`](./platform_doc.md) |
| Ishlab chiqarishga joylashtirish | [`DEPLOY.uz.md`](./DEPLOY.uz.md) | [`DEPLOY.md`](./DEPLOY.md) |

## Tez boshlash

```sh
./bootstrap.sh          # `git clone` bilan ishlayotgan ilova orasidagi hamma narsa
```

U `.env` faylini yaratadi, `.pgdata` ichida mahalliy PostgreSQL klasterini
**5433-portda** tayyorlaydi, ma'lumotlar bazasini yaratadi, frontend
bog'liqliklarini o'rnatadi va ikkala dev serverni ishga tushiradi.
**http://127.0.0.1:5173** ni oching. Skriptni qayta ishga tushirish xavfsiz;
`./bootstrap.sh --setup-only` hech narsani ishga tushirmasdan to'xtaydi.

## Ikki yarim bir-biriga qanday ulanadi

```
ishlab chiqish (development)          ishlab chiqarish (production)
────────────────────────────          ─────────────────────────────
brauzer → Vite :5173                  brauzer → Axum :3000
            │  /api, /uploads                    ├── /api/*      JSON
            └─ :3000 ga proksi                   ├── /uploads/*  fayllar, sessiya ortida
                                                 └── /*          index.html + aktivlar
```

Ishlab chiqishda brauzerning origin i Vite ga tegishli va u API ni Axum ga
uzatadi — shu sababli sessiya cookie si ishlab chiqishda ham, ishlab
chiqarishdagi kabi, bir xil origin da bo'ladi. Buni o'zgartirishdan oldin
bilib qo'yish kerak: frontendni to'g'ridan-to'g'ri `:3000` ga qaratsangiz,
cookie cross-site bo'lib qoladi, `SameSite=Lax` uni tashlab yuboradi va ilova
tizimga kiradi-yu, darhol chiqib ketgandek ko'rinadi.

Ishlab chiqarishda bitta origin va bitta jarayon bor — `STATIC_DIR` Axum ni
`frontend/dist` ga qaratadi — shuning uchun CORS umuman ishtirok etmaydi.

## Imkoniyatlar

- **Ochiq ro'yxatdan o'tish yo'q** — foydalanuvchini faqat admin yaratadi
  (`/admin/users`).
- **Kategoriya bo'yicha ruxsatlar**: `READ`, `WRITE`, `EDIT`, `DELETE`
  foydalanuvchiga *alohida kategoriyalar uchun* beriladi. Qarang:
  [Ruxsatlar](#ruxsatlar).
- **Savol-javob hujjatlari**: sarlavha + kategoriya + holat va tartiblangan
  savol/javob bloklari; javoblar **Markdown**, server tomonda render qilinadi
  va tozalanadi.
- **Kategoriyalar**ni admin boshqaradi; har bir hujjat aynan bitta
  kategoriyaga tegishli.
- Bosh sahifada **sarlavha** (ILIKE) va **kategoriya** bo'yicha jonli
  **filtrlash**.
- **Rasm yuklash** (PNG/JPEG/GIF/WebP, ≤5 MB) — rasm siz tahrirlayotgan
  javobga to'g'ridan-to'g'ri qo'yiladi.
- **O'zgarishlar tarixi** (`/admin/logs`, faqat admin): foydalanuvchi, ruxsat,
  kategoriya, hujjat va yuklamalardagi har bir o'zgarish kim, qachon, qanday
  amal va nima o'zgargani bilan yoziladi — faqat qo'shiladi va yozuvlar o'zi
  tasvirlagan narsadan uzoqroq yashaydi.
- **argon2** parol xeshlash, **tower-sessions** cookie sessiyalari va har bir
  nuqtada ruxsat qorovuli.

## Ruxsatlar

`backend/src/models.rs` da amalga oshirilgan va `backend/src/auth.rs` da
qo'llanadigan model — **faqat grantlar**:

```
ruxsat(foydalanuvchi, kategoriya, amal) =
      foydalanuvchi.is_admin                    // adminlar hamma joyda hamma narsani ushlaydi
   OR grant(foydalanuvchi, kategoriya, amal)    // user_category_permissions dagi qator
```

Uchinchi shart yo'q. Xususan:

- **Global bayroqlar hech narsa bermaydi.** `users.can_*` ustunlari sxemada
  hamon bor, lekin birorta qorovul ularni o'qimaydi, birorta nuqta ularni
  yozmaydi, va API ularni mijozga umuman yubormaydi. Qarang:
  [Ma'lum kamchiliklar](#malum-kamchiliklar).
- **Muallifllik hech narsa bermaydi.** O'z hujjatingizni o'qish, tahrirlash
  yoki o'chirish — barchasi hujjat hozir turgan kategoriya uchun tegishli
  grantni talab qiladi.
- **Ruxsat doim hujjatning kategoriyasiga nisbatan hal qilinadi.** Hujjatni
  boshqa joyga ko'chirish uchun borish joyida ham `WRITE` yoki `EDIT` kerak.
- **Ruxsatlar har bir so'rovda bazadan qaytadan o'qiladi**, shuning uchun grant
  bekor qilinsa — sessiya davomida, qayta kirmasdan — darhol kuchga kiradi.
- **Holat — kirishni cheklash vositasi emas.** `draft` va `published`
  saqlanadi va ko'rsatiladi, lekin qoralama uning kategoriyasini `READ` qila
  oladigan har kimga ko'rinadi.

`frontend/src/permissions.ts` shu qoidani nimani *ko'rsatish* kerakligini hal
qilish uchun takrorlaydi. U hech qachon nima ruxsat etilganini hal qilmaydi:
uning ortidagi har bir so'rovni server qaytadan tekshiradi.

## Talablar

Nix flake hammasini beradi: Rust toolchain, **Node.js 22**, `sqlx-cli`, `just`
va PostgreSQL 15.

```sh
direnv allow        # yoki: nix develop
```

Nix bo'lmasa, `./bootstrap.sh` yetishmayotganini distributiv paket menejeri
(apt/dnf/pacman/zypper/apk) va rustup orqali — so'rab turib — o'rnatadi. Qo'lda
qilsangiz: Rust stable, Node.js 20+ va ishlab turgan PostgreSQL kerak.

## Sozlash

`./bootstrap.sh --setup-only` quyidagilarning barchasini bajaradi. Qo'lda:

1. **Muhitni sozlang**:

   ```sh
   cp .env.example .env
   # DATABASE_URL, ADMIN_USERNAME, ADMIN_PASSWORD ni tahrirlang
   ```

2. **PostgreSQL ni ishga tushiring** va bazani yarating. Bu loyiha kutayotgan
   mahalliy klaster `.pgdata` ichida yashaydi va **5433-portni** tinglaydi:

   ```sh
   initdb -D .pgdata -U postgres -A trust
   pg_ctl -D .pgdata -o "-k /tmp -p 5433" -l .pgdata/log start
   createdb -h 127.0.0.1 -p 5433 -U postgres -O postgres portal
   ```

   va mos `DATABASE_URL`:

   ```
   DATABASE_URL=postgres://postgres@127.0.0.1:5433/portal
   ```

   > **Port ixtiyoriy emas.** `postgresql.conf` da `port` izohga olingan, ya'ni
   > `-p 5433` ni tushirib qoldirsangiz klaster jimgina 5432-portda ishga
   > tushadi, ilova esa 5433 ni terishda davom etadi — bu ulanishdan bosh
   > tortish sifatida emas, ishga tushishdagi `PoolTimedOut` sifatida namoyon
   > bo'ladi. `just db-start` buni to'g'ri bajaradi.
   >
   > `-A trust` har qanday mahalliy ulanishni parolsiz qabul qiladi. Loopback
   > portidagi ishlab chiqish klasteri uchun bu joiz, boshqa hech qayerda emas
   > — qarang: [`DEPLOY.uz.md`](./DEPLOY.uz.md).

3. **Frontend bog'liqliklarini o'rnating**: `just install` (`frontend/` ichida
   `npm ci`).

4. **Migratsiyalar** server ishga tushganda avtomatik bajariladi (ular ikkilik
   faylga kompilyatsiya qilingan), yoki qo'lda: `just migrate`.

## Ishga tushirish

```sh
just dev                # ikkala yarim: Vite :5173 da, Axum :3000 da
just dev-api            # faqat API
just dev-web            # faqat frontend
just serve              # ishlab chiqarish shakli: SPA quriladi va Axum :3000 da beradi
just ci                 # fmt-check + clippy + eslint + tsc + testlar
```

Yakka `just` barcha retseptlarni ko'rsatadi: bazani ishga tushirish/to'xtatish/
tiklash, migratsiyalar, `psql`, portlarni tekshirish, tozalash.

Birinchi ishga tushishda, agar `users` jadvali bo'sh bo'lsa, `ADMIN_USERNAME` /
`ADMIN_PASSWORD` dan **urug' admin** yaratiladi. Tizimga kiring, so'ng
`/admin/users` da foydalanuvchilar yarating. **Avval kategoriya yarating** —
ruxsatlar kategoriya bo'yicha beriladi, ular yo'q ekan beradigan narsa yo'q, va
grantsiz yangi admin bo'lmagan foydalanuvchi bo'sh platformani ko'radi.

### Docker bilan

```sh
docker compose up --build          # ilova + PostgreSQL, http://127.0.0.1:3000
docker compose logs -f app
docker compose down                # to'xtatish; nomli volumelar saqlanadi
docker compose down -v             # to'xtatish va bazani hamda yuklamalarni O'CHIRISH
```

Tasvir ikkala yarimni ham quradi (Node bosqichi → Rust bosqichi → yengil
runtime) va bitta ikkilik fayl hamda statik to'plamni beradi. Sozlash `PORTAL_*`
o'zgaruvchilaridan keladi, barchasi standart qiymatli, shuning uchun
`docker compose up` hech qanday tayyorgarliksiz ishlaydi.

## Konfiguratsiya

Ishga tushishda bir marta `Config::from_env` (`backend/src/config.rs`)
tomonidan o'qiladi; agar mavjud bo'lsa, avval mahalliy `.env` yuklanadi.

| O'zgaruvchi | Standart | Ma'nosi |
|---|---|---|
| `DATABASE_URL` | *(majburiy — usiz ilova panic qiladi)* | Postgres ulanish satri |
| `ADMIN_USERNAME` | `admin` | Urug' admin, faqat `users` bo'sh ekan ishlatiladi |
| `ADMIN_PASSWORD` | `admin` | Urug' adminning paroli |
| `UPLOADS_DIR` | `uploads` | Rasmlar yoziladigan joy; `/uploads/*` da beriladi |
| `MAX_UPLOAD_BYTES` | `5242880` | Bitta fayl uchun yuklash chegarasi (SR-5) |
| `BIND_ADDR` | `127.0.0.1:3000` | API qayerni tinglaydi |
| `STATIC_DIR` | `static` | Beriladigan qurilgan SPA; ishlab chiqishda ishlatilmaydi |
| `CORS_ORIGINS` | *(bo'sh)* | Vergul bilan ajratilgan originlar, ular cookie bilan so'rov yubora oladi. **Faqat ishlab chiqish uchun** — yuqoriga qarang |
| `SECURE_COOKIE` | `0` | Sessiya cookie sidagi `Secure`. TLS ortida `1` qiling (SR-2) |

## API

Hammasi JSON, `/api` ostida, va har bir xatolik bir xil shaklda:
`{"error": "foydalanuvchiga ko'rsatiladigan gap"}` — mos status kodi bilan.

| | |
|---|---|
| `POST /api/auth/login` · `POST /api/auth/logout` · `GET /api/auth/me` | sessiyalar |
| `GET /api/categories` · `GET /api/categories/writable` · `POST` · `PUT /{id}` · `DELETE /{id}` | kategoriyalar |
| `GET /api/documents?title=&category=` · `POST` · `GET /{id}` · `GET /{id}/draft` · `PUT /{id}` · `DELETE /{id}` | hujjatlar |
| `GET /api/users` · `POST` · `PUT /{id}/permissions` · `PUT /{id}/active` · `PUT /{id}/password` | admin |
| `GET /api/audit?target_type=&search=&limit=` | o'zgarishlar tarixi (admin) |
| `POST /api/upload` (multipart `file`) | rasmlar |
| `GET /api/health` | tiriklik; bazaga tegmaydi |

`/uploads/*` saqlangan fayllarni beradi va sessiya talab qiladi.

## Loyiha tuzilishi

```
bootstrap.sh               bir buyruqli mahalliy sozlash
justfile                   vazifa yurituvchi: dev, ci, db-*, migrate-*
Dockerfile                 uch bosqichli tasvir (node → rust → yengil runtime)
docker-compose.yml         bitta xost uchun ilova + Postgres
backend/
  migrations/              sxema; ikkilik faylga joylashtirilgan va ishga tushishda qo'llanadi
  src/
    main.rs                router, sessiyalar, CORS, yuklamalar, SPA, to'xtatish
    config.rs              muhit, bir marta o'qiladi
    db.rs                  pool, migratsiyalar, urug' admin, AppState
    models.rs              tarmoq tiplari + ruxsat qoidasi (`has_in`)
    auth.rs                argon2, sessiyalar, CurrentUser/AdminUser qorovullari
    audit.rs               audit yozuvchi ikki yordamchi
    content.rs             markdown → tozalangan HTML, slugify
    error.rs               ApiError → status + {"error": …}
    routes/                auth, categories, documents, users, uploads, audit
frontend/
  src/
    main.tsx               React ildizi, QueryClient
    App.tsx                marshrutlar jadvali
    api/                   types.ts (models.rs ni takrorlaydi), client.ts, endpoints.ts
    auth/AuthContext.tsx   kim tizimga kirgan
    permissions.ts         ruxsat qoidasining mijozdagi nusxasi
    components/            Layout, RequireAuth, ConfirmButton, ThemeSelect, …
    pages/                 Login, Home, Document, Editor, Categories, AdminUsers, AuditLog
    styles/main.css        butun uslublar fayli, to'rtta mavzu
```

## Xavfsizlik izohlari (§9)

- Parollar argon2 bilan xeshlanadi; xesh hech qachon serverdan chiqmaydi va
  API ning `User` tipida u uchun maydon ham yo'q.
- Sessiya cookie lari `HttpOnly`, `SameSite=Lax`, va `SECURE_COOKIE=1` bo'lsa
  `Secure`. Kirishda sessiya id si almashtiriladi (session fixation).
- Autentifikatsiya — eslab chaqiriladigan funksiya emas, **ekstraktor**:
  `CurrentUser` oladigan ishlovchi sessiyasiz ishga tusha olmaydi, `AdminUser`
  oladigani esa admin bo'lmagan uchun umuman ishlamaydi.
- Avtorizatsiya birligi — kategoriya: `require_in_category` ning kategoriyasiz
  varianti yo'q.
- Kategoriya cheklovi ro'yxatlar uchun ham SQL da qo'llanadi, faqat yakka
  yozuvlar uchun emas — interfeysda havolani yashirish hech qachon yagona
  nazorat emas.
- Markdown **serverda** render qilinadi va tozalanadi, chunki mijoz natijani
  HTML sifatida qo'yadi. Brauzerda ishlaydigan tozalagich — brauzer chetlab
  o'tishi mumkin bo'lgan tozalagich.
- Hamma joyda SQLx parametrlangan so'rovlari; yuklamada MIME va hajm
  tekshiriladi, saqlanadigan kengaytma esa tekshirilgan MIME turidan olinadi,
  hech qachon mijozning fayl nomidan emas.
- O'zgarishlar tarixi serverda admin bilan cheklangan va hech qanday sirni
  yozmaydi — parolni tiklash sodir bo'lgani yoziladi, parolning o'zi emas.
- Sessiyalar xotiradagi omborda — qayta ishga tushirishlardan omon qolishi
  uchun tower-sessions ning Postgres omborini qo'ying (`DEPLOY.uz.md`, B
  ilovasi).

## Ma'lum kamchiliklar

Texnik topshiriq tasvirlagan, lekin kod bajarmaydigan narsalar. Har biri
loyiha egasining qarori bo'lgani uchun jimgina tuzatilmay, hujjatlashtirildi:

1. **Global `users.can_*` ustunlari — o'lik yuk.** Birorta qorovul ularga
   qaramaydi va birorta nuqta ularni o'rnatmaydi; ularni faqat `seed_admin`
   yozadi, u ham baribir `is_admin` bo'lgan qatorda. Yo migratsiya bilan olib
   tashlash, yo `User::has_in` da qo'shiluvchi qoidani tiklash kerak.
2. **`list_documents` foydalanuvchining o'z hujjatlarini ko'rsatmaydi**, agar
   ular `READ` qila olmaydigan kategoriyada bo'lsa (TT FR-17 ko'rsatishi kerak
   deydi).
3. **`draft` maxfiylik ma'nosiga ega emas.** Muharrir endi buni ochiq aytadi,
   lekin qoralamalar faqat muallif uchun bo'lishi kerak bo'lsa, ro'yxatga ham,
   yakka o'qishga ham holat sharti kerak.
4. **CSRF tokeni yo'q.** Sessiyalar `SameSite=Lax` ga tayanadi. API va SPA
   bitta origin da bo'lgani uchun bu oddiy hollarni qoplaydi, ammo bu token
   emas.
5. **Kirish urinishlarini cheklash yo'q** (SR-7).
6. **Yuklamalar kategoriya bo'yicha cheklanmagan** — tizimga kirgan har qanday
   foydalanuvchi taxmin qila olgan istalgan `/uploads/…` ni ochishi mumkin.
