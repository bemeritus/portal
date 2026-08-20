# Ubuntu serverga joylashtirish

*English: [DEPLOY.md](./DEPLOY.md)*

Maqsad: **Ubuntu 22.04 / 24.04 LTS**. Natija — `127.0.0.1:3000` ni tinglaydigan,
systemd boshqaradigan xizmat; oldida **HTTPS** (Let's Encrypt) bilan **nginx**;
orqasida **PostgreSQL**; yuklangan rasmlar mahalliy diskda.

```
Brauzer ──HTTPS──▶ nginx (:443) ──HTTP──▶ portal (127.0.0.1:3000) ──▶ PostgreSQL
                                                     │
                                                     └──▶ /opt/portal/uploads
```

Bunga uch yo'l bilan yetish mumkin:

- **Serverda qurish** (eng sodda; ~2 GB RAM + swap kerak). Quyidagi 1–11
  qadamlar.
- **Boshqa joyda qurib, artefaktlarni ko'chirish** (serverni yengil saqlaydi).
  [A ilovasi](#a-ilovasi--boshqa-mashinada-qurish) ga qarang.
- **Docker**, agar xostga Rust va Node umuman o'rnatmoqchi bo'lmasangiz.
  [C ilovasi](#c-ilovasi--docker) ga qarang.

Hamma joyda `kb.example.com` ni o'z domeningizga almashtiring va kuchli parollar
tanlang.

---

## 1. Tizim paketlari

```sh
sudo apt update
sudo apt install -y build-essential pkg-config libssl-dev curl git \
                    postgresql nginx nodejs npm \
                    certbot python3-certbot-nginx
```

`nodejs` React frontendini quradi; `npm` Ubuntu paketi bilan birga keladi.
Versiyani tekshiring — frontendga **Node 20 yoki undan yangisi** kerak, Ubuntu
22.04 esa standart holda 12 ni beradi:

```sh
node --version   # v20+ ; eskiroq bo'lsa https://deb.nodesource.com dan o'rnating
```

## 2. PostgreSQL: baza va rol

```sh
sudo -u postgres psql <<'SQL'
CREATE ROLE portal WITH LOGIN PASSWORD 'CHANGE_ME_DB_PASSWORD';
CREATE DATABASE portal OWNER portal;
SQL
```

Ilova `localhost:5432` ga TCP orqali ulanadi. Sxema **migratsiyalari birinchi
ishga tushishda avtomatik bajariladi** (ular ikkilik faylga kompilyatsiya
qilingan), shuning uchun ularni qo'lda bajarish shart emas.

Ulanish satri (keyinroq muhit faylida ishlatiladi):

```
DATABASE_URL=postgres://portal:CHANGE_ME_DB_PASSWORD@localhost:5432/portal
```

## 3. Toolchain (serverda qurish uchun)

Rust toolchain versiyasi `Dockerfile` build argumenti bilan bir xil qadalgan;
o'zgartirsangiz, ikkalasini birga saqlang.

```sh
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y
. "$HOME/.cargo/env"
rustup toolchain install 1.96 && rustup default 1.96
```

Backend ga shuncha yetadi — u oddiy server ikkilik fayli, wasm maqsadi ham,
cargo-leptos ham kerak emas. Frontendga esa faqat 1-qadamdagi `nodejs`/`npm`
kerak.

Kam RAM li serverlar: qurishdan oldin swap qo'shing, aks holda linker ni OOM
o'ldiradi.

```sh
sudo fallocate -l 4G /swapfile && sudo chmod 600 /swapfile
sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 4. Ishlab chiqarish uchun qurish

Ikkala yarim ham, istalgan tartibda:

```sh
git clone <sizning-repo-url> portal && cd portal

# Bir sahifali ilova → frontend/dist
cd frontend && npm ci && npm run build && cd ..

# Server ikkilik fayli → backend/target/release/portal
cd backend && cargo build --release && cd ..
```

`npm run build` avval `tsc -b` ni bajaradi, shuning uchun tip xatosi qurishni
to'xtatadi — hech kim tekshirmagan to'plam yetkazilmaydi.

> TLS ga joylashtirishdan oldin bu yerda hech narsani tahrirlash shart emas.
> Sessiya cookie sidagi `Secure` bayrog'i — muhit faylidagi `SECURE_COOKIE=1`
> (6-qadam), o'zgartirishni ham, keyin qaytarishni ham eslab qolish kerak
> bo'lgan kod satri emas.

## 5. /opt/portal ga o'rnatish

```sh
sudo useradd --system --create-home --home-dir /opt/portal --shell /usr/sbin/nologin portal || true
sudo install -m755 backend/target/release/portal /opt/portal/portal
sudo rm -rf /opt/portal/static && sudo cp -r frontend/dist /opt/portal/static
sudo mkdir -p /opt/portal/uploads
sudo chown -R portal:portal /opt/portal
```

Yakuniy tuzilma:

```
/opt/portal/
├── portal          # ikkilik fayl
├── static/         # STATIC_DIR — qurilgan SPA (index.html + assets/)
├── uploads/        # foydalanuvchi yuklagan rasmlar (doimiy)
└── portal.env      # keyingi qadamda yaratiladi
```

## 6. Muhit fayli

`/opt/portal/portal.env` ni yarating (systemd uni oddiy `KEY=VALUE` sifatida
o'qiydi, qo'shtirnoq ham, shell kengaytmasi ham yo'q):

```ini
# --- Ilova ---
DATABASE_URL=postgres://portal:CHANGE_ME_DB_PASSWORD@localhost:5432/portal
ADMIN_USERNAME=admin
ADMIN_PASSWORD=CHANGE_ME_ADMIN_PASSWORD
UPLOADS_DIR=/opt/portal/uploads
MAX_UPLOAD_BYTES=5242880

# --- Server ---
BIND_ADDR=127.0.0.1:3000
# WorkingDirectory ga nisbatan hal qilinadi → /opt/portal/static
STATIC_DIR=static
# Sessiya cookie si faqat HTTPS orqali yuradi (SR-2). Buni saytni TLS ortiga
# qo'yishdan oldin qo'ying, keyin emas.
SECURE_COOKIE=1
RUST_LOG=info

# CORS_ORIGINS ataylab yo'q. SPA ayni shu origin dan beriladi, ya'ni
# cross-origin so'rov umuman mavjud emas; uni qo'yish faqat sessiya cookie si
# qayerdan yuborilishi mumkinligini kengaytirardi.
```

```sh
sudo chown portal:portal /opt/portal/portal.env
sudo chmod 600 /opt/portal/portal.env
```

`ADMIN_USERNAME`/`ADMIN_PASSWORD` birinchi adminni **faqat `users` jadvali bo'sh
bo'lgandagina** yaratadi. Kiring va parolni o'zgartiring, so'ng ularni olib
tashlashingiz mumkin.

## 7. systemd xizmati

`/etc/systemd/system/portal.service` ni yarating:

```ini
[Unit]
Description=Portal Knowledge Base
After=network.target postgresql.service
Wants=postgresql.service

[Service]
User=portal
Group=portal
WorkingDirectory=/opt/portal
EnvironmentFile=/opt/portal/portal.env
ExecStart=/opt/portal/portal
Restart=on-failure
RestartSec=5

# Qattiqlashtirish
NoNewPrivileges=true
ProtectSystem=full
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/opt/portal/uploads

[Install]
WantedBy=multi-user.target
```

`WorkingDirectory=/opt/portal` muhim: `STATIC_DIR=static` unga nisbatan hal
qilinadi (→ `/opt/portal/static`).

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now portal
sudo systemctl status portal
journalctl -u portal -f          # loglarni kuzating; "listening on http://127.0.0.1:3000" kutiladi
```

Serverning o'zida tez tekshiruv:

```sh
curl -s http://127.0.0.1:3000/api/health                                # {"status":"ok"}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/login    # 200 (SPA)
```

Birinchisi Postgres o'chiq bo'lsa ham javob beradi — aynan shu uni "xizmat
o'lgan" bilan "baza o'lgan" ni ajratish uchun foydali qiladi.

## 8. nginx teskari proksi

`/etc/nginx/sites-available/portal` ni yarating:

```nginx
server {
    listen 80;
    server_name kb.example.com;

    # 5 MB lik rasm yuklashga ruxsat (MAX_UPLOAD_BYTES ustidan biroz zaxira).
    client_max_body_size 6M;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade           $http_upgrade;
        proxy_set_header Connection        "upgrade";
    }
}
```

Bitta `location /` yetarli — SPA uchun qayta yozish qoidasi kerak emas.
Backend o'zi tanimagan har qanday yo'l uchun `index.html` ga qaytadi, shuning
uchun `/docs/<id>/edit` kabi chuqur havola mijoz routeriga yetib boradi. Bu
yerga `try_files` qo'shish faqat uning oldiga ikkinchi, raqobatlashuvchi
router qo'yardi. Uni yoqing:

```sh
sudo ln -s /etc/nginx/sites-available/portal /etc/nginx/sites-enabled/portal
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

## 9. Let's Encrypt bilan HTTPS

Avval `kb.example.com` DNS ni serverga yo'naltiring, so'ng:

```sh
sudo certbot --nginx -d kb.example.com
```

Certbot `443` blokini va HTTP→HTTPS yo'naltirishini qo'shadi hamda yangilash
taymerini o'rnatadi. `portal.env` dagi `SECURE_COOKIE=1` tufayli endi cookie lar
faqat HTTPS orqali oqadi.

## 10. Fayrvol

```sh
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

`3000` (ilova) va `5432` (Postgres) portlari loopback ga bog'langan holicha
qoladi va tashqariga ochilmaydi.

## 11. Birinchi kirish

`https://kb.example.com/login` ni oching, urug' admin sifatida kiring, so'ng:

- **avval** `/categories` da kategoriyalar yarating — chunki ruxsatlar
  kategoriya bo'yicha beriladi va ular yo'q ekan, beradigan narsa yo'q;
- `/admin/users` ga o'ting va haqiqiy foydalanuvchilarni yarating, ular kirishi
  kerak bo'lgan har bir kategoriyada O'qish/Yozish/Tahrir/O'chirish katakchalarini
  belgilang. Grantsiz yangi admin bo'lmagan foydalanuvchi tizimga kirib, bo'sh
  platformani ko'radi;
- admin parolini tiklang yoki almashtiring.

---

## Yangilash / qayta joylashtirish

```sh
cd ~/portal && git pull
(cd frontend && npm ci && npm run build)
(cd backend && cargo build --release)
sudo systemctl stop portal
sudo install -m755 backend/target/release/portal /opt/portal/portal
sudo rm -rf /opt/portal/static && sudo cp -r frontend/dist /opt/portal/static
sudo chown -R portal:portal /opt/portal/static /opt/portal/portal
sudo systemctl start portal
```

`backend/migrations/` dagi yangi migratsiyalar ishga tushishda avtomatik qo'llanadi.

> **Qayta ishga tushirishda sessiyalar nolga tushadi.** Ilova xotiradagi sessiya
> omborini ishlatadi, shuning uchun har bir qayta joylashtirish foydalanuvchilarni
> tizimdan chiqaradi. Bitta nusxa uchun bu joiz; sessiyalarni saqlash (va bir
> nechta nusxa ishlatish) uchun Postgres asosidagi omborga o'ting —
> [B ilovasi](#b-ilovasi--doimiy-sessiyalar-ishlab-chiqarish-uchun-tavsiya-etiladi).

## Zaxira nusxalar

Ma'lumotlar bazasi (har kecha, 14 kun saqlanadi):

```sh
sudo -u postgres sh -c 'pg_dump portal | gzip > /var/backups/portal-$(date +\%F).sql.gz'
```

Yuklangan rasmlar `/opt/portal/uploads` da yashaydi — o'sha katalogni ham zaxira
qiling (masalan, `rsync`/`restic`). Ikkalasini cron yoki systemd taymeriga
qo'shing.

---

## A ilovasi — boshqa mashinada qurish

3-qadamdagi o'sha toolchain bilan istalgan Linux mashinada (yoki CI da) quring,
so'ng faqat ikkita artefaktni ko'chiring. Ikkilik fayl glibc/OpenSSL ga
dinamik bog'langan, shuning uchun serverdagidan **bir xil yoki eskiroq** glibc li
OS da quring (bir xil Ubuntu relizida qurish eng xavfsizi).

```sh
(cd frontend && npm ci && npm run build)
(cd backend && cargo build --release)
scp backend/target/release/portal  user@server:/tmp/portal
rsync -a --delete frontend/dist/   user@server:/tmp/static/
```

Serverda ularni 5-qadamdagidek joyiga qo'ying va xizmatni qayta ishga tushiring.
To'liq statik ikkilik fayl uchun `x86_64-unknown-linux-musl` uchun qurishingiz
mumkin — bu glibc versiyalari nomuvofiqligini yo'q qiladi.

## B ilovasi — doimiy sessiyalar (ishlab chiqarish uchun tavsiya etiladi)

Xotiradagi omborni SQLx Postgres ombori bilan almashtiring, shunda sessiyalar
qayta ishga tushirishlardan omon qoladi va bir nechta nusxa o'rtasida
bo'lishilishi mumkin.

1. `backend/Cargo.toml` ga bog'liqlikni qo'shing:

   ```toml
   tower-sessions-sqlx-store = { version = "0.14", features = ["postgres"] }
   ```

2. `backend/src/main.rs` da `MemoryStore` ni Postgres ombori bilan
   almashtiring va ishga tushishda uning migratsiyasini bir marta bajaring:

   ```rust
   use tower_sessions_sqlx_store::PostgresStore;

   let session_store = PostgresStore::new(state.pool.clone());
   session_store.migrate().await.expect("session store migrate");
   let session_layer = SessionManagerLayer::new(session_store)
       .with_http_only(true)
       .with_same_site(SameSite::Lax)
       // Still from the environment — do not hardcode it here either.
       .with_secure(config.secure_cookie);
   ```

3. Qayta quring va qayta joylashtiring.

## C ilovasi — Docker

Repozitoriyda ko'p bosqichli `Dockerfile` (Rust builder → `bookworm-slim`
runtime, root bo'lmagan foydalanuvchi, `/app/uploads` volume sifatida) va uni
PostgreSQL bilan juftlaydigan `docker-compose.yml` bor. Xostda Rust toolchain
umuman kerak emas, 3-qadamdagi versiya pinlari esa tasvir ichidagi build
argumentlari, shuning uchun ular qo'lda o'rnatganingizdan ajralib keta olmaydi.

```sh
docker compose up --build -d
docker compose logs -f app
```

Sozlash butunlay standart qiymatli `PORTAL_*` o'zgaruvchilari orqali — kamida
quyidagilarni bering:

```sh
PORTAL_DB_PASSWORD=… PORTAL_ADMIN_PASSWORD=… docker compose up -d
```

Compose loyihaning `.env` faylini ataylab hech qachon o'qimaydi (undagi
qiymatlar 5433-portdagi mahalliy dev klasteriga ishora qiladi va konteyner
ichida noto'g'ri bo'lardi) — o'zgaruvchilar shuning uchun `PORTAL_*` prefiksiga
ega. Holatni ikkita nomli volume ushlab turadi: `pgdata` va `uploads`.
`docker compose down -v` ikkalasini ham o'chiradi.

Buni nginx va TLS ortiga qo'yish uchun 8–10 qadamlarni saqlab qoling va ilovani
faqat loopback da e'lon qiling:

```yaml
    ports:
      - "127.0.0.1:3000:3000"
```

Konteyner ichkarida `0.0.0.0:3000` ga bog'lanadi — konteyner ichidagi loopback
bog'lanishiga xostdan yetib bo'lmaydi — shuning uchun uni `BIND_ADDR` bilan
emas, e'lon qilish qadamida cheklang. `Secure` cookie lar uchun esa
`PORTAL_SECURE_COOKIE=1` ni bering — qayta qurish shart emas, u ishga
tushishda muhitdan o'qiladi.

## Nosozliklarni bartaraf etish

| Alomat | Sabab / yechim |
|---|---|
| Xizmat darhol chiqib ketadi, logda: `DATABASE_URL must be set` | `portal.env` yo'q/o'qib bo'lmaydi yoki `EnvironmentFile` yo'li noto'g'ri. |
| Xizmat darhol chiqib ketadi, logda: `could not create the uploads directory` | `UPLOADS_DIR` ga `portal` foydalanuvchisi yoza olmaydi yoki u systemd ning `ReadWritePaths` ida yo'q. |
| `failed to connect to Postgres` / `PoolTimedOut` | Noto'g'ri `DATABASE_URL`, rol/parol, yoki Postgres boshqa portni tinglayapti. Tekshiring: `psql "$DATABASE_URL" -c '\q'`. |
| Bo'sh sahifa; logda `no frontend build at 'static'` | `frontend/dist` `/opt/portal/static` ga ko'chirilmagan, yoki `STATIC_DIR`/`WorkingDirectory` bir-biriga mos emas. |
| Sahifa ochiladi, lekin har bir so'rov 401 qaytaradi va kirish ishlamaydi | Sayt oddiy HTTP orqali berilayotganda `SECURE_COOKIE=1` qo'yilgan — brauzer cookie ni qabul qiladi, lekin hech qachon qaytarib yubormaydi. Yo TLS ni yakunlang, yo uni o'chiring. |
| Frontend qurilishi `.ts`/`.tsx` da sintaksis xatosi bilan tushadi | Node juda eski. `node --version` v20+ bo'lishi kerak; Ubuntu 22.04 da standart 12. |
| Frontend so'rovi JSON o'rniga HTML qaytaradi | nginx `/api/*` yo'lini o'zi javoblayapti. Proksi bloki faqat SPA marshrutlarini emas, `/` ni qoplashi kerak. |
| Yuklamalar 413 bilan tushadi | nginx `client_max_body_size` ni (va `MAX_UPLOAD_BYTES` ni) oshiring. |
| Har bir joylashtirishdan keyin tizimdan chiqib ketish | Xotiradagi ombor bilan bu kutilgan holat — B ilovasiga qarang. |
| Foydalanuvchi kiradi, lekin umuman hech narsa ko'rmaydi | Unda kategoriya grantlari yo'q. Kirish faqat `/admin/users` dagi matritsadan keladi; global ruxsat bayroqlari mavjud emas. |
