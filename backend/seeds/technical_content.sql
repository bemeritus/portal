-- Boshlang'ich texnik kontent: 6 kategoriya, har birida 3 ta hujjat.
--
-- Bu migratsiya emas — ma'lumot (seed). Migratsiyalar sxemani o'zgartiradi va
-- server har ishga tushganda ularni qo'llaydi; bu fayl esa faqat qo'lda,
-- `just seed` bilan ishga tushiriladi.
--
-- Qayta ishga tushirsa bo'ladi: kategoriyalar `slug` bo'yicha ON CONFLICT
-- bilan, hujjatlar esa (sarlavha, kategoriya) juftligi bo'yicha tekshiriladi,
-- shuning uchun ikkinchi marta ishlatganda nusxa hosil bo'lmaydi.
--
-- Muallif sifatida eng birinchi admin foydalanuvchi olinadi — ya'ni server
-- kamida bir marta ishga tushgan va seed admin yaratilgan bo'lishi kerak.

BEGIN;

-- Hujjatni bitta chaqiruv bilan yozadigan yordamchi. `pg_temp` sxemasida,
-- shuning uchun sessiya tugashi bilan o'zi yo'qoladi.
CREATE FUNCTION pg_temp.seed_doc(cat_slug text, doc_title text, qa text[][])
RETURNS void LANGUAGE plpgsql AS $fn$
DECLARE
    cat    uuid;
    author uuid;
    doc    uuid;
    i      int;
BEGIN
    SELECT id INTO cat FROM categories WHERE slug = cat_slug;
    IF cat IS NULL THEN
        RAISE EXCEPTION 'kategoriya topilmadi: %', cat_slug;
    END IF;

    SELECT id INTO author FROM users WHERE is_admin ORDER BY created_at LIMIT 1;
    IF author IS NULL THEN
        RAISE EXCEPTION 'admin foydalanuvchi yo''q — serverni bir marta ishga tushiring';
    END IF;

    IF EXISTS (SELECT 1 FROM documents d WHERE d.title = doc_title AND d.category_id = cat) THEN
        RAISE NOTICE 'o''tkazib yuborildi (allaqachon bor): %', doc_title;
        RETURN;
    END IF;

    INSERT INTO documents (title, category_id, author_id, status)
    VALUES (doc_title, cat, author, 'published')
    RETURNING id INTO doc;

    FOR i IN 1 .. array_length(qa, 1) LOOP
        INSERT INTO qa_blocks (document_id, question, answer, position)
        VALUES (doc, qa[i][1], qa[i][2], i - 1);
    END LOOP;
END;
$fn$;

INSERT INTO categories (name, slug) VALUES
    ('Linux va server administratsiyasi', 'linux-server'),
    ('Tarmoq asoslari',                   'tarmoq'),
    ('Docker va konteynerlar',            'docker'),
    ('PostgreSQL va ma''lumotlar bazasi', 'postgresql'),
    ('Xavfsizlik',                        'xavfsizlik'),
    ('Git va CI/CD',                      'git-cicd')
ON CONFLICT (slug) DO NOTHING;


-- 1. Linux va server administratsiyasi ---------------------------------------

SELECT pg_temp.seed_doc('linux-server', 'Yangi Linux serverni birinchi marta sozlash', ARRAY[
[$q$Serverni olgandan keyin eng birinchi nima qilish kerak?$q$,
$a$Tartib muhim: avval kirishni mustahkamlang, keyingina xizmatlarni o'rnatasiz. Minimal ro'yxat:

1. **Tizimni yangilang** — `apt update && apt full-upgrade` (yoki `dnf upgrade`). Yangi image ham ko'pincha bir necha hafta eski bo'ladi.
2. **O'zingizga alohida foydalanuvchi yarating** va unga `sudo` bering. `root` bilan kundalik ish qilmaslik kerak.
3. **SSH kalitini qo'ying**, kalit bilan kirishni sinab ko'ring, *keyin* parol bilan kirishni o'chiring.
4. **Firewall yoqing** va faqat kerakli portlarni ochiq qoldiring (odatda 22, 80, 443).
5. **Vaqt zonasi va NTP** — loglar bir-biriga to'g'ri kelishi uchun.
6. **Hostname va `/etc/hosts`** ni to'g'rilang, aks holda `sudo` har chaqirilganda sekinlashadi.

Muhim nuqta: 3-qadamni 2-qadamdan oldin bajarib qo'ymang. Parol bilan kirishni o'chirib, keyin kalit ishlamasligi aniqlansa, serverga faqat provayderning konsoli (VNC/rescue) orqali kirasiz.$a$],

[$q$Yangi foydalanuvchini qanday yarataman va unga sudo beraman?$q$,
$a$Debian/Ubuntu uchun:

```bash
adduser deploy                 # parol va ism so'raydi
usermod -aG sudo deploy         # RHEL/Rocky’da guruh nomi — wheel
```

SSH kalitini o'sha foydalanuvchiga ko'chirish (mahalliy mashinadan):

```bash
ssh-copy-id deploy@203.0.113.10
```

Qo'lda qilsa:

```bash
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
install -m 600 -o deploy -g deploy /dev/null /home/deploy/.ssh/authorized_keys
# ochiq kalitni (id_ed25519.pub) shu faylga qo'shing
```

Ruxsatlar aniq shunday bo'lishi kerak: `.ssh` — `700`, `authorized_keys` — `600`. SSH server juda qattiq tekshiradi va ruxsat kengroq bo'lsa kalitni **jimgina** rad etadi. Shuning uchun "kalit ishlamayapti" muammosining eng ko'p tarqalgan sababi — noto'g'ri ruxsat yoki egasi.

Sudo'ni parol so'ramaydigan qilib qo'yish (`NOPASSWD`) faqat avtomatlashtirish akkauntlari uchun o'rinli, odam ishlatadigan akkaunt uchun emas.$a$],

[$q$Firewall'ni qanday sozlayman?$q$,
$a$Ubuntu/Debian — `ufw` eng oddiyi:

```bash
ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH          # yoki: ufw allow 22/tcp
ufw allow 80,443/tcp
ufw enable
ufw status verbose
```

RHEL oilasida `firewalld`:

```bash
firewall-cmd --permanent --add-service=ssh
firewall-cmd --permanent --add-service=https
firewall-cmd --reload
```

Ikki narsani yodda tuting:

- **SSH qoidasini `enable`dan oldin qo'shing.** Aksi bo'lsa o'z sessiyangizni uzasiz.
- **Docker `ufw`ni chetlab o'tadi.** `-p 5432:5432` bilan ochilgan port `ufw deny` bo'lsa ham tashqaridan ko'rinadi, chunki Docker qoidalarni `nat` jadvaliga, `ufw` zanjirlaridan oldin yozadi. Ma'lumotlar bazasini faqat localhost'ga bog'lang: `-p 127.0.0.1:5432:5432`.

Provayderda alohida tashqi firewall (security group) bo'lsa, ikkisini ham bir xil holatda saqlang — aks holda "port ochiq, lekin ulanmaydi" degan chalkashlik chiqadi.$a$],

[$q$Vaqt zonasi, locale va hostname'ni qanday to'g'rilayman?$q$,
$a$```bash
timedatectl set-timezone Asia/Tashkent
timedatectl status                  # NTP sinxron ekanini tekshiring

localectl set-locale LANG=en_US.UTF-8   # serverda UTF-8 bo'lishi shart
hostnamectl set-hostname portal-prod-1
```

`hostnamectl` dan keyin `/etc/hosts`ga ham qo'shib qo'ying:

```
127.0.0.1   localhost
127.0.1.1   portal-prod-1
```

Nega kerak? `sudo` har chaqirilganda hostname'ni hal qilishga urinadi; `/etc/hosts`da yozuv bo'lmasa DNS'ni kutadi va har bir `sudo` bir necha soniya osiladi.

Serverlarni UTC'da saqlash ham keng tarqalgan amaliyot — bir nechta regionda server bo'lsa, loglarni solishtirish osonlashadi. Bitta server bo'lsa, mahalliy zona ham qulay.$a$],

[$q$Xavfsizlik yangilanishlarini avtomatlashtirish kerakmi?$q$,
$a$Ha, lekin faqat xavfsizlik yangilanishlarini. Debian/Ubuntu:

```bash
apt install unattended-upgrades
dpkg-reconfigure -plow unattended-upgrades
```

`/etc/apt/apt.conf.d/50unattended-upgrades` ichida:

```
Unattended-Upgrade::Allowed-Origins {
    "${distro_id}:${distro_codename}-security";
};
Unattended-Upgrade::Automatic-Reboot "false";
```

`Automatic-Reboot`ni `false` qoldirish tavsiya qilinadi: yadro yangilanishi reboot talab qilsa, buni o'zingiz tanlagan vaqtda qiling. Reboot kerak-kermasligini `needrestart -r l` yoki `/var/run/reboot-required` fayli ko'rsatadi.

To'liq `full-upgrade`ni avtomatlashtirmaslik kerak — u major versiya o'zgarishlarini ham tortib keladi va ilovangiz bog'liqliklarini buzishi mumkin.$a$],

[$q$Server to'g'ri sozlanganini qanday tekshiraman?$q$,
$a$Qisqa tekshiruv ro'yxati:

```bash
ss -ltnp                   # qaysi xizmat qaysi portni tinglayapti
systemctl --failed         # ishga tushmagan unitlar
journalctl -p err -b       # shu bootdagi xatolar
ufw status verbose         # firewall holati
df -h && free -h           # joy va xotira
who && last -n 10          # kim kirgan
```

`ss -ltnp` natijasini diqqat bilan ko'ring: `0.0.0.0:*` degan qator xizmat butun internetga ochiq ekanini bildiradi. Ma'lumotlar bazasi, Redis, ichki admin panellari `127.0.0.1` da turishi kerak.

Tashqaridan ko'rinishini mustaqil tekshirish uchun boshqa mashinadan `nmap -Pn 203.0.113.10` yoki portalning port tekshirish vositasidan foydalanish mumkin — serverning o'zidan qilingan tekshiruv firewall'ni ko'rsatmaydi.$a$]
]);

SELECT pg_temp.seed_doc('linux-server', 'systemd: xizmatlar, loglar va timerlar', ARRAY[
[$q$systemd unit fayli nima va qayerda turadi?$q$,
$a$Unit fayl — systemd'ga "bu xizmatni qanday ishga tushirish, qanday to'xtatish va nosozlikda nima qilish" ni aytadigan ini formatidagi matn.

Joylar muhim:

| Yo'l | Kim uchun |
| --- | --- |
| `/lib/systemd/system/` | paket menejeri qo'ygan unitlar — qo'l tegizmaslik kerak |
| `/etc/systemd/system/` | administrator yozgan unitlar; bir xil nomda bo'lsa ustun turadi |
| `/etc/systemd/system/foo.service.d/*.conf` | mavjud unitni to'liq nusxalamasdan qisman o'zgartirish |

Paket unitini o'zgartirish kerak bo'lsa `systemctl edit foo` ishlatiladi — u `override.conf` yaratadi, paket yangilanganda o'zgarishingiz yo'qolmaydi.

Har qanday o'zgarishdan keyin `systemctl daemon-reload` shart, aks holda systemd eski nusxani ushlab turadi.$a$],

[$q$Oddiy ilova uchun xizmat qanday yozaman?$q$,
$a$`/etc/systemd/system/portal.service`:

```ini
[Unit]
Description=Portal API
After=network-online.target postgresql.service
Wants=network-online.target

[Service]
Type=simple
User=deploy
Group=deploy
WorkingDirectory=/srv/portal
EnvironmentFile=/etc/portal.env
ExecStart=/srv/portal/portal
Restart=on-failure
RestartSec=5s
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/srv/portal/uploads

[Install]
WantedBy=multi-user.target
```

Diqqat qiladigan joylar:

- **`User=`** — hech qachon root'da ishlatmang, agar 80-portni egallamasa (u holda ham reverse proxy ishlatish to'g'riroq).
- **`EnvironmentFile=`** — sirlarni unit faylga yozmang; `0600` ruxsatli alohida fayl qiling.
- **`ProtectSystem=strict`** butun fayl tizimini faqat o'qishga qo'yadi; yozish kerak bo'lgan kataloglarni `ReadWritePaths` bilan ochasiz.

Ishga tushirish:

```bash
systemctl daemon-reload
systemctl enable --now portal
systemctl status portal
```$a$],

[$q$`enable` va `start` o'rtasida qanday farq bor?$q$,
$a$- `start` — **hozir** ishga tushiradi. Reboot'dan keyin o'z-o'zidan ko'tarilmaydi.
- `enable` — **boot vaqtida** ishga tushadigan qilib belgilaydi (symlink yaratadi). Hozir hech narsa qilmaydi.
- `enable --now` — ikkisini birga.

Shu yerda eng ko'p uchraydigan nosozlik: xizmat `start` qilingan, ishlayapti, hamma narsa yaxshi — keyin server qayta ishga tushadi va xizmat yo'q. Deploy'dan keyin `systemctl is-enabled portal` bilan tekshirib qo'yish arzon sug'urta.

Yana ikki buyruq foydali:

- `systemctl mask foo` — xizmatni *umuman* ishga tushmaydigan qiladi (hatto boshqa unit so'rasa ham). Konfliktdagi paketni to'xtatish uchun.
- `systemctl reload foo` — jarayonni o'ldirmasdan konfiguratsiyani qayta o'qitadi, agar unit `ExecReload` ni e'lon qilgan bo'lsa (nginx, postgresql).$a$],

[$q$Loglarni journalctl bilan qanday o'qiyman?$q$,
$a$Eng ko'p ishlatiladiganlari:

```bash
journalctl -u portal -f                 # jonli kuzatish
journalctl -u portal -n 200 --no-pager  # oxirgi 200 qator
journalctl -u portal --since "1 hour ago"
journalctl -u portal -p err             # faqat xatolar
journalctl -b -1                        # oldingi bootdagi loglar
journalctl -u portal -o json-pretty     # metadata bilan
```

`-p` darajalari: `emerg`, `alert`, `crit`, `err`, `warning`, `notice`, `info`, `debug`.

Nosozlik qidirayotganda eng foydali kombinatsiya — `journalctl -b -p warning` : shu bootdagi barcha xizmatlarning ogohlantirish va xatolari vaqt bo'yicha aralash chiqadi, shunda "nima birinchi buzildi" ko'rinadi.

Loglar reboot'dan keyin saqlanmayotgan bo'lsa, doimiy jurnal yoqilmagan:

```bash
mkdir -p /var/log/journal && systemd-tmpfiles --create --prefix /var/log/journal
journalctl --disk-usage
journalctl --vacuum-time=30d
```$a$],

[$q$Xizmat qayta-qayta o'chib-yonayotgan bo'lsa nima qilaman?$q$,
$a$Avval `Restart=` siyosatini tushunish kerak:

- `no` — hech qachon qayta ishga tushirmaydi (standart).
- `on-failure` — nolga teng bo'lmagan exit kod, signal yoki timeout'da. Ko'p hollarda to'g'ri tanlov.
- `always` — hatto toza chiqishda ham. Doimiy ishlashi kerak bo'lgan demonlar uchun.

Agar ilova darhol yiqilsa, systemd uni uzluksiz qayta ishga tushirmasligi uchun chegara bor: `StartLimitIntervalSec=10s` ichida `StartLimitBurst=5` marta. Chegaradan o'tgandan keyin unit `failed` holatda qoladi va:

```bash
systemctl reset-failed portal
```

kerak bo'ladi. Shuning uchun `RestartSec=5s` qo'yish foydali — zudlik bilan emas, pauza bilan urinadi.

Sababni topish:

```bash
systemctl status portal          # oxirgi exit kodi va bir necha log qatori
journalctl -u portal -n 50       # haqiqiy xato matni
systemd-analyze verify /etc/systemd/system/portal.service
```

Eng ko'p sabablar: `ExecStart`da noto'g'ri yo'l, `EnvironmentFile` yo'q, ishchi katalogga ruxsat yo'q, yoki port allaqachon band.$a$],

[$q$cron o'rniga systemd timer ishlatish kerakmi?$q$,
$a$Ko'p hollarda ha. Timer ikki fayldan iborat — `backup.service` (nima qilish) va `backup.timer` (qachon):

```ini
# backup.timer
[Unit]
Description=Kunlik baza zaxirasi

[Timer]
OnCalendar=daily
RandomizedDelaySec=15m
Persistent=true

[Install]
WantedBy=timers.target
```

```bash
systemctl enable --now backup.timer
systemctl list-timers --all
```

Timer'ning cron'dan ustunligi:

- Loglar `journalctl -u backup` da — cron'dagidek mail yoki `>> /var/log/...` bilan o'ynash shart emas.
- `Persistent=true` — server o'chiq bo'lgan vaqtdagi o'tkazib yuborilgan ishni keyin bajaradi.
- Bir xil muhit, bir xil `User=`, resurs cheklovlari (`MemoryMax=`) qo'llanadi.
- Bir vaqtda ikki nusxa ishga tushmaydi.

cron'ning afzalligi — bitta qator va hamma joyda bor. Oddiy, kamdan-kam ishlaydigan vazifa uchun cron ham mutlaqo yetarli.$a$]
]);

SELECT pg_temp.seed_doc('linux-server', 'Serverni diagnostika qilish: disk, xotira, CPU', ARRAY[
[$q$Disk to'lib qolgan — joyni qanday bo'shataman?$q$,
$a$Avval qayerda ekanini aniqlang:

```bash
df -h                                  # qaysi bo'lim to'lgan
du -xh --max-depth=1 / | sort -h       # yuqoridan pastga kazish
du -xh --max-depth=1 /var | sort -h
```

`-x` muhim: u boshqa fayl tizimlariga (`/proc`, tashqi disklar) o'tib ketmaydi.

Eng ko'p uchraydigan aybdorlar:

```bash
journalctl --vacuum-size=500M     # systemd jurnali
apt clean                         # /var/cache/apt
docker system prune -a --volumes  # DIQQAT: ishlatilmayotgan volume'lar ham o'chadi
find /var/log -type f -size +100M
```

Alohida tuzoq: **o'chirilgan, lekin hali ochiq fayllar**. `du` ularni ko'rmaydi, `df` esa joy band deb ko'rsatadi:

```bash
lsof +L1       # link soni 0 bo'lgan ochiq fayllar
```

Bunda joyni bo'shatish uchun shu faylni ushlab turgan jarayonni qayta ishga tushirish kerak (odatda log faylini rotatsiyadan keyin qo'yib yubormagan xizmat).$a$],

[$q$`df` joy bor deydi, lekin "No space left on device" chiqayapti?$q$,
$a$Ikki sabab bo'lishi mumkin.

**1. Inode tugagan.** Har bir fayl bitta inode egallaydi; millionlab kichik fayl (sessiya, kesh, mayda loglar) joyni emas, inode'ni tugatadi:

```bash
df -i
find /var/cache -xdev -type f | wc -l
```

Yechim — keraksiz kichik fayllarni o'chirish. Fayl tizimi yaratilgandan keyin inode sonini oshirib bo'lmaydi (ext4'da), shuning uchun keshni boshqa joyga olish yoki bo'limni qayta yaratish kerak bo'ladi.

**2. Rezerv bloklar.** ext4 odatda 5% ni root uchun saqlaydi. Oddiy foydalanuvchi nomidan ishlayotgan ilova 100% dan oldin "joy yo'q" oladi, root esa hali yozishi mumkin. `tune2fs -m 1 /dev/sda1` rezervni 1% ga tushiradi — vaqtincha chora, asosiy yechim emas.

Uchinchi, kamroq uchraydigan holat — mount nuqtasi ustiga yozish: xizmat `/mnt/data` ga yozayotgan, lekin disk mount qilinmagan, shuning uchun fayllar root diskka tushib uni to'ldirgan.$a$],

[$q$Xotira tugayapti — kim yeyayotganini qanday bilaman?$q$,
$a$```bash
free -h
ps aux --sort=-%mem | head -15
smem -rs pss 2>/dev/null | head   # agar o'rnatilgan bo'lsa, aniqroq
```

`free -h` dagi `available` ustuniga qarang, `free` ga emas. Linux bo'sh xotirani kesh uchun ishlatadi — bu normal va kesh kerak bo'lganda darhol qaytariladi.

OOM killer ishlaganini tekshirish:

```bash
journalctl -k | grep -i "killed process"
dmesg -T | grep -i oom
```

Agar ilova OOM'dan o'lsa, variantlar: xotira chegarasini oshirish, ilovadagi sizib ketishni topish, yoki vaqtinchalik chora sifatida swap qo'shish:

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile
mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
```

Swap — ishlab chiqarish muammosini yashiradi, lekin OOM'dan ko'ra sekin ishlash yaxshiroq. Ma'lumotlar bazasi serverida esa swap'ga tushish deyarli har doim muammo belgisi: `vm.swappiness=10` qo'yib, xotirani yetarli qilish to'g'riroq.$a$],

[$q$Load average qanday o'qiladi?$q$,
$a$`uptime` yoki `top` uchta son beradi — 1, 5 va 15 daqiqalik o'rtacha. Bu **ishlayotgan yoki kutayotgan** jarayonlar soni, foiz emas.

Asosiy qoida: sonni yadrolar soniga bo'ling.

```bash
nproc           # yadrolar soni
uptime
```

4 yadroda `load 4.0` — to'liq band, lekin navbat yo'q. `load 8.0` — ish yarmini kutib turibdi. 1 yadroda `load 4.0` esa jiddiy ortiqcha yuklanish.

Muhim nuans: Linux'da load average'ga **I/O kutayotgan** jarayonlar ham kiradi. Shuning uchun CPU bo'sh bo'lsa ham load yuqori bo'lishi mumkin — bu disk yoki tarmoq kutilayotganini bildiradi. Farqini `top` dagi CPU qatoridan ko'rasiz:

- `%us` yuqori — ilova hisob-kitob qilayapti.
- `%sy` yuqori — yadro ishi ko'p (ko'p syscall, tarmoq).
- `%wa` yuqori — disk kutilayapti.
- `%st` (steal) yuqori — VPS'da qo'shningiz CPU'ni olib qo'yayapti; bu sizning kodingiz emas, provayderning muammosi.

Uchta sonni solishtirish trend beradi: 1-daqiqa 15-daqiqadan katta bo'lsa yuklanish o'sayapti, kichik bo'lsa tushayapti.$a$],

[$q$Qaysi jarayon CPU yoki diskni yuklayotganini qanday topaman?$q$,
$a$CPU uchun:

```bash
top -o %CPU            # yoki htop — interaktiv
ps aux --sort=-%cpu | head
pidstat 1 5            # vaqt bo'yicha o'rtacha, bir martalik to'lqinlarni filtrlaydi
```

Disk uchun:

```bash
iostat -xz 1           # qurilma bo'yicha: %util, await
iotop -ao              # jarayon bo'yicha jamlangan o'qish/yozish
```

`iostat` da `%util` 100% ga yaqin va `await` o'sayotgan bo'lsa — disk to'yingan (bottleneck).

Aniq jarayon nima kutayotganini bilish uchun:

```bash
cat /proc/<pid>/status | grep -i state
cat /proc/<pid>/wchan      # yadroda qaysi funksiyada kutayapti
strace -c -p <pid>         # syscall statistikasi (ehtiyot bo'lib, sekinlashtiradi)
```

Ishlab chiqarish serverida `strace`ni uzoq ushlab turmaslik kerak — jarayonni sezilarli sekinlashtiradi.$a$],

[$q$Nosozlikni keyinroq tahlil qilish uchun nimani yozib qo'yish kerak?$q$,
$a$Muammo paytida yig'ilgan ma'lumot keyin bebaho bo'ladi, chunki holat o'tib ketadi. Minimal "snapshot":

```bash
ts=$(date +%F-%H%M); out=/tmp/diag-$ts; mkdir -p $out
uptime            > $out/uptime
free -h           > $out/free
df -h             > $out/df
df -i             > $out/df-inode
ps auxf           > $out/ps
ss -ltnp          > $out/ports
ss -s             > $out/socket-summary
top -b -n1        > $out/top
dmesg -T | tail -200 > $out/dmesg
journalctl -p warning -b --no-pager > $out/journal
tar czf $out.tar.gz -C /tmp diag-$ts
```

Uzoq muddatga esa doimiy metrika kerak: `node_exporter` + Prometheus, yoki hech bo'lmasa `sysstat` paketini yoqib qo'yish (`sar -u -f /var/log/sysstat/sa15`) — u har 10 daqiqada CPU, xotira, disk va tarmoqni yozib boradi va "kecha soat 3 da nima bo'ldi" degan savolga javob beradi.$a$]
]);



-- 2. Tarmoq asoslari ---------------------------------------------------------

SELECT pg_temp.seed_doc('tarmoq', 'DNS qanday ishlaydi va qanday tekshiriladi', ARRAY[
[$q$DNS so'rovi aslida qanday yo'l bosib o'tadi?$q$,
$a$Brauzer `portal.example.uz` ni so'raganda:

1. **Mahalliy kesh** — brauzer keshi, so'ng OS keshi (`systemd-resolved`, `nscd`), so'ng `/etc/hosts`. Ko'p "DNS o'zgarmayapti" holatlari shu yerda tugaydi.
2. **Resolver** (ISP yoki 1.1.1.1 / 8.8.8.8) — o'z keshida bormi, deb qaraydi.
3. Bo'lmasa **root serverlar** dan `.uz` zonasini kim boshqarishini so'raydi.
4. `.uz` TLD serveri `example.uz` ning **nameserver**larini qaytaradi.
5. O'sha authoritative nameserver oxirgi javobni — IP manzilni beradi.
6. Resolver javobni **TTL** muddatiga keshlaydi va sizga uzatadi.

Ya'ni siz domen yozuvini o'zgartirganda, authoritative server darhol yangi javob beradi, lekin oradagi resolverlar eski javobni TTL tugaguncha ushlab turadi. Shu sababli o'zgartirish "hammaga" bir vaqtda ko'rinmaydi.$a$],

[$q$Asosiy DNS yozuv turlari qanday farq qiladi?$q$,
$a$| Tur | Nimani ko'rsatadi | Odatiy ishlatilishi |
| --- | --- | --- |
| `A` | IPv4 manzil | `portal.example.uz → 203.0.113.10` |
| `AAAA` | IPv6 manzil | IPv6 bo'lsa, `A` bilan birga qo'yiladi |
| `CNAME` | boshqa **nomga** taxallus | `www → portal.example.uz` |
| `MX` | pochta serveri + prioritet | elektron pochta qabul qilish |
| `TXT` | ixtiyoriy matn | SPF, DKIM, domen egaligini tasdiqlash |
| `NS` | zonani boshqaruvchi serverlar | registrator panelida ko'rsatiladi |
| `CAA` | qaysi CA sertifikat bera oladi | Let's Encrypt'ni cheklab qo'yish |
| `SRV` | xizmat + port | XMPP, SIP, Minecraft va h.k. |

`CNAME` bilan ikki qoida bor: zonaning **ildizida** (`example.uz` ning o'zida) `CNAME` qo'yib bo'lmaydi — buning uchun provayderlar `ALIAS`/`ANAME` degan nostandart yozuv taklif qiladi. Hamda `CNAME` boshqa hech qanday yozuv bilan bir nomda birga tura olmaydi.$a$],

[$q$TTL nima va qancha qo'yish kerak?$q$,
$a$TTL (time to live) — resolverlar javobni necha sekund keshlashi.

Amaliy strategiya:

- **Normal holat**: 3600 (1 soat) yoki 86400 (1 kun). Kam so'rov, tez javob.
- **Migratsiya oldidan**: TTL ni 300 ga tushiring va **eski TTL o'tishini kuting** (ya'ni bir kun oldin tushirish kerak, aks holda kimdir hali eski uzun TTL bilan keshlab turgan bo'ladi).
- **Migratsiyadan keyin** barqarorlashganda yana oshirib qo'yasiz.

Shunda IP almashtirish 5 daqiqada butun dunyoga yetadi.

Kichik tuzoq: ba'zi resolverlar juda kichik TTL'ni (masalan 30) o'zining minimal qiymatiga ko'tarib qo'yadi, ba'zi ISP'lar esa TTL'ni butunlay e'tiborsiz qoldiradi. Shuning uchun nolga teng kutish vaqtini rejalashtirmang — eski server yangisiga o'tgandan keyin ham bir necha soat ishlab tursin.$a$],

[$q$dig bilan qanday tekshiraman?$q$,
$a$```bash
dig portal.example.uz                    # standart resolver orqali
dig +short portal.example.uz             # faqat javob
dig @1.1.1.1 portal.example.uz           # muayyan resolverdan
dig portal.example.uz MX                 # boshqa tur
dig +trace portal.example.uz             # root'dan boshlab butun zanjir
dig NS example.uz +short                 # zonaning nameserverlari
```

Eng muhim nayrang — **authoritative serverdan to'g'ridan-to'g'ri so'rash**, keshni chetlab o'tib:

```bash
dig @ns1.provider.com portal.example.uz
```

Agar bu yerda yangi IP ko'rinsa, lekin `dig +short portal.example.uz` eski IP bersa — o'zgarish to'g'ri qilingan, shunchaki kesh hali o'tmagan. Kutish kerak, boshqa narsani o'zgartirmang.

`dig`ning javobidagi `flags:` qatorida `aa` bo'lsa javob authoritative, bo'lmasa keshdan. `ANSWER SECTION` dagi ikkinchi ustun — qolgan TTL sekundlari, ya'ni kesh qancha vaqtdan keyin yangilanishini aniq ko'rsatadi.$a$],

[$q$O'zgarish kiritdim, lekin eski sayt ochilayapti — nima qilaman?$q$,
$a$Ketma-ket tekshiring:

1. **Authoritative javob to'g'rimi?** `dig @ns1.provider.com host.example.uz` — yo'q bo'lsa muammo DNS panelida (noto'g'ri zona, noto'g'ri subdomen, saqlanmagan o'zgarish).
2. **Mahalliy keshni tozalang.**
   ```bash
   resolvectl flush-caches        # systemd-resolved
   sudo dscacheutil -flushcache   # macOS
   ipconfig /flushdns             # Windows
   ```
   Brauzerning o'z keshi ham bor: `chrome://net-internals/#dns`.
3. **`/etc/hosts`** da qolib ketgan qator yo'qmi?
4. **Brauzer HSTS/keshi** — boshqa brauzerda yoki `curl -I https://host` bilan sinab ko'ring.
5. **Nameserverlar registratorda to'g'ri ko'rsatilganmi?** DNS panelini bir provayderda to'ldirib, registratorda boshqa NS turgan bo'lsa, o'zgarishlaringiz hech kimga ko'rinmaydi. `dig NS example.uz` buni ochib beradi.
6. **CDN/proxy** (Cloudflare kabi) o'rtada bo'lsa, DNS to'g'ri, lekin kontent proxy keshidan kelayotgan bo'lishi mumkin — u yerni alohida tozalash kerak.$a$],

[$q$Subdomenlarni qanday tashkil qilish qulay?$q$,
$a$Amaliy yondashuv — bitta `A` yozuv va qolganlari `CNAME`:

```
example.uz.          A      203.0.113.10
www                  CNAME  example.uz.
portal               CNAME  example.uz.
api                  CNAME  example.uz.
*.dev                A      203.0.113.20
```

Bunda server IP'si o'zgarsa, faqat bitta joyni tahrirlaysiz.

Wildcard (`*`) qulay, lekin ehtiyot bo'ling: u mavjud bo'lmagan subdomenlar uchun ham javob beradi, bu esa xato yozilgan nomlarni jimgina ishchi holatga o'tkazadi va fishing uchun ham ishlatilishi mumkin. Ishlab chiqarishda aniq yozuvlar afzal.

Ichki xizmatlar uchun alohida zona (`int.example.uz`) ajratib, uni faqat ichki resolverda saqlash yoki hech bo'lmasa xususiy IP'larga ko'rsatish mumkin — ammo ommaviy DNS'da xususiy IP e'lon qilish ichki tuzilmangizni ko'rsatib qo'yishini yodda tuting.$a$]
]);

SELECT pg_temp.seed_doc('tarmoq', 'TCP portlar va ulanish muammolarini topish', ARRAY[
[$q$Port nima va "tinglash" (listen) nimani bildiradi?$q$,
$a$IP manzil mashinani topadi, port esa o'sha mashinadagi aniq xizmatni. Juftlik — `IP:port` — soket deyiladi.

Xizmat ishga tushganda operatsion tizimdan portni **tinglashga** ruxsat so'raydi. Shundan keyin o'sha portga kelgan ulanishlar unga uzatiladi.

Muhim tafsilot — **qaysi manzilda** tinglayotgani:

- `0.0.0.0:3000` — barcha interfeyslarda, ya'ni tashqaridan ham ko'rinadi.
- `127.0.0.1:3000` — faqat shu mashinaning o'zidan. Ma'lumotlar bazasi va ichki xizmatlar shunday bo'lishi kerak.
- `10.0.0.5:3000` — faqat o'sha ichki interfeysda.

1024 dan kichik portlar (`80`, `443`, `22`) imtiyozli: ularni egallash uchun root yoki `CAP_NET_BIND_SERVICE` kerak. Shu sababli ilovalar 3000/8080 da ishlab, oldiga nginx yoki Caddy qo'yiladi.$a$],

[$q$Qaysi port band ekanini qanday ko'raman?$q$,
$a$```bash
ss -ltnp                    # TCP, tinglayotganlar, jarayon bilan
ss -lunp                    # UDP
ss -tnp state established   # hozirgi ulanishlar
ss -s                       # umumiy statistika
```

`ss` ustunlari: `Local Address:Port` — kim tinglayapti, `Process` — qaysi jarayon (root bo'lmasangiz ko'rinmaydi).

"Address already in use" xatosi chiqsa:

```bash
ss -ltnp 'sport = :3000'
fuser -k 3000/tcp           # oxirgi chora: portni ushlab turgan jarayonni o'ldiradi
```

Ba'zan port `TIME_WAIT` holatida bo'ladi — jarayon yo'q, lekin yadro soketni bir-ikki daqiqa ushlab turadi. Server kodida `SO_REUSEADDR` qo'yilgan bo'lsa bu muammo bo'lmaydi; aksariyat zamonaviy freymvorklar buni o'zi qiladi.

`netstat` ham ishlaydi (`netstat -tulpn`), lekin u eskirgan va ko'p distributivlarda umuman o'rnatilmagan — `ss` ni odat qilish ma'qul.$a$],

[$q$Tashqaridan port ochiqligini qanday sinab ko'raman?$q$,
$a$**Boshqa** mashinadan sinash muhim — serverning o'zidan qilingan tekshiruv firewall'ni chetlab o'tadi.

```bash
nc -vz 203.0.113.10 443          # eng toza usul
timeout 3 bash -c '</dev/tcp/203.0.113.10/443' && echo ochiq
curl -v telnet://203.0.113.10:443
nmap -Pn -p 22,80,443 203.0.113.10
```

HTTP xizmati uchun to'liq so'rov yuborish aniqroq ma'lumot beradi:

```bash
curl -sS -o /dev/null -w '%{http_code} %{time_total}s\n' https://portal.example.uz
```

`nmap` ni faqat o'zingizga tegishli yoki ruxsat berilgan tizimlarda ishlatish kerak — begona hostlarni skanerlash ko'p joyda xizmat shartlari buzilishi hisoblanadi.

Boshqa mashina bo'lmasa, portalning port tekshirish vositasi ham shu ishni qiladi: so'rov tashqi tomondan keladi, shuning uchun natija haqiqiy holatni ko'rsatadi.$a$],

[$q$"Connection refused" va "timeout" farqi nimada?$q$,
$a$Bu ikkisi butunlay boshqa muammoni ko'rsatadi va ularni ajratish diagnostikani yarim yo'lga olib boradi.

**Connection refused** — paket yetib bordi, mashina javob berdi: "bu portda hech kim yo'q" (TCP RST). Ya'ni tarmoq **ishlayapti**, firewall o'tkazdi. Sabablari:

- xizmat ishlamayapti (`systemctl status`),
- xizmat boshqa portda tinglayapti,
- xizmat `127.0.0.1` da tinglayapti, siz tashqi IP'ga urinayapsiz.

**Timeout** — javob umuman yo'q. Paket biror joyda yo'qoldi. Sabablari:

- firewall `DROP` qilayapti (server yoki provayder security group),
- noto'g'ri IP yoki marshrut,
- host o'chiq,
- oradagi NAT/router paketni tashlayapti.

**Name or service not known** — bu uchinchi holat: DNS muammosi, hali TCP'ga ham yetib bormadi.

Shunga yarasha tekshiruv: refused bo'lsa serverga kirib `ss -ltnp` ko'rasiz; timeout bo'lsa firewall qoidalari va marshrutni (`mtr`) ko'rasiz.$a$],

[$q$Marshrut va yo'qotishlarni qanday tekshiraman?$q$,
$a$```bash
ip route                  # mahalliy marshrut jadvali
ip addr                   # interfeyslar va IP'lar
ping -c 5 203.0.113.10    # yetib boradimi (ICMP bloklangan bo'lishi mumkin)
mtr -rwzbc 50 203.0.113.10   # traceroute + yo'qotish statistikasi
traceroute -T -p 443 203.0.113.10   # TCP bilan, ICMP bloklangan joylarda
```

`mtr` natijasini o'qishda eng ko'p qilinadigan xato — **o'rtadagi** hoplarda yo'qotish ko'rib xavotirga tushish. Routerlar o'zlariga qaratilgan ICMP'ga past prioritet beradi, shuning uchun o'rtada 20% yo'qotish ko'rinib, oxirgi hopda 0% bo'lishi mutlaqo normal.

Muhim bo'lgani — **oxirgi qator**. Agar manzilda yo'qotish bo'lsa, u haqiqiy. Hamda yo'qotish biror hopdan boshlanib **oxirigacha davom etsa**, muammo shu hopdan keyinda.

Yo'qotish qayerda ekanini provayderga xabar qilish uchun `mtr` natijasini ikki yo'nalishda ham (siz → server, server → siz) olish kerak, chunki marshrutlar assimetrik bo'ladi.$a$],

[$q$NAT va port forwarding nima uchun kerak?$q$,
$a$NAT (network address translation) — bir nechta ichki qurilma bitta tashqi IP orqali internetga chiqishi. Uy routeri yoki bulut VPC shlyuzi shuni qiladi.

Natijada **ichkaridan tashqariga** ulanish ishlaydi, lekin **tashqaridan ichkariga** — yo'q, chunki router kelgan paketni kimga berishni bilmaydi. Shu sababli uyda server ko'tarsangiz, u tashqaridan ko'rinmaydi.

Yechim — port forwarding: routerda "tashqi 8443 → ichki 192.168.1.50:443" qoidasini yozish.

```bash
# Linux shlyuzida qo'lda (nft bilan)
nft add rule ip nat prerouting tcp dport 8443 dnat to 192.168.1.50:443
```

Ikki qo'shimcha nuans:

- **CGNAT** — ba'zi provayderlar sizga haqiqiy tashqi IP bermaydi (IP `100.64.0.0/10` oralig'ida bo'lsa shu). Bunda port forwarding ham yordam bermaydi; statik IP so'rash yoki tunnel (WireGuard, Cloudflare Tunnel) kerak.
- **Hairpin NAT** — ichki tarmoqdan tashqi IP'ga murojaat qilish ko'p routerlarda ishlamaydi, shuning uchun "tashqaridan ishlayapti, ichkaridan yo'q" degan g'alati holat yuzaga keladi.$a$]
]);

SELECT pg_temp.seed_doc('tarmoq', 'HTTPS, TLS va sertifikatlar', ARRAY[
[$q$TLS handshake vaqtida nima sodir bo'ladi?$q$,
$a$Qisqa qilib (TLS 1.3):

1. Mijoz `ClientHello` yuboradi — qo'llab-quvvatlaydigan shifrlar, TLS versiyasi, **SNI** (qaysi domenga ulanmoqda) va kalit almashish uchun o'z ulushi.
2. Server `ServerHello` da shifrni tanlaydi, o'z sertifikatini va kalit ulushini yuboradi.
3. Mijoz sertifikatni tekshiradi: ishonchli CA tomonidan imzolanganmi, domenga mos keladimi, muddati o'tmaganmi, chaqirib olinmaganmi.
4. Ikki tomon umumiy seans kalitini hisoblaydi va shundan keyingi barcha trafik shu kalit bilan shifrlanadi.

TLS 1.3 bularni **bitta** aylanishda bajaradi (1-RTT), TLS 1.2 esa ikkita talab qilgan — shuning uchun 1.3 sezilarli tezroq.

Ko'rish uchun:

```bash
openssl s_client -connect portal.example.uz:443 -servername portal.example.uz
curl -vI https://portal.example.uz 2>&1 | grep -iE 'ssl|tls|subject|issuer'
```

Shifrlash **faqat kanalni** himoya qiladi: serverda ma'lumot ochiq holatda bo'ladi. HTTPS — ma'lumotni saqlashdagi xavfsizlikni almashtirmaydi.$a$],

[$q$Let's Encrypt sertifikatini qanday olaman?$q$,
$a$nginx bilan eng oson yo'l:

```bash
apt install certbot python3-certbot-nginx
certbot --nginx -d portal.example.uz -d www.portal.example.uz
```

certbot domen sizga tegishliligini tekshiradi (HTTP-01: `/.well-known/acme-challenge/` ga fayl qo'yib, o'zi o'qib ko'radi), sertifikat oladi va nginx konfiguratsiyasini o'zi to'g'rilaydi.

Shart: 80-port tashqaridan ochiq bo'lishi va domen shu serverga ko'rsatishi kerak.

Wildcard sertifikat (`*.example.uz`) kerak bo'lsa HTTP-01 yaramaydi, **DNS-01** kerak:

```bash
certbot certonly --manual --preferred-challenges dns -d '*.example.uz'
```

Bu holda DNS provayderining plaginini ishlatish ma'qul, aks holda har 60-90 kunda qo'lda TXT yozuv qo'yishga majbur bo'lasiz.

Caddy'da esa hech narsa sozlash kerak emas — u sertifikatni o'zi oladi va yangilaydi.$a$],

[$q$Avtomatik yangilanish ishlayotganini qanday tekshiraman?$q$,
$a$```bash
certbot renew --dry-run        # haqiqiy so'rov yubormasdan butun yo'lni sinaydi
systemctl list-timers | grep certbot
certbot certificates           # muddatlar
```

`--dry-run` muvaffaqiyatli o'tsa, haqiqiy yangilanish ham o'tadi. Muddati 30 kundan kam qolganda certbot o'zi yangilaydi; undan oldin chaqirsangiz hech narsa qilmaydi (bu normal).

Eng ko'p uchraydigan nosozlik — **yangilangan, lekin xizmat eski sertifikatni ushlab turgan**. nginx faylni ishga tushganda o'qiydi, shuning uchun reload kerak:

```
# /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh
#!/bin/sh
systemctl reload nginx
```

`chmod +x` qilib qo'yish esdan chiqmasin.

Muddat tugashini mustaqil kuzatish ham foydali, chunki yangilanish jimgina buzilib qolishi mumkin:

```bash
echo | openssl s_client -connect portal.example.uz:443 2>/dev/null \
  | openssl x509 -noout -enddate
```

Buni haftalik cron'ga qo'yib, 20 kundan kam qolsa ogohlantirish yuborish mumkin.$a$],

[$q$"Mixed content" ogohlantirishi nima?$q$,
$a$HTTPS sahifa ichida HTTP orqali resurs yuklanayotganini bildiradi. Brauzer skript va stil kabi "aktiv" resurslarni **butunlay bloklaydi**, rasm kabi "passiv" resurslarga esa ogohlantirish beradi.

Topish: brauzer konsolidagi `Mixed Content` xabarlari, yoki kodda qidirish:

```bash
grep -rn 'http://' frontend/src --include='*.tsx' --include='*.css'
```

Tuzatish — mutlaq `http://` manzillarni olib tashlash. Eng yaxshisi nisbiy yo'l (`/assets/logo.svg`) yoki `https://`. Protokolsiz `//example.com/x.js` ko'rinishi ham ishlaydi, lekin endi tavsiya etilmaydi.

Reverse proxy ortida ishlaganda yana bir manba bor: ilova o'zini HTTP'da deb o'ylab, `http://` bilan boshlanadigan absolute URL'lar generatsiya qiladi. Proxy'da `X-Forwarded-Proto` ni uzatish va ilovada shuni hisobga olish kerak:

```nginx
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
proxy_set_header Host              $host;
```$a$],

[$q$HTTP'dan HTTPS'ga qanday to'g'ri yo'naltiraman?$q$,
$a$nginx'da ikki server bloki:

```nginx
server {
    listen 80;
    server_name portal.example.uz;
    # ACME tekshiruvi 80-portda qolishi kerak
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://$host$request_uri; }
}

server {
    listen 443 ssl;
    http2 on;
    server_name portal.example.uz;

    ssl_certificate     /etc/letsencrypt/live/portal.example.uz/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/portal.example.uz/privkey.pem;

    add_header Strict-Transport-Security "max-age=31536000" always;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`301` (doimiy) ishlatilsa brauzer keyingi marta o'zi HTTPS'ga boradi.

**HSTS bilan ehtiyot bo'ling**: `max-age=31536000` bir yil davomida brauzerga "bu domenga faqat HTTPS bilan bor" deydi. Sertifikat buzilsa, foydalanuvchi saytga kira olmaydi va buni "davom etish" tugmasi bilan chetlab o'tolmaydi. Avval kichik `max-age=300` bilan sinab, keyin oshirish xavfsizroq.$a$],

[$q$Sertifikat xatolarini qanday o'qiydi kerak?$q$,
$a$Eng ko'p uchraydiganlari:

- **`unable to get local issuer certificate`** — oraliq (intermediate) sertifikat yuborilmagan. Serverda `cert.pem` emas, **`fullchain.pem`** ko'rsatilishi kerak. Brauzerda ishlab, `curl` yoki mobil ilovada ishlamasligi — aynan shu belgi, chunki brauzerlar yetishmayotgan zvenoni o'zi topib oladi.
- **`certificate has expired`** — yangilanish buzilgan. `certbot certificates` va deploy hook'ni tekshiring.
- **`Hostname mismatch`** — sertifikat boshqa domenga berilgan, yoki `www` versiyasi kiritilmagan. `openssl x509 -noout -text | grep -A1 'Subject Alternative Name'` bilan ko'ring.
- **`self signed certificate`** — reverse proxy noto'g'ri backendga tushgan, yoki haqiqatan o'z-o'zini imzolagan sertifikat ishlatilayapti.

Tezkor diagnostika:

```bash
openssl s_client -connect portal.example.uz:443 -servername portal.example.uz \
  -showcerts </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates
```

Hech qachon `curl -k` yoki `verify=False` ni "yechim" sifatida ishlab chiqarishga qo'ymang — u xatoni yashiradi, tuzatmaydi.$a$]
]);


-- 3. Docker va konteynerlar --------------------------------------------------

SELECT pg_temp.seed_doc('docker', 'Docker asoslari: image, konteyner, volume', ARRAY[
[$q$Image va konteyner o'rtasida qanday farq bor?$q$,
$a$**Image** — faqat o'qish uchun shablon: fayl tizimi qatlamlari va metadata (qaysi buyruq ishga tushadi, qaysi portlar, qaysi muhit o'zgaruvchilari). Sinfga o'xshaydi.

**Konteyner** — shu image'dan ishga tushirilgan nusxa, ustiga yoziladigan yupqa qatlam bilan. Obyektga o'xshaydi.

Shundan kelib chiqadigan amaliy natijalar:

- Bitta image'dan o'nlab konteyner ishga tushirish mumkin, hammasi bir xil boshlang'ich holatdan.
- Konteyner ichida yozilgan har qanday fayl **o'chirilganda yo'qoladi** — shuning uchun ma'lumot volume'da saqlanishi kerak.
- `docker commit` bilan ishlayotgan konteynerni image'ga aylantirish texnik jihatdan mumkin, lekin buni qilmaslik kerak: natija qayta tiklanmaydigan, hujjatlashtirilmagan image bo'ladi. Dockerfile — yagona to'g'ri yo'l.

```bash
docker images              # mavjud image'lar
docker ps                  # ishlayotgan konteynerlar
docker ps -a               # to'xtaganlari ham
```$a$],

[$q$Volume va bind mount qaysi holatda ishlatiladi?$q$,
$a$```bash
# volume — Docker boshqaradigan nomli saqlash joyi
docker run -v pgdata:/var/lib/postgresql/data postgres:17

# bind mount — host fayl tizimidagi aniq katalog
docker run -v /srv/portal/uploads:/app/uploads portal
```

| | Volume | Bind mount |
| --- | --- | --- |
| Joyi | Docker boshqaradi (`/var/lib/docker/volumes`) | siz ko'rsatgan yo'l |
| Ko'chirish | `docker volume` buyruqlari bilan | oddiy fayllar, `rsync` bilan |
| Ruxsatlar | Docker to'g'rilaydi | host UID/GID bilan to'qnashadi |
| Ishlatilishi | ma'lumotlar bazasi, ichki holat | konfiguratsiya, yuklangan fayllar, dev kodi |

Eng ko'p uchraydigan muammo — bind mount'da **ruxsatlar**: konteyner ichidagi foydalanuvchi UID 1000, hostdagi katalog egasi esa boshqa UID bo'lsa, "permission denied" chiqadi. Yechim — `chown -R 1000:1000 /srv/portal/uploads` yoki konteynerni `--user "$(id -u):$(id -g)"` bilan ishga tushirish.

Ishlab chiqarishda ma'lumotlar bazasi uchun **nomli volume** afzal: tezroq va ruxsat muammosi kamroq.$a$],

[$q$Qatlam keshi qanday ishlaydi va nega build sekin?$q$,
$a$Dockerfile'ning har bir instruksiyasi bitta qatlam yaratadi. Build vaqtida Docker har qatlam uchun "kirish ma'lumotlari o'zgardimi" deb qaraydi; o'zgarmagan bo'lsa keshdan oladi. Lekin bitta qatlam o'zgarsa, **undan keyingi hammasi** qaytadan bajariladi.

Shuning uchun tartib muhim. Yomon:

```dockerfile
COPY . .
RUN npm ci
```

Har qanday kod o'zgarishi `npm ci` ni qaytadan ishga tushiradi.

Yaxshi:

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
```

Endi bog'liqliklar faqat `package-lock.json` o'zgarganda qayta o'rnatiladi.

Qoida: **kam o'zgaradigan narsa yuqorida, ko'p o'zgaradigan pastda**.

Keshni ko'rish va tozalash:

```bash
docker build --progress=plain .    # qaysi qadam CACHED ekanini ko'rsatadi
docker build --no-cache .          # keshsiz, tekshirish uchun
docker builder prune               # build keshini tozalash
```$a$],

[$q$Port mapping qanday yoziladi?$q$,
$a$`-p HOST:KONTEYNER` tartibida:

```bash
docker run -p 8080:80 nginx          # hostning 8080 → konteynerning 80
docker run -p 127.0.0.1:5432:5432 postgres   # faqat localhost
docker run -P nginx                  # EXPOSE qilinganlarni tasodifiy portlarga
```

Ikki tez-tez uchraydigan xato:

1. **Tartibni almashtirish.** `-p 80:8080` ilovangiz 8080 da ishlayotganini emas, konteyner ichida 8080 tinglashini nazarda tutadi. Noto'g'ri yozilsa "connection refused" chiqadi.
2. **Ilova `127.0.0.1` da tinglashi.** Konteyner ichida `localhost` — konteynerning o'zi. Ilova `0.0.0.0` da tinglamasa, port mapping hech narsa qilmaydi. Shuning uchun konteynerdagi server har doim `0.0.0.0` ga bog'lanishi kerak.

Xavfsizlik nuqtasi: `-p 5432:5432` portni **butun internetga** ochadi va `ufw` buni to'sa olmaydi, chunki Docker iptables qoidalarini undan oldinroq joylaydi. Ichki xizmatlar uchun har doim `127.0.0.1:` prefiksini yozing yoki umuman port chiqarmasdan Docker tarmog'i orqali ulanish qiling.$a$],

[$q$Konteyner loglarini qanday ko'raman va ular qancha joy oladi?$q$,
$a$```bash
docker logs -f --tail 200 portal
docker logs --since 10m portal
docker compose logs -f api db
```

Docker faqat `stdout`/`stderr` ni yig'adi. Ilova logni fayl ichiga yozsa, `docker logs` bo'sh bo'ladi — konteynerlashtirilgan ilova logni har doim standart chiqishga yozishi kerak.

Loglar standart holatda **cheksiz o'sadi** va diskni to'ldirib qo'yishi mumkin. Chegara qo'yish uchun `/etc/docker/daemon.json`:

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" }
}
```

Keyin `systemctl restart docker`. Bu faqat **yangi** konteynerlarga ta'sir qiladi.

Hozirgi hajmni ko'rish:

```bash
du -sh /var/lib/docker/containers/*/*-json.log | sort -h | tail
```$a$],

[$q$Docker diskni to'ldirib qo'ydi — qanday tozalayman?$q$,
$a$Avval nimaga ketganini ko'ring:

```bash
docker system df          # umumiy taqsimot
docker system df -v       # har bir image/volume bo'yicha
```

Keyin bosqichma-bosqich tozalang — eng xavfsizdan boshlab:

```bash
docker container prune              # to'xtagan konteynerlar
docker image prune                  # nomsiz (dangling) image'lar
docker builder prune                # build keshi — odatda eng katta aybdor
docker image prune -a               # ishlatilmayotgan BARCHA image'lar
```

**Ehtiyot bo'ling:**

```bash
docker system prune -a --volumes    # volume'larni ham o'chiradi
```

Bu buyruq hech qaysi ishlayotgan konteynerga bog'lanmagan volume'larni o'chiradi — ya'ni vaqtincha to'xtatilgan bazangizning ma'lumoti ham ketishi mumkin. Ishlab chiqarishda `--volumes` ni yozmaslik yoki oldin `docker volume ls` bilan ro'yxatni ko'rib chiqish kerak.

Doimiy yechim: log chegarasi (yuqorida), CI'da eski image teglarini tozalash va `docker builder prune --filter until=168h` ni haftalik timer'ga qo'yish.$a$]
]);

SELECT pg_temp.seed_doc('docker', 'Dockerfile yozish bo''yicha amaliyot', ARRAY[
[$q$Multi-stage build nima va nega kerak?$q$,
$a$Bir Dockerfile ichida bir nechta `FROM` — birinchilari kompilyatsiya uchun, oxirgisi esa faqat natijani olib ketadigan ozg'in image.

```dockerfile
FROM rust:1-slim AS build
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release
COPY . .
RUN cargo build --release

FROM debian:stable-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/target/release/portal /usr/local/bin/portal
USER 1000:1000
ENTRYPOINT ["portal"]
```

Foydasi ikki tomonlama:

- **Hajm** — kompilyator, toolchain va `target/` katalogi yakuniy image'ga tushmaydi (1.5 GB → 80 MB odatiy natija).
- **Xavfsizlik** — ishlab chiqarish image'ida compiler ham, `git` ham, paket menejeri ham yo'q, ya'ni zaiflik maydoni kichik.

Dastlabki bo'sh `main.rs` bilan build qilish — bog'liqliklarni alohida qatlamda keshlash uchun qilingan nayrang; Node'da bu `COPY package*.json` ga to'g'ri keladi.$a$],

[$q$.dockerignore nima uchun muhim?$q$,
$a$`COPY . .` butun build kontekstini daemon'ga yuboradi. `.dockerignore` bo'lmasa, u yerga `node_modules`, `target/`, `.git`, `.env` va mahalliy loglar ham kiradi.

Uch xil zarar:

1. **Sekin** — gigabaytli kontekst har build'da uzatiladi.
2. **Kesh buziladi** — `.git` ichidagi har qanday o'zgarish `COPY . .` qatlamini yangilaydi, shuning uchun kesh hech qachon ishlamaydi.
3. **Xavfli** — `.env` va SSH kalitlari image ichiga tushib qoladi. `docker history` yoki `docker run --entrypoint sh` bilan ularni har kim o'qiydi.

Minimal namuna:

```
.git
node_modules
target
dist
.env
.env.*
*.log
.direnv
```

Tekshirish: `docker build --no-cache .` boshida chiqadigan `transferring context: ... MB` qiymatiga qarang. U bir necha MB dan oshsa, ignore faylini qayta ko'rish kerak.$a$],

[$q$Nega konteynerni root'dan ishga tushirmaslik kerak?$q$,
$a$Standart holatda konteyner ichidagi `root` — hostdagi UID 0 ning o'zi. Konteyner izolyatsiyasi buzilsa (yadro zaifligi, noto'g'ri mount, `--privileged`), tajovuzkor darhol hostda root bo'ladi. Hamda bind mount qilingan katalogdagi fayllarning egasi root bo'lib qoladi, keyin hostdan tahrirlash qiyinlashadi.

To'g'ri yo'l:

```dockerfile
RUN useradd --system --uid 10001 --no-create-home app
USER 10001:10001
```

yoki image allaqachon foydalanuvchi bergan bo'lsa (`node`, `postgres`) — shundan foydalanish.

Qo'shimcha qattiqlashtirish:

```yaml
# docker-compose.yml
read_only: true
tmpfs: [/tmp]
cap_drop: [ALL]
security_opt: [no-new-privileges:true]
```

Agar ilovangiz 80-portda tinglashi kerak bo'lsa — tinglamasin: konteyner ichida 8080 da ishlab, `-p 80:8080` bilan chiqarish mumkin. Shunda root umuman kerak bo'lmaydi.$a$],

[$q$ENTRYPOINT va CMD o'rtasida qanday farq bor?$q$,
$a$- **`ENTRYPOINT`** — har doim bajariladigan asosiy buyruq.
- **`CMD`** — standart argumentlar; `docker run image <arg>` bilan almashtiriladi.

```dockerfile
ENTRYPOINT ["portal"]
CMD ["--port", "3000"]
```

`docker run portal` → `portal --port 3000`
`docker run portal --port 9000` → `portal --port 9000`

Agar faqat `CMD` bo'lsa, `docker run image sh` butun buyruqni almashtiradi — debug uchun qulay, lekin tasodifan almashtirib qo'yish ham oson.

**Exec form (`["x","y"]`) ni ishlatish muhim.** Shell form (`ENTRYPOINT portal`) buyruqni `/bin/sh -c` ostida ishga tushiradi, natijada PID 1 — shell bo'ladi va u `SIGTERM` ni ilovaga uzatmaydi. Shunda `docker stop` 10 sekund kutib, keyin `SIGKILL` qiladi: ilova toza to'xtay olmaydi, ulanishlar uzilib ketadi.

Signal muammosi ilovaning o'zida bo'lsa (masalan `npm start` orqali ishga tushirilsa), `--init` yoki `tini` yordam beradi.$a$],

[$q$HEALTHCHECK nima beradi?$q$,
$a$Docker'ga konteyner **haqiqatan ishlayotganini** aytadi — jarayon tirik bo'lishi hali xizmat javob berayotganini bildirmaydi.

```dockerfile
HEALTHCHECK --interval=30s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
```

`start-period` muhim: ilova ko'tarilishi uchun vaqt beradi va shu davrdagi muvaffaqiyatsiz tekshiruvlar hisobga olinmaydi.

Compose'da bu bog'liqliklarni to'g'ri navbatlashtirish imkonini beradi:

```yaml
depends_on:
  db:
    condition: service_healthy
```

`depends_on` ni healthcheck'siz ishlatish faqat **ishga tushish tartibini** kafolatlaydi, tayyorligini emas — shu sababli ilova bazadan oldin ko'tarilib, ulanish xatosi bilan yiqiladi.

Health endpoint'i yengil bo'lishi kerak: bazaga oddiy `SELECT 1` yetarli, butun tizimni tekshirish emas. Har 30 sekundda ishlaydigan og'ir tekshiruv o'zi muammo manbaiga aylanadi.$a$],

[$q$Image hajmini qanday kichraytiraman?$q$,
$a$Ta'sir kuchi bo'yicha tartibda:

1. **Multi-stage build** — eng katta samara.
2. **Kichik asosiy image**: `debian:stable-slim`, `alpine`, yoki statik binar uchun `gcr.io/distroless/static`.
3. **Bitta `RUN` da o'rnatib, shu `RUN` da tozalash** — alohida qatlamda o'chirish hajmni kamaytirmaydi, chunki eski qatlam image ichida qoladi:
   ```dockerfile
   RUN apt-get update && apt-get install -y --no-install-recommends curl \
       && rm -rf /var/lib/apt/lists/*
   ```
4. **`.dockerignore`** — keraksiz fayllar umuman kirmasin.
5. **Faqat ishlab chiqarish bog'liqliklari**: `npm ci --omit=dev`.

Nimaga joy ketganini ko'rish:

```bash
docker image history --no-trunc portal:latest
docker image ls portal
```

Alpine bilan ehtiyot bo'lish kerak: u musl libc ishlatadi, shuning uchun glibc'ga tayangan binarlar ishlamaydi va Python/Node'da native modullar qaytadan kompilyatsiya qilinishi lozim — natijada build sekinlashadi. Hajm farqi 30-40 MB bo'lsa, `-slim` variantni tanlash ko'pincha oqilona.$a$]
]);

SELECT pg_temp.seed_doc('docker', 'docker compose bilan ko''p xizmatli ilova', ARRAY[
[$q$Compose fayli qanday tuzilgan?$q$,
$a$```yaml
services:
  db:
    image: postgres:17
    environment:
      POSTGRES_PASSWORD: ${DB_PASSWORD:?kerak}
      POSTGRES_DB: portal
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
      interval: 5s
      retries: 10
    restart: unless-stopped

  api:
    build: .
    environment:
      DATABASE_URL: postgres://postgres:${DB_PASSWORD}@db:5432/portal
    ports: ["127.0.0.1:3000:3000"]
    depends_on:
      db: { condition: service_healthy }
    restart: unless-stopped

volumes:
  pgdata:
```

Diqqat qiladigan joylar:

- `${DB_PASSWORD:?kerak}` — o'zgaruvchi berilmasa Compose xato bilan to'xtaydi, bo'sh parol bilan ko'tarilmaydi.
- `db:5432` — xizmat nomi DNS nomi bo'lib ishlaydi, IP yozish shart emas.
- `version:` kaliti endi eskirgan, yozish kerak emas.

Asosiy buyruqlar: `docker compose up -d`, `ps`, `logs -f`, `down`, `exec api sh`.$a$],

[$q$Bir xizmat ikkinchisini kutishi kerak bo'lsa nima qilaman?$q$,
$a$`depends_on` ni **`condition: service_healthy`** bilan ishlatish kerak. Oddiy `depends_on: [db]` faqat ishga tushirish tartibini belgilaydi: Postgres konteyneri boshlanadi, lekin bazani initsializatsiya qilishi 5-10 sekund davom etadi va ilova shu oraliqda ulanishga urinib yiqiladi.

Shunga qaramay, ilovaning o'zida ham qayta urinish mantig'i bo'lishi kerak:

- Compose'siz muhitda (Kubernetes, bare metal) healthcheck kafolati yo'q.
- Baza ish davomida qayta ishga tushishi mumkin.

Ya'ni to'g'ri yechim ikki qatlamli: `service_healthy` ishga tushishni tartibga soladi, ilovadagi retry esa ish davomidagi uzilishlarni ko'taradi.

Qo'shimcha nuqta: `restart: unless-stopped` bilan birga ishlatilsa, yiqilgan konteyner qayta ko'tariladi, lekin `docker compose stop` bilan qo'lda to'xtatilganlar o'z-o'zidan ko'tarilmaydi — serverni reboot qilganda ham shu xatti-harakat saqlanadi.$a$],

[$q$Muhit o'zgaruvchilari va sirlarni qanday boshqaraman?$q$,
$a$Uch xil mexanizm bor va ularni aralashtirib yuborish oson:

```yaml
services:
  api:
    env_file: [.env]          # fayldan konteynerga uzatiladi
    environment:
      LOG_LEVEL: info         # bu yerda aniq yozilgan
```

- **`.env` fayli** (compose faylining yonida) — `${...}` o'rnini bosish uchun Compose **o'zi** o'qiydi. Konteynerga avtomatik tushmaydi.
- **`env_file:`** — ko'rsatilgan fayl konteyner muhitiga yuklanadi.
- **`environment:`** — eng ustun, aniq qiymatlar.

Sirlar uchun qoidalar:

1. `.env` ni `.gitignore` ga qo'ying, `.env.example` ni esa (qiymatlarsiz) commit qiling.
2. Ruxsatni cheklang: `chmod 600 .env`.
3. Sirni `build args` ga bermang — u `docker history` da ko'rinadi.
4. Jiddiyroq muhitda Docker secrets yoki tashqi sir boshqaruvi (Vault, SSM) ishlatiladi; fayl `/run/secrets/...` orqali konteynerga mount qilinadi.

Tekshirish: `docker compose config` butun konfiguratsiyani o'rni bosilgan holda ko'rsatadi — nima qanday qiymat olganini shu yerda ko'rish mumkin (natijada sirlar ko'rinadi, shuning uchun uni log'ga yozmang).$a$],

[$q$Compose tarmoqlari qanday ishlaydi?$q$,
$a$Compose har proyekt uchun avtomatik bitta tarmoq yaratadi va barcha xizmatlarni unga qo'shadi. Natijada:

- Xizmatlar bir-birini **nomi bilan** topadi: `api` dan `db:5432` ga ulanadi.
- Ichki muloqot uchun port chiqarish (`ports:`) **shart emas** — `ports:` faqat hostdan kirish uchun.

Shuning uchun ma'lumotlar bazasidan `ports:` ni olib tashlash to'g'ri amaliyot: ilova unga tarmoq ichidan ulanadi, tashqaridan esa umuman ko'rinmaydi. Qo'lda `psql` kerak bo'lganda:

```bash
docker compose exec db psql -U postgres portal
```

Izolyatsiyani kuchaytirish uchun ikki tarmoqqa bo'lish mumkin:

```yaml
services:
  proxy: { networks: [edge] }
  api:   { networks: [edge, internal] }
  db:    { networks: [internal] }
networks:
  edge:
  internal:
    internal: true     # bu tarmoqdan internetga chiqish yo'q
```

Bunda baza tashqi dunyo bilan hech qanday yo'l orqali bog'lanmaydi.$a$],

[$q$Ma'lumotlar bazasini qanday zaxiralayman?$q$,
$a$Konteynerdagi baza ham oddiy Postgres — `pg_dump` shundayligicha ishlaydi:

```bash
docker compose exec -T db pg_dump -U postgres -Fc portal > portal-$(date +%F).dump
```

Tiklash:

```bash
docker compose exec -T db pg_restore -U postgres -d portal --clean < portal-2026-11-17.dump
```

`-T` muhim: TTY ajratmaydi, aks holda chiqish oqimiga boshqaruv belgilari qo'shilib dump buziladi.

Volume'ni butunlay nusxalash ham mumkin, lekin baza **to'xtatilgan** bo'lishi kerak:

```bash
docker compose stop db
docker run --rm -v portal_pgdata:/data -v "$PWD":/backup alpine \
  tar czf /backup/pgdata.tar.gz -C /data .
docker compose start db
```

Ishlayotgan bazaning fayllarini nusxalash buzuq zaxira beradi.

Eng muhim qoida: **tiklashni sinab ko'rmagan zaxira — zaxira emas.** Oyda bir marta dump'ni bo'sh bazaga tiklab, ilovani unga ulab ko'rish kerak.$a$],

[$q$Yangi versiyani to'xtalishsiz qanday chiqaraman?$q$,
$a$Oddiy Compose uchun amaliy ketma-ketlik:

```bash
git pull
docker compose build api            # yangi image oldindan tayyor bo'lsin
docker compose run --rm api migrate # migratsiyalar (agar alohida bo'lsa)
docker compose up -d --no-deps api  # faqat api qayta ko'tariladi, db tegilmaydi
docker compose logs -f --tail 50 api
```

`--no-deps` bo'lmasa, Compose bazani ham qayta ishga tushirishi mumkin — bu keraksiz uzilish.

Qaytarish (rollback) uchun image teglaridan foydalanish kerak: `portal:2026-11-17-a1b2c3` kabi aniq teg qo'ysangiz, muammo chiqqanda `.env` dagi tegni oldingisiga o'zgartirib `up -d` qilish kifoya. `latest` bilan ishlasangiz, qaytishga narsa qolmaydi.

Haqiqiy nol uzilish uchun esa ikki nusxa (blue/green) va oldida reverse proxy kerak: yangi nusxa ko'tariladi, healthcheck o'tadi, proxy trafikni unga o'tkazadi, keyin eski nusxa o'chiriladi. Compose buni o'zi qilmaydi — nginx konfiguratsiyasi yoki Traefik orqali qo'lda tuziladi.$a$]
]);


-- 4. PostgreSQL va ma'lumotlar bazasi ----------------------------------------

SELECT pg_temp.seed_doc('postgresql', 'Indekslar va so''rov rejasi (EXPLAIN)', ARRAY[
[$q$Indeks nima va qanday ishlaydi?$q$,
$a$Indeks — ustun qiymatlaridan tuzilgan alohida, tartiblangan tuzilma (odatda B-tree), har bir yozuv jadvaldagi qatorga ko'rsatadi. Kitobning orqasidagi alifbo ko'rsatkichiga o'xshaydi: butun kitobni varaqlash o'rniga kerakli sahifani darhol topasiz.

Indekssiz `WHERE email = 'a@b.uz'` butun jadvalni o'qiydi (sequential scan). Indeks bilan bir necha blok o'qish kifoya.

Narxi ham bor va u haqida ko'pincha o'ylanmaydi:

- Har bir `INSERT`/`UPDATE`/`DELETE` indekslarni ham yangilashi kerak — yozish sekinlashadi.
- Indeks disk va xotira egallaydi; keraksiz indekslar keshdan foydali ma'lumotni siqib chiqaradi.
- Ishlatilmaydigan indeks — sof zarar.

Shuning uchun qoida: haqiqiy so'rovlardan kelib chiqib indeks qo'yish, "har ehtimolga qarshi" emas. Ishlatilmayotganlarini topish:

```sql
SELECT relname, indexrelname, idx_scan
FROM pg_stat_user_indexes
WHERE idx_scan = 0
ORDER BY pg_relation_size(indexrelid) DESC;
```$a$],

[$q$EXPLAIN ANALYZE natijasini qanday o'qiyman?$q$,
$a$```sql
EXPLAIN (ANALYZE, BUFFERS) 
SELECT * FROM documents WHERE category_id = '...' ORDER BY created_at DESC LIMIT 20;
```

`EXPLAIN` faqat rejani ko'rsatadi, `ANALYZE` esa so'rovni **haqiqatan bajaradi** va real vaqtni beradi. `UPDATE`/`DELETE` da ehtiyot bo'ling — o'zgarish amalga oshadi (tranzaksiya ichida qilib `ROLLBACK` qilish mumkin).

Nimaga qarash kerak:

- **`Seq Scan`** katta jadvalda — indeks yo'q yoki ishlatilmayapti.
- **`rows=` taxmini va `actual rows`** o'rtasidagi katta farq — statistika eskirgan, `ANALYZE jadval` kerak.
- **`loops=`** katta son — ichki tsikl; `Nested Loop` noto'g'ri tanlangan bo'lishi mumkin.
- **`Buffers: read=`** katta — disk'dan o'qiyapti, `hit=` esa keshdan.
- **`Sort Method: external merge Disk: ...`** — saralash xotiraga sig'mayapti, `work_mem` ni oshirish kerak.

Eng pastdagi tugundan yuqoriga qarab o'qiladi: ichkaridagi qadamlar birinchi bajariladi. Ko'p vaqt yeb turgan tugunni `actual time` ustunidagi farqdan topasiz.$a$],

[$q$Indeks bor, lekin ishlatilmayapti — nega?$q$,
$a$Keng tarqalgan sabablar:

1. **Ustunga funksiya qo'llangan.**
   `WHERE lower(title) = 'x'` oddiy indeksni ishlatmaydi. Yechim — ifoda indeksi: `CREATE INDEX ON documents (lower(title))`.
2. **Tur mos kelmaydi.** `WHERE id = '123'` da `id` — `bigint`, qiymat — matn bo'lsa, cast indeksni buzadi.
3. **`LIKE '%xyz'`** — boshi ochiq shablon B-tree'da ishlamaydi. Prefiks (`'xyz%'`) ishlaydi; to'liq substring uchun `pg_trgm` + GIN kerak.
4. **Jadval kichik.** 500 qatorli jadvalda seq scan haqiqatan tezroq — bu optimizatorning to'g'ri qarori, muammo emas.
5. **So'rov jadvalning katta qismini qaytaradi.** 40% qatorni olayotganda indeks orqali sakrash sekinroq.
6. **Statistika eskirgan.** `ANALYZE documents;` ni ishlatib ko'ring.
7. **Kompozit indeks tartibi.** `(a, b)` indeksi `WHERE b = ...` uchun (asosan) yaramaydi — chapdan boshlab mos kelishi kerak.

Tekshirish uchun vaqtincha majburlash mumkin:

```sql
SET enable_seqscan = off;   -- faqat sinov uchun, sessiyada
```

Agar shundan keyin indeks ishlatilsa va tezroq bo'lsa — optimizator narxni noto'g'ri baholayapti, demak statistika yoki `random_page_cost` ni ko'rish kerak.$a$],

[$q$B-tree, GIN va boshqa indeks turlari qachon kerak?$q$,
$a$| Tur | Nima uchun |
| --- | --- |
| **B-tree** | standart: `=`, `<`, `>`, `BETWEEN`, `ORDER BY`, prefiks `LIKE 'a%'` |
| **GIN** | to'liq matnli qidiruv (`tsvector`), `jsonb`, massivlar, `pg_trgm` bilan substring |
| **GiST** | geometriya, oraliqlar, qo'shni qiymat qidirish |
| **BRIN** | juda katta, tabiiy tartiblangan jadvallar (vaqt bo'yicha o'sadigan loglar) — kichik, lekin taxminiy |
| **Hash** | faqat `=`; B-tree deyarli har doim yaxshiroq tanlov |

Bu loyihada to'liq matnli qidiruv uchun `documents.search` va `qa_blocks.search` ustunlariga GIN qo'yilgan — `backend/migrations/0006_fulltext_search.sql` ga qarang.

Qo'shimcha foydali shakllar:

```sql
-- faqat kerakli qatorlar uchun: kichik va tez
CREATE INDEX ON documents (created_at) WHERE status = 'published';

-- bir nechta ustun: tartib muhim (tenglik birinchi, oraliq oxirida)
CREATE INDEX ON qa_blocks (document_id, position);

-- indeksni jadvalni bloklamasdan qurish
CREATE INDEX CONCURRENTLY ...;
```

`CONCURRENTLY` ishlab chiqarishda majburiy: oddiy `CREATE INDEX` jadvalga yozishni butunlay to'sib turadi.$a$],

[$q$VACUUM va ANALYZE nima qiladi?$q$,
$a$PostgreSQL `UPDATE` ni "eski qatorni o'lik deb belgilash + yangi qator yozish" sifatida bajaradi (MVCC). Shuning uchun:

- **`VACUUM`** o'lik qatorlar egallagan joyni qayta ishlatish uchun bo'shatadi.
- **`ANALYZE`** optimizator uchun statistikani yangilaydi.
- **`VACUUM FULL`** jadvalni butunlay qayta yozadi va diskni haqiqatan qaytaradi, **lekin jadvalni to'liq bloklaydi** — ishlab chiqarishda faqat rejalashtirilgan to'xtalishda.

Autovacuum standart holatda yoqilgan va ko'p hollarda yetarli. Muammo ko'p yozuvli jadvallarda chiqadi:

```sql
SELECT relname, n_live_tup, n_dead_tup, last_autovacuum
FROM pg_stat_user_tables ORDER BY n_dead_tup DESC LIMIT 10;
```

`n_dead_tup` doimiy o'sib borsa, o'sha jadval uchun chegarani pasaytirish kerak:

```sql
ALTER TABLE audit_log SET (autovacuum_vacuum_scale_factor = 0.02);
```

Alohida xavf — **uzoq ochiq tranzaksiya**: u o'zidan keyin paydo bo'lgan o'lik qatorlarni tozalashga yo'l bermaydi, jadval shishib ketadi. `pg_stat_activity` dagi `state = 'idle in transaction'` qatorlarni kuzatib borish kerak.$a$],

[$q$Sekin so'rovlarni qanday topaman?$q$,
$a$`pg_stat_statements` — eng foydali vosita. `postgresql.conf` ga:

```
shared_preload_libraries = 'pg_stat_statements'
```

so'ng restart va `CREATE EXTENSION pg_stat_statements;`.

```sql
SELECT calls,
       round(mean_exec_time::numeric, 2) AS avg_ms,
       round(total_exec_time::numeric)   AS total_ms,
       left(query, 80) AS query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 15;
```

**`total_exec_time` bo'yicha saralash muhim**, `mean` bo'yicha emas: 2 ms da bajarilib, soatiga million marta chaqirilgan so'rov 2 sekundlik hisobotdan ko'ra ko'proq resurs yeydi.

Qo'shimcha yo'l — sekin so'rovlarni log'ga yozish:

```
log_min_duration_statement = 500ms
log_lock_waits = on
```

Hozir nima ishlayotganini ko'rish:

```sql
SELECT pid, now() - query_start AS davomiyligi, state, left(query, 60)
FROM pg_stat_activity
WHERE state <> 'idle' ORDER BY 2 DESC;
```

Osilib qolgan so'rovni to'xtatish: `SELECT pg_cancel_backend(pid)` (yumshoq), ishlamasa `pg_terminate_backend(pid)` (ulanishni uzadi).$a$]
]);

SELECT pg_temp.seed_doc('postgresql', 'Zaxira nusxa olish va tiklash', ARRAY[
[$q$pg_dump va pg_basebackup o'rtasida qanday farq bor?$q$,
$a$**`pg_dump`** — mantiqiy zaxira: bitta bazani SQL yoki maxsus formatga yozadi.

- Versiyalar o'rtasida ko'chirish mumkin (15 → 17).
- Bitta jadvalni ham tiklash mumkin.
- Katta bazada sekin, tiklash yanada sekin (indekslar qaytadan quriladi).

**`pg_basebackup`** — jismoniy zaxira: butun klasterning fayllarini nusxalaydi.

- Tez, hajmi bazaga teng.
- WAL bilan birga PITR (nuqtaga tiklash) imkonini beradi.
- Faqat **bir xil** major versiya va shunga mos platformaga tiklanadi.
- Alohida jadvalni ajratib tiklab bo'lmaydi.

Amaliy tanlov: kichik va o'rta baza (10-20 GB gacha) uchun `pg_dump` yetarli va qulay. Undan kattasi yoki "oxirgi 5 daqiqani ham yo'qotmaslik" talabi bo'lsa — jismoniy zaxira + WAL arxivlash.

Ikkisini birga ishlatish ham keng tarqalgan: kunlik jismoniy zaxira (tez tiklash uchun) va haftalik dump (versiya ko'chirish va tanlab tiklash uchun).$a$],

[$q$pg_dump'ni qanday to'g'ri ishlataman?$q$,
$a$```bash
# maxsus format — siqilgan, parallel tiklanadi, tanlab tiklash mumkin
pg_dump -Fc -f portal-$(date +%F).dump "$DATABASE_URL"

# katta baza uchun katalog formati + parallel
pg_dump -Fd -j 4 -f portal-dir "$DATABASE_URL"

# faqat sxema / faqat ma'lumot
pg_dump --schema-only "$DATABASE_URL" > schema.sql
pg_dump --data-only --table=documents "$DATABASE_URL" > documents.sql
```

Tiklash:

```bash
createdb portal_test
pg_restore -d portal_test -j 4 portal-2026-11-17.dump
```

Muhim nuqtalar:

- `-Fc` (custom) deyarli har doim oddiy SQL'dan afzal: siqilgan va `pg_restore` bilan tanlab tiklash mumkin.
- `pg_dump` **faqat bitta bazani** oladi. Rollar va klaster darajasidagi obyektlar uchun alohida `pg_dumpall --globals-only` kerak.
- Dump **izchil** (consistent) holatni oladi — jadvallar bir-biriga mos keladi, hatto ish davom etayotganda ham.
- Parolni buyruq qatorida yozmang; `~/.pgpass` (ruxsat `0600`) yoki `PGPASSWORD` muhit o'zgaruvchisidan foydalaning.$a$],

[$q$Qanchalik tez-tez zaxira olish kerak?$q$,
$a$Ikki savolga javob berib hisoblanadi:

- **RPO** (recovery point objective) — qancha ma'lumotni yo'qotishga tayyormiz?
- **RTO** (recovery time objective) — tiklash qancha vaqt olishi mumkin?

Amaliy jadval:

| Holat | Zaxira sxemasi |
| --- | --- |
| Ichki vosita, kunlik o'zgarish kam | kunlik `pg_dump`, 7-14 nusxa saqlash |
| Faol ishlatiladigan tizim | kunlik dump + WAL arxivlash (RPO ≈ daqiqalar) |
| To'lov yoki hisob ma'lumotlari | uzluksiz arxivlash + boshqa regionda nusxa |

Qo'shimcha qoidalar:

1. **3-2-1**: uch nusxa, ikki xil muhitda, biri boshqa joyda.
2. Zaxira **boshqa mashinada** turishi shart. Server disk bilan birga yo'qolsa, undagi zaxira ham yo'qoladi.
3. Zaxiraga **yozib bo'lmaydigan** joy yaxshi (object storage'da versiyalash va o'chirishdan himoya) — ransomware zaxirani birinchi o'chiradi.
4. Saqlash muddatini belgilang, aks holda xarajat cheksiz o'sadi.

Bu loyihada zaxira uchun amaliy buyruqlar `docs/DEPLOY.uz.md` da ham keltirilgan.$a$],

[$q$WAL va PITR nima?$q$,
$a$WAL (write-ahead log) — PostgreSQL har bir o'zgarishni avval jurnalga yozadi, keyin ma'lumot fayllariga qo'llaydi. Shu jurnalni arxivlab borsak, jismoniy zaxira ustiga WAL'ni "o'ynatib" **istalgan vaqt nuqtasiga** tiklash mumkin bo'ladi — bu PITR.

Minimal sozlash:

```
wal_level = replica
archive_mode = on
archive_command = 'test ! -f /arch/%f && cp %p /arch/%f'
```

Tiklash uchun `recovery.signal` fayli va maqsadli vaqt:

```
restore_command = 'cp /arch/%f %p'
recovery_target_time = '2026-11-17 09:15:00+05'
```

Nima uchun bu muhim: kimdir `DELETE FROM documents` ni `WHERE` siz bajarib qo'ysa, kunlik dump bilan butun kunni yo'qotasiz; PITR bilan esa o'sha buyruqdan bir daqiqa oldingi holatga qaytasiz.

Qo'lda sozlash murakkab, shuning uchun amalda `pgBackRest` yoki `barman` ishlatiladi — ular arxivlash, saqlash muddati, tekshirish va parallel tiklashni o'zi boshqaradi.$a$],

[$q$Zaxira haqiqatan ishlashini qanday tekshiraman?$q$,
$a$Yagona ishonchli usul — **tiklab ko'rish**. Tekshirilmagan zaxira shunchaki umid.

Oylik tartib:

```bash
# 1. eng yangi zaxirani oling va bo'sh bazaga tiklang
createdb portal_restore_test
pg_restore -d portal_restore_test -j 4 /backups/portal-latest.dump

# 2. asosiy jadvallarni sanab ko'ring
psql portal_restore_test -c "
  SELECT 'documents' t, count(*) FROM documents
  UNION ALL SELECT 'qa_blocks', count(*) FROM qa_blocks
  UNION ALL SELECT 'users', count(*) FROM users;"

# 3. eng yangi yozuv sanasini ko'ring — zaxira haqiqatan yangimi?
psql portal_restore_test -c "SELECT max(created_at) FROM documents;"

# 4. ilovani shu bazaga ulab, bir necha sahifani ochib ko'ring
# 5. tozalang
dropdb portal_restore_test
```

Avtomatlashtirish ham mumkin: shu qadamlarni skript qilib, systemd timer'ga qo'yish va natijani Telegram'ga yuborish. Bu loyihada hujjat o'zgarishlari uchun allaqachon Telegram xabarnomasi bor, shu kanalni zaxira hisobotlari uchun ham ishlatish mumkin.

Yozib qo'yish kerak bo'lgan narsa: **tiklash qancha vaqt oldi**. RTO ni faqat shunday bilib olasiz.$a$],

[$q$Major versiyaga qanday o'taman?$q$,
$a$Uch yo'l bor.

**1. dump/restore** — eng oddiy, kichik bazalar uchun:

```bash
pg_dumpall --globals-only > globals.sql     # rollar
pg_dump -Fc portal > portal.dump
# yangi klasterda:
psql -f globals.sql && createdb portal && pg_restore -d portal portal.dump
```

To'xtalish vaqti baza hajmiga proporsional.

**2. `pg_upgrade`** — fayllarni joyida yangilaydi, ancha tez:

```bash
pg_upgrade -b /usr/lib/postgresql/16/bin -B /usr/lib/postgresql/17/bin \
           -d /var/lib/postgresql/16/main -D /var/lib/postgresql/17/main --link --check
```

`--check` avval quruq tekshiruv qiladi. `--link` hard link ishlatadi — juda tez, lekin **eski klasterga qaytish imkonini yo'qotadi**, shuning uchun oldin zaxira shart.

**3. Logical replication** — deyarli nol to'xtalish, lekin eng ko'p tayyorgarlik talab qiladi.

Har qanday holatda: avval nusxada sinab ko'ring, `extension`lar yangi versiyada mavjudligini tekshiring, va yangilangandan keyin `ANALYZE` ni butun baza bo'yicha ishlatib statistikani qayta yig'ing — aks holda so'rovlar birinchi kunlarda sekin ishlaydi.$a$]
]);

SELECT pg_temp.seed_doc('postgresql', 'Tranzaksiyalar, qulflar va ulanishlar', ARRAY[
[$q$Tranzaksiya nima va izolyatsiya darajalari nimani o'zgartiradi?$q$,
$a$Tranzaksiya — bir nechta buyruqni **bo'linmas** birlikka aylantiradi: hammasi bajariladi yoki hech biri.

```sql
BEGIN;
UPDATE accounts SET balance = balance - 100 WHERE id = 1;
UPDATE accounts SET balance = balance + 100 WHERE id = 2;
COMMIT;
```

PostgreSQL'dagi darajalar:

| Daraja | Nimadan himoya qiladi |
| --- | --- |
| `READ COMMITTED` (standart) | faqat tasdiqlanmagan o'zgarishlarni ko'rmaslik |
| `REPEATABLE READ` | tranzaksiya ichida bir xil so'rov bir xil natija beradi |
| `SERIALIZABLE` | tranzaksiyalar ketma-ket bajarilgandek natija |

`READ COMMITTED` da bir tranzaksiya ichidagi ikki `SELECT` **har xil** natija berishi mumkin, chunki orada boshqa kimsa commit qilgan. Hisobot yoki bir nechta jadvalni izchil o'qish kerak bo'lsa `REPEATABLE READ` kerak.

`SERIALIZABLE` eng xavfsiz, lekin konflikt bo'lsa tranzaksiya `40001` xatosi bilan rad etiladi — ilovada **qayta urinish** mantig'i bo'lishi shart. Shu sababli uni faqat haqiqatan talab qiladigan joylarda (pul o'tkazish, chipta band qilish) ishlatish ma'qul.$a$],

[$q$Deadlock nima va qanday oldini olinadi?$q$,
$a$Ikki tranzaksiya bir-birining qulfini kutib qolsa — deadlock. A `1` qatorni, B `2` qatorni qulflaydi; keyin A `2` ni, B `1` ni so'raydi. Ikkisi ham cheksiz kutadi, PostgreSQL buni aniqlab birini bekor qiladi:

```
ERROR: deadlock detected
DETAIL: Process 123 waits for ShareLock on transaction 456...
```

Oldini olish usullari:

1. **Qatorlarni har doim bir xil tartibda qulflash** — eng samarali chora. Masalan ID bo'yicha o'sish tartibida.
2. **Tranzaksiyani qisqa qilish.** Ichida tashqi API chaqirmang, fayl yuklamang, foydalanuvchi javobini kutmang.
3. **`SELECT ... FOR UPDATE`** bilan kerakli qatorlarni boshida bir yo'la qulflash.
4. **`NOWAIT` yoki `SKIP LOCKED`** — navbat (queue) shaklidagi jadvallarda juda foydali:
   ```sql
   SELECT * FROM jobs WHERE state = 'pending'
   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1;
   ```

Deadlock'ni tekshirish uchun `log_lock_waits = on` va `deadlock_timeout = 1s` qo'yilsa, log'da to'liq tafsilot — qaysi so'rovlar, qaysi jadvallar — chiqadi.

Muhim: deadlock bekor qilingan tranzaksiyani **qayta urinish** ilovaning vazifasi. Bu normal hodisa, favqulodda holat emas.$a$],

[$q$"Idle in transaction" nima uchun xavfli?$q$,
$a$Bu holat ilova `BEGIN` qilgan, lekin `COMMIT` ham `ROLLBACK` ham qilmagan va boshqa ish bilan band ekanini bildiradi. Zararlari:

- **Qulflar ushlab turiladi** — boshqa so'rovlar kutadi.
- **Vacuum to'siladi** — o'sha tranzaksiya boshlanganidan keyingi o'lik qatorlar tozalanmaydi, jadvallar shishadi.
- **Ulanish band** — pool tugaydi.

Topish:

```sql
SELECT pid, state, now() - xact_start AS tranzaksiya_yoshi, left(query, 60)
FROM pg_stat_activity
WHERE state = 'idle in transaction'
ORDER BY xact_start;
```

Himoya — serverda chegaralar qo'yish:

```sql
ALTER DATABASE portal SET idle_in_transaction_session_timeout = '60s';
ALTER DATABASE portal SET statement_timeout = '30s';
ALTER DATABASE portal SET lock_timeout = '5s';
```

Sabab deyarli har doim ilova kodida: tranzaksiya ichida HTTP so'rov yuborilgan, yoki xato yo'lida `ROLLBACK` chaqirilmagan. ORM/pool ishlatganda tranzaksiyani imkon qadar kech boshlab, imkon qadar tez yopish kerak.$a$],

[$q$Ulanish pooli nega kerak?$q$,
$a$PostgreSQL har ulanish uchun **alohida jarayon** ochadi va unga xotira ajratadi. Shuning uchun ulanish ochish qimmat, mingta ulanish esa serverni yiqitadi.

Ikki qatlam bor va ularni aralashtirmaslik kerak:

1. **Ilova ichidagi pool** (`sqlx`, HikariCP, `pgx`) — ulanishlarni qayta ishlatadi.
2. **Tashqi pooler** (PgBouncer) — ko'p nusxali ilovalar yoki serverless uchun.

Hajmni hisoblash: `max_connections` serverda (odatda 100-200), ilovaning pool hajmi esa barcha nusxalar yig'indisi shundan kichik bo'lishi kerak. Amaliy formula — `yadro soni × 2 + disk soni`; ko'pincha 10-20 ulanish o'nlab mingta so'rovni bemalol ko'taradi. Poolni kattalashtirish ko'pincha **sekinlashtiradi**, chunki raqobat ortadi.

Holatni ko'rish:

```sql
SELECT count(*), state FROM pg_stat_activity GROUP BY state;
SHOW max_connections;
```

PgBouncer'ni `transaction` rejimida ishlatish eng samarali, lekin unda sessiya darajasidagi narsalar (`SET`, `LISTEN/NOTIFY`, tayyorlangan so'rovlar) ishlamaydi — ilovani shunga moslash kerak.$a$],

[$q$Qulflarni kim ushlab turganini qanday ko'raman?$q$,
$a$Kutayotgan va to'sayotgan so'rovlarni juftlab chiqaradigan so'rov:

```sql
SELECT w.pid AS kutayotgan,
       w.query AS kutayotgan_sorov,
       b.pid AS tosayotgan,
       b.query AS tosayotgan_sorov,
       now() - w.query_start AS kutish_vaqti
FROM pg_stat_activity w
JOIN pg_stat_activity b ON b.pid = ANY(pg_blocking_pids(w.pid))
WHERE cardinality(pg_blocking_pids(w.pid)) > 0;
```

`pg_blocking_pids()` — eng qulay funksiya: bevosita kim to'sayotganini aytadi.

Aralashish:

```sql
SELECT pg_cancel_backend(12345);      -- so'rovni bekor qiladi, ulanish qoladi
SELECT pg_terminate_backend(12345);   -- ulanishni uzadi (tranzaksiya rollback bo'ladi)
```

Eng ko'p uchraydigan to'siq manbai — DDL. `ALTER TABLE ... ADD COLUMN` (standart qiymatsiz) tez, lekin `ACCESS EXCLUSIVE` qulf oladi va u **boshqa barcha so'rovlarni** navbatga qo'yadi. Agar oldida uzoq `SELECT` turgan bo'lsa, `ALTER` uni kutadi va o'zidan keyin butun navbat to'planadi. Shuning uchun migratsiyalardan oldin `lock_timeout = '3s'` qo'yish amaliyoti bor: qulf darhol olinmasa, migratsiya xato bilan to'xtaydi va butun bazani qotirib qo'ymaydi.$a$],

[$q$Migratsiyalarni ishlab chiqarishda xavfsiz qo'llashning qoidalari qanday?$q$,
$a$Asosiy printsip — **har bir migratsiya ikki versiya bilan mos ishlashi kerak**: eski kod ham, yangi kod ham. Shunda deploy va rollback xavfsiz bo'ladi.

Amaliy qoidalar:

- Ustun **qo'shish** xavfsiz; ustun **o'chirish** faqat kod uni ishlatmay qo'ygandan keyin, keyingi deploy'da.
- `NOT NULL` ustunni darhol qo'shmang: avval nullable qilib qo'shing, ma'lumotni to'ldiring, keyin cheklov qo'ying.
- Ustun nomini o'zgartirish — eng xavfli operatsiya. Yangi ustun qo'shib, ikkisiga yozib turib, keyin eskisini o'chirish to'g'riroq.
- Indeksni `CREATE INDEX CONCURRENTLY` bilan quring (migratsiya tranzaksiyasidan tashqarida bo'lishi kerak).
- Katta jadvalni `UPDATE` qilishni bo'laklarga bo'ling — bitta million qatorli `UPDATE` uzoq tranzaksiya va shishish beradi.

Bu loyihada migratsiyalar `backend/migrations/` da ketma-ket raqamlangan va server ishga tushganda `sqlx` ularni avtomatik qo'llaydi. Shu sababli ikki narsa muhim: qo'llangan migratsiya faylini **hech qachon tahrirlamaslik** (xesh mos kelmaydi va server ko'tarilmaydi) va har bir o'zgarishni yangi raqamli fayl sifatida qo'shish.$a$]
]);


-- 5. Xavfsizlik --------------------------------------------------------------

SELECT pg_temp.seed_doc('xavfsizlik', 'SSH va serverga kirishni qattiqlashtirish', ARRAY[
[$q$Nega parol o'rniga SSH kalit ishlatish kerak?$q$,
$a$Parol — taxmin qilinadigan maxfiylik. Internetga ochiq 22-portga kuniga minglab avtomatik urinish keladi; log'ga bir qarasangiz ko'rinadi:

```bash
journalctl -u ssh | grep -c "Failed password"
```

SSH kalit esa 256 bitli (Ed25519) juftlik: maxfiy kalit sizning mashinangizdan chiqmaydi, serverda faqat ochiq kalit turadi. Uni taxmin qilish amalda mumkin emas.

```bash
ssh-keygen -t ed25519 -C "ism@noutbuk"     # parol-fraza qo'yish tavsiya etiladi
ssh-copy-id deploy@203.0.113.10
ssh deploy@203.0.113.10                     # kalit bilan kirishni TEKSHIRING
```

Faqat shundan keyin `/etc/ssh/sshd_config`:

```
PasswordAuthentication no
PermitRootLogin no
KbdInteractiveAuthentication no
```

```bash
sshd -t && systemctl reload ssh
```

`sshd -t` konfiguratsiyani tekshiradi — reload'dan oldin shuni ishlatish odat bo'lishi kerak, aks holda sintaksis xatosi bilan SSH umuman ko'tarilmaydi.

**Hozirgi sessiyani yopmang** — yangi terminalda kirishni sinab ko'rib, keyingina eskisini yoping.$a$],

[$q$fail2ban nima qiladi va qanday sozlanadi?$q$,
$a$Loglarni kuzatadi va ko'p marta muvaffaqiyatsiz urinish qilgan IP'ni vaqtincha firewall bilan bloklaydi.

```bash
apt install fail2ban
```

`/etc/fail2ban/jail.local`:

```ini
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 203.0.113.0/24   # o'z ofis tarmog'ingiz

[sshd]
enabled = true
```

```bash
systemctl enable --now fail2ban
fail2ban-client status sshd
fail2ban-client set sshd unbanip 203.0.113.55
```

`ignoreip` ga o'z tarmog'ingizni qo'shish muhim — aks holda bir necha xato urinishdan keyin o'zingizni bloklab qo'yishingiz mumkin.

Muhim istisno: faqat kalit bilan kirish yoqilgan bo'lsa, fail2ban'ning foydasi asosan log'ni tozalashda va resurs tejashda. Haqiqiy himoyani kalit beradi. Veb-ilova uchun esa alohida jail (nginx `limit_req` yoki ilova darajasidagi rate limiting) ko'proq ish qiladi.$a$],

[$q$SSH portini o'zgartirish foyda beradimi?$q$,
$a$Qisman. 22 dan masalan 2222 ga o'tkazish **xavfsizlikni oshirmaydi** — portni skanerlash bir necha sekund ishi. Lekin amaliy foydasi bor: avtomatik botlar asosan 22 ni uradi, shuning uchun loglar sezilarli tozalanadi va fail2ban kamroq ishlaydi.

"Obscurity" ni asosiy himoya sifatida ko'rmaslik kerak. Haqiqiy chora — kalit autentifikatsiyasi va kirishni cheklash.

Ancha kuchli yondashuvlar:

```
# faqat ma'lum foydalanuvchilar
AllowUsers deploy admin
# yoki guruh bo'yicha
AllowGroups ssh-users
```

```bash
# SSH'ni faqat ishonchli tarmoqdan ochish
ufw delete allow OpenSSH
ufw allow from 203.0.113.0/24 to any port 22 proto tcp
```

Eng yaxshisi — SSH'ni internetdan butunlay yopib, VPN (WireGuard) yoki bastion host orqali kirish. Bunda port raqami umuman ahamiyatsiz bo'lib qoladi.

Portni o'zgartirsangiz, firewall qoidasini **oldin** qo'shishni unutmang, aks holda o'zingizni tashqarida qoldirasiz.$a$],

[$q$sudo'ni qanday to'g'ri sozlayman?$q$,
$a$Asosiy printsip — eng kam imtiyoz. Hamma uchun to'liq `sudo` bermasdan, aniq buyruqlarga ruxsat berish mumkin:

```bash
visudo -f /etc/sudoers.d/deploy    # visudo sintaksisni tekshiradi
```

```
# faqat ilovani boshqarish
deploy ALL=(root) /usr/bin/systemctl restart portal, /usr/bin/systemctl status portal
# avtomatlashtirish uchun parolsiz, lekin faqat shu buyruqlar
deploy ALL=(root) NOPASSWD: /usr/local/bin/deploy-portal.sh
```

Qoidalar:

- `/etc/sudoers` ni to'g'ridan-to'g'ri tahrirlamang; `/etc/sudoers.d/` ga alohida fayl qo'ying (fayl nomida nuqta bo'lmasin — e'tiborsiz qoldiriladi).
- `NOPASSWD: ALL` — odam ishlatadigan akkaunt uchun yaramaydi.
- Cheklangan ro'yxatga **shelldan chiqish yo'li** bo'lgan buyruqlarni kiritmang: `vim`, `less`, `find`, `tar`, `awk` — bularning hammasidan ichidan shell ochish mumkin, ya'ni cheklov ma'nosiz bo'lib qoladi.
- `sudo` loglari `journalctl -t sudo` da — kim nima qilganini shu yerdan ko'rasiz.

Tekshirish: `sudo -l -U deploy` o'sha foydalanuvchiga nima ruxsat berilganini ko'rsatadi.$a$],

[$q$SSH uchun ikki faktorli autentifikatsiya qo'yish mumkinmi?$q$,
$a$Ha, uch xil yo'l bor.

**1. Kalit + parol-fraza** — eng oddiy va amalda yetarli: maxfiy kalit (narsa) + fraza (bilim). `ssh-agent` bilan har safar yozish kerak bo'lmaydi:

```bash
ssh-add ~/.ssh/id_ed25519
```

**2. Apparat kaliti (FIDO2/YubiKey)** — zamonaviy OpenSSH buni o'zi qo'llab-quvvatlaydi:

```bash
ssh-keygen -t ed25519-sk -C "yubikey"
```

Maxfiy kalit qurilmani tark etmaydi, kirish uchun kalitga tegish kerak. Noutbuk o'g'irlansa ham kirishga yaramaydi.

**3. TOTP (Google Authenticator)**:

```bash
apt install libpam-google-authenticator && google-authenticator
```

`/etc/ssh/sshd_config`:
```
KbdInteractiveAuthentication yes
AuthenticationMethods publickey,keyboard-interactive
```

`AuthenticationMethods` dagi vergul "ikkisi ham kerak" degani — bu haqiqiy 2FA. Vergul o'rniga bo'shliq qo'yilsa "biri yetarli" bo'lib qoladi.

Avtomatlashtirish akkauntlari (CI, deploy) uchun TOTP yaramaydi — ularga alohida, cheklangan kalit ajratish kerak.$a$],

[$q$Kalitlarni qanday boshqarish va almashtirish kerak?$q$,
$a$Bir nechta foydalanuvchi bo'lsa, `authorized_keys` ni qo'lda tahrirlash tez chalkashib ketadi. Amaliy tartib:

1. **Har bir odamga o'z kaliti.** Umumiy kalitni bir necha kishi ishlatmasin — kimning kirgani bilinmaydi va bir kishi ketganda hammani almashtirish kerak bo'ladi.
2. **Kalitlarni izohlang.** `ssh-keygen -C "ism@qurilma"` — keyin `authorized_keys` o'qiladigan bo'ladi.
3. **Ro'yxatni konfiguratsiya sifatida saqlang** (Ansible, yoki hech bo'lmasa git'dagi fayl) — serverda qo'lda emas.
4. **Ketgan odamning kalitini darhol olib tashlang** va u ishlatgan har qanday xizmat tokenini bekor qiling.
5. **Deploy/CI kalitlari alohida bo'lsin** va cheklangan: `authorized_keys` da
   ```
   command="/usr/local/bin/deploy-only.sh",no-pty,no-port-forwarding ssh-ed25519 AAAA...
   ```
   Bunda o'sha kalit bilan faqat bitta skript ishga tushadi, interaktiv shell ochilmaydi.

Audit uchun:

```bash
ssh-keygen -lf ~/.ssh/authorized_keys     # har bir kalitning fingerprinti
journalctl -u ssh | grep "Accepted publickey"   # qaysi kalit bilan kim kirgan
```

Oxirgi buyruq fingerprint'ni ko'rsatadi, shuning uchun 1-qoidaga rioya qilinsa, kirishlarni aniq odamga bog'lash mumkin bo'ladi.$a$]
]);

SELECT pg_temp.seed_doc('xavfsizlik', 'Parollar, sirlar va ularni saqlash', ARRAY[
[$q$Parolni bazada qanday saqlash kerak?$q$,
$a$Faqat **sekin, tuzli hash** ko'rinishida. Hech qachon ochiq matnda, hech qachon shifrlangan holda (shifrni ochish kaliti ham o'g'irlanadi) va hech qachon `md5`/`sha256` bilan.

Nega `sha256` yaramaydi: u tez. Zamonaviy GPU sekundiga milliardlab `sha256` hisoblaydi, ya'ni lug'at hujumi arzon. Parol hashlari ataylab sekin bo'lishi kerak.

To'g'ri tanlovlar: **Argon2id** (bugungi tavsiya), **bcrypt** (keng tarqalgan, ishonchli), **scrypt**.

Bu loyihada backend `argon2` ishlatadi — `backend/src/auth.rs` ga qarang. Umumiy shakli:

```rust
let hash = Argon2::default().hash_password(password.as_bytes(), &salt)?;
// tekshirish
Argon2::default().verify_password(password.as_bytes(), &parsed_hash)?;
```

Yana ikki nuqta:

- **Tuz (salt) har parol uchun alohida** va hash satrining ichida saqlanadi — alohida ustun shart emas.
- **Vaqt bo'yicha barqaror solishtirish**: `==` bilan emas, kutubxonaning `verify` funksiyasi bilan.
- Kirish muvaffaqiyatsiz bo'lganda "parol xato" va "foydalanuvchi topilmadi" uchun **bir xil** javob va bir xil javob vaqti qaytarilishi kerak, aks holda akkauntlarni sanab chiqish mumkin bo'ladi.$a$],

[$q$Sirlarni (API kalitlari, baza paroli) qayerda saqlash kerak?$q$,
$a$Darajalar bo'yicha:

1. **Kodda — hech qachon.** Git tarixi abadiy; bir marta commit qilingan sir o'g'irlangan hisoblanadi.
2. **Muhit o'zgaruvchilari / `.env` fayli** — kichik loyiha uchun amaliy minimum. Shartlar: `.gitignore` da, `chmod 600`, va faqat kerakli foydalanuvchiga tegishli.
3. **Sir boshqaruvi** (Vault, AWS SSM, SOPS bilan shifrlangan fayl) — bir nechta muhit yoki jamoa bo'lsa.

Bu loyihada `.env` ishlatiladi va `.env.example` qiymatsiz shablon sifatida commit qilingan — yangi sirni qo'shganda shablonni ham yangilash kerak, aks holda keyingi odam nimani to'ldirishni bilmaydi.

Qo'shimcha amaliy qoidalar:

- Sirlarni **log'ga yozmang**. Konfiguratsiyani log'ga chiqaradigan kod bo'lsa, parol maydonlarini maskalang.
- Xato xabarlarida ulanish satrini to'liq ko'rsatmang — unda parol bo'ladi.
- CI'da sirlar platformaning secret'lari orqali uzatilsin, `echo` qilinmasin.
- Har bir muhit (dev, staging, prod) **alohida** sirlarga ega bo'lishi kerak.$a$],

[$q$Sir git'ga tushib qolsa nima qilaman?$q$,
$a$Birinchi va eng muhim qadam: **sirni bekor qilib, yangisini yarating.** Tarixni tozalash ikkinchi darajali ish — sir allaqachon klonlarda, CI keshlarida va ehtimol skanerlarda.

Tartib:

1. Kalitni rotatsiya qiling (baza paroli, API token, SSH kaliti — qaysi bo'lsa).
2. Loglardan foydalanilgan-foydalanilmaganini tekshiring.
3. Keyin tarixdan olib tashlang:

```bash
# git-filter-repo (tavsiya etilgan vosita)
git filter-repo --invert-paths --path .env

# yoki faqat matnni almashtirish
git filter-repo --replace-text <(echo 'eski_sir==>OLIB_TASHLANDI')
```

4. Majburiy push: `git push --force-with-lease --all` va teglar uchun ham.
5. Hamma hamkasbga **qaytadan klon qilishni** aytish kerak — ularning lokal tarixida sir qoladi va keyin yana push bo'lib ketishi mumkin.

Oldini olish:

```bash
# commit oldidan tekshiradigan hook
pip install detect-secrets && detect-secrets scan > .secrets.baseline
```

yoki `gitleaks` ni CI'ga qo'shish. GitHub'da "secret scanning" va "push protection" ni yoqib qo'yish ham bepul va samarali.$a$],

[$q$Sessiya va cookie'larni xavfsiz qilish uchun nima kerak?$q$,
$a$Cookie'ga qo'yiladigan atributlar:

```
Set-Cookie: session=...; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800
```

- **`HttpOnly`** — JavaScript o'qiy olmaydi, ya'ni XSS tokenni o'g'irlay olmaydi.
- **`Secure`** — faqat HTTPS orqali yuboriladi.
- **`SameSite=Lax`** — begona saytdan kelgan so'rovlarga qo'shilmaydi; CSRF'ning asosiy qismini to'sadi.
- **`Path` va `Max-Age`** — qamrov va muddatni cheklaydi.

Server tomonida:

- Sessiya ID **kriptografik tasodifiy** bo'lishi kerak (kamida 128 bit), ketma-ket son emas.
- Kirishdan **keyin** yangi sessiya ID berish (session fixation'dan himoya).
- Chiqishda sessiyani serverda ham o'chirish — faqat cookie'ni tozalash yetarli emas.
- Muddati tugagan sessiyalarni tozalab borish.

Bu loyihada sessiyalar Postgres'da saqlanadi (xotirada emas), shuning uchun server qayta ishga tushganda foydalanuvchilar tashqarida qolmaydi va bir nechta nusxa bir xil sessiyani ko'radi. Buning narxi — eskirgan qatorlarni tozalash kerak:

```sql
DELETE FROM sessions WHERE expires_at < now();
```$a$],

[$q$API tokenlarini qanday boshqarish kerak?$q$,
$a$Asosiy qoidalar:

1. **Bazada tokenning o'zini saqlamang** — hashini saqlang. Baza o'qib ketilsa, tokenlar ishlamasin.
2. **Prefiks qo'shing**: `portal_live_a1b2...`. Shunda token log'ga tushsa avtomatik skanerlar uni tanib oladi va egasiga xabar beradi.
3. **Muddat belgilang.** Abadiy token — abadiy xavf.
4. **Qamrovni (scope) cheklang**: faqat o'qish uchun token alohida bo'lsin.
5. **Oxirgi ishlatilgan vaqtni yozib boring** — ishlatilmayotganlarini topib o'chirish uchun.
6. **Bekor qilish yo'li bo'lsin** va u darhol kuchga kirsin.

Tokenni foydalanuvchiga **faqat bir marta** ko'rsatish kerak (yaratilganda), keyin boshqa ko'rsatmaslik — chunki siz faqat hashini bilasiz.

Uzatish: har doim `Authorization: Bearer ...` sarlavhasida. URL query'ga qo'yish eng ko'p takrorlanadigan xato — URL'lar server loglariga, brauzer tarixiga va `Referer` sarlavhasiga tushadi.

Rate limiting ham token bo'yicha qo'yilsa, o'g'irlangan tokenning zarari cheklanadi.$a$],

[$q$Sirlarni qanchalik tez-tez almashtirish kerak?$q$,
$a$Majburiy almashtirish holatlari (muhokamasiz):

- Sir biror joyga (git, log, chat, ekran surati) chiqib ketgan.
- Unga ruxsati bo'lgan odam jamoani tark etgan.
- Ishlatilgan qurilma yo'qolgan yoki buzilgan.

Rejali almashtirish — qolgan hollarda. "Har 90 kunda hammasini almashtirish" degan qoida ko'pincha zarar keltiradi: jarayon qo'lda bo'lsa, odamlar uni chetlab o'tadi yoki ishni buzadi. Amaliyroq yondashuv:

- Rotatsiyani **avtomatlashtirish** (shunda tez-tez qilish arzon bo'ladi).
- **Ikki kalitni bir vaqtda qabul qilish** davrini qo'yish — yangi kalit joylashtirilgandan keyin eskisi o'chiriladi, uzilish bo'lmaydi.
- Eng muhim sirlarga (baza paroli, imzolash kaliti) qisqa muddat, kamroq xavfli narsalarga uzun muddat.

Yozib qo'yish kerak: qaysi sir qayerda ishlatiladi. Rotatsiya vaqtida eng ko'p vaqt aynan "bu parol yana qayerda yozilgan?" degan savolga ketadi. Oddiy jadval — sir nomi, qaysi xizmat, qayerda saqlanadi, kim mas'ul — butun ishni bir necha baravar osonlashtiradi.$a$]
]);

SELECT pg_temp.seed_doc('xavfsizlik', 'Veb ilovadagi asosiy zaifliklar', ARRAY[
[$q$SQL injection qanday yuzaga keladi va qanday to'sib qo'yiladi?$q$,
$a$Foydalanuvchi kiritgan matn so'rov matniga **qo'shib yuborilganda**:

```python
# ZAIF
cur.execute(f"SELECT * FROM users WHERE username = '{name}'")
```

`name` sifatida `' OR 1=1 --` yuborilsa, shart har doim rost bo'ladi.

To'g'ri yo'l — **parametrlangan so'rov**. Qiymat hech qachon so'rov matniga qo'shilmaydi, baza uni alohida oladi:

```rust
sqlx::query("SELECT * FROM users WHERE username = $1")
    .bind(&name)
```

Bu loyiha hamma joyda `sqlx` ning `bind` mexanizmidan foydalanadi — yangi kod yozganda ham shu qoidadan chetga chiqmaslik kerak.

Qo'shimcha nuqtalar:

- **Jadval yoki ustun nomini** parametr qilib bo'lmaydi. Dinamik saralash kerak bo'lsa, ruxsat etilgan nomlar ro'yxatidan tanlang (`allowlist`), satrni to'g'ridan-to'g'ri qo'shmang.
- **ORM ham himoya kafolati emas**: `raw` yoki `.where("...")` kabi xom SQL qabul qiladigan joylar baribir zaif.
- Baza foydalanuvchisiga faqat kerakli huquqlarni bering — injection yuz bersa ham zarar cheklangan bo'ladi.$a$],

[$q$XSS nima va qanday himoyalanadi?$q$,
$a$XSS — tajovuzkor sahifaga o'z JavaScript'ini kirita olishi. Oqibati: sessiya o'g'irlanadi, foydalanuvchi nomidan amallar bajariladi.

Uch turi: **saqlangan** (bazaga yozilib, hammaga ko'rsatiladi — eng xavfli), **aks etgan** (URL parametridan sahifaga tushadi), **DOM-based** (brauzerdagi kod `innerHTML` ga ishonadi).

Himoya qatlamlari:

1. **Chiqishda ekranlash.** React standart holatda matnni ekranlaydi — `{text}` xavfsiz. Xavf faqat `dangerouslySetInnerHTML` da.
2. **Markdown/HTML'ni tozalash.** Bu loyihada hujjat javoblari markdown sifatida render qilinadi, ya'ni natijada HTML paydo bo'ladi — shuning uchun render natijasi sanitizatsiya qilinishi kerak (`<script>`, `onerror=`, `javascript:` havolalar olib tashlanadi).
3. **CSP sarlavhasi** — ikkinchi qatlam:
   ```
   Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none'
   ```
   `unsafe-inline` qo'shilsa, CSP'ning asosiy foydasi yo'qoladi.
4. **`HttpOnly` cookie** — XSS yuz bersa ham sessiya tokeni o'qilmaydi.

Eng ko'p e'tibordan chetda qoladigan joy — foydalanuvchi kiritgan **havolalar**: `javascript:alert(1)` ko'rinishidagi `href` ham XSS. Sxemani tekshirish kerak (`http`, `https`, `mailto` dan boshqasi rad etilsin).$a$],

[$q$CSRF nima va `SameSite` yetarlimi?$q$,
$a$CSRF — foydalanuvchi sizning saytingizga kirgan holatda begona saytga tashrif buyuradi, o'sha sayt sizning API'ingizga so'rov yuboradi va brauzer cookie'ni avtomatik qo'shib yuboradi. Natijada foydalanuvchi bilmagan amal bajariladi.

**`SameSite=Lax`** bugungi brauzerlarda bu hujumning asosiy qismini to'sadi: cookie boshqa saytdan kelgan `POST` so'rovlarga qo'shilmaydi. Ko'p ilova uchun bu amalda yetarli himoya.

Lekin to'liq ishonch uchun qo'shimcha choralar kerak:

- **O'zgartiruvchi amallar `GET` da bo'lmasin.** `GET /delete?id=5` — rasm tegi orqali ham chaqirilib ketadi va `SameSite` bunda yordam bermaydi (`Lax` yuqori darajali `GET` navigatsiyalarda cookie'ni yuboradi).
- **CSRF token** — forma bilan birga yuboriladigan va serverda tekshiriladigan tasodifiy qiymat.
- **`Origin` / `Referer` sarlavhasini tekshirish** — oddiy va samarali qo'shimcha.
- JSON API uchun `Content-Type: application/json` talab qilish ham to'siq qo'shadi, chunki oddiy forma bunday so'rov yubora olmaydi.

Token autentifikatsiyasi (`Authorization` sarlavhasi) ishlatilsa CSRF umuman yuzaga kelmaydi — brauzer bu sarlavhani o'zi qo'shmaydi.$a$],

[$q$IDOR va ruxsat tekshirish xatolari nima?$q$,
$a$Eng ko'p uchraydigan va eng kam e'tibor beriladigan zaiflik. Ilova "kim kirgan" ni tekshiradi (autentifikatsiya), lekin "bu narsaga huquqi bormi" ni tekshirmaydi (avtorizatsiya):

```
GET /api/documents/123     → o'z hujjatim
GET /api/documents/124     → boshqa odamning hujjati, lekin baribir ochiladi
```

Qoidalar:

1. **Har bir so'rovda** obyekt egasini yoki ruxsatni tekshirish. Bitta joyda emas, har bir endpoint'da — yoki markazlashgan qatlamda, lekin chetlab o'tilmaydigan tarzda.
2. Tekshiruvni **so'rovning o'ziga** singdirish ko'pincha ishonchliroq:
   ```sql
   SELECT * FROM documents WHERE id = $1 AND author_id = $2
   ```
   Shunda "tekshirishni unutish" imkoniyati kamayadi.
3. **Frontend'dagi yashirish — himoya emas.** Tugmani ko'rsatmaslik API'ni himoya qilmaydi.
4. Ketma-ket ID o'rniga UUID ishlatish **sanab chiqishni** qiyinlashtiradi, lekin avtorizatsiyani almashtirmaydi. Bu loyihada ID'lar UUID — bu foydali, ammo tekshiruv baribir kerak.

Tekshirish usuli oddiy: ikki akkaunt yarating, biri bilan obyekt yarating, ikkinchisining sessiyasi bilan uning ID'siga murojaat qilib ko'ring. Javob `403`/`404` bo'lishi kerak.$a$],

[$q$Rate limiting nima uchun kerak va qanday qo'yiladi?$q$,
$a$Himoya qiladigan narsalar: parol taxmin qilish (brute force), akkauntlarni sanab chiqish, qimmat so'rovlar bilan serverni bo'g'ish, SMS/email yuborish orqali pul sarflash.

Qatlamlar:

```nginx
# nginx darajasida
limit_req_zone $binary_remote_addr zone=login:10m rate=5r/m;
location /api/auth/login {
    limit_req zone=login burst=3 nodelay;
    proxy_pass http://127.0.0.1:3000;
}
```

Ilova darajasida ham kerak, chunki u kontekstni biladi: IP bo'yicha emas, **foydalanuvchi nomi** bo'yicha cheklash login uchun ancha samarali (bitta IP ortida butun ofis bo'lishi mumkin, yoki hujumchi IP'larni almashtirib turadi).

Amaliy qiymatlar:

- Login: 5-10 urinish/daqiqa, keyin o'sib boruvchi kechikish.
- Parolni tiklash / email yuborish: soatiga bir necha marta.
- Oddiy o'qish API'lari: ancha bo'sh, 60-600 so'rov/daqiqa.

Reverse proxy ortida ishlaganda **haqiqiy IP**ni olish muhim: `X-Forwarded-For` ishonchli proxy'dan kelganda hisobga olinadi, aks holda hujumchi uni o'zi yozib cheklovni chetlab o'tadi.

Javob `429 Too Many Requests` va `Retry-After` sarlavhasi bilan qaytarilishi kerak.$a$],

[$q$Fayl yuklashni qanday xavfsiz qilaman?$q$,
$a$Fayl yuklash — eng ko'p xato qilinadigan joylardan biri. Tekshirish ro'yxati:

1. **Hajmni cheklang** — ilovada ham, proxy'da ham (`client_max_body_size 10m`).
2. **Turni mazmun bo'yicha tekshiring**, kengaytma yoki mijoz yuborgan `Content-Type` bo'yicha emas. Fayl boshidagi "magic bytes" ishonchliroq.
3. **Nomni o'zingiz bering.** Foydalanuvchi yuborgan nomni ishlatmang: unda `../../etc/passwd`, nol bayt yoki juda uzun nom bo'lishi mumkin. UUID + tekshirilgan kengaytma — eng xavfsizi.
4. **Yuklangan fayllarni bajariladigan qilib qo'ymang.** Katalogda skript bajarilishi o'chirilgan bo'lishi, ideal holda fayllar veb-ildizdan **tashqarida** turishi kerak.
5. **Chiqarishda to'g'ri sarlavhalar**:
   ```
   Content-Type: application/octet-stream
   Content-Disposition: attachment; filename="..."
   X-Content-Type-Options: nosniff
   ```
   SVG va HTML'ni inline ko'rsatish XSS'ga olib keladi, chunki ularning ichida skript bo'lishi mumkin.
6. **Ruxsatni tekshiring** — yuklash ham, yuklab olish ham. Fayl yo'li taxmin qilinadigan bo'lsa, u ochiq havola bilan teng.

Bu loyihada yuklangan fayllar `uploads/` katalogida va bazadagi `uploads` jadvalida qayd etiladi — kim yuklaganini bilish uchun shu jadval ishlatiladi.$a$]
]);


-- 6. Git va CI/CD ------------------------------------------------------------

SELECT pg_temp.seed_doc('git-cicd', 'Git bilan kundalik ish oqimi', ARRAY[
[$q$Branch strategiyasini qanday tanlayman?$q$,
$a$Kichik va o'rta jamoalar uchun **trunk-based** eng amaliy: `main` har doim ishlashga yaroqli, har bir ish qisqa umrli branch'da bajariladi va bir-ikki kun ichida qaytib qo'shiladi.

```bash
git switch -c feat/telegram-xabarnoma
# ... ish ...
git push -u origin feat/telegram-xabarnoma
# PR → review → merge
```

Nomlash odati foydali: `feat/`, `fix/`, `chore/`, `docs/` prefikslari ro'yxatni o'qiladigan qiladi.

**Git Flow** (`develop`, `release/*`, `hotfix/*`) — versiyalangan, relizlari rejali mahsulotlar uchun. Uzluksiz deploy qilinadigan veb ilovada u ortiqcha yuk beradi.

Asosiy qoida branch nomida emas: **branch qancha uzoq yashasa, merge shuncha og'riqli bo'ladi.** Katta ishni bir nechta kichik, mustaqil qo'shiladigan qismga bo'lish — konfliktlardan qutulishning eng ishonchli yo'li. Yarim tayyor funksiyani yopib turish kerak bo'lsa, feature flag ishlatish uzoq branch'dan afzal.$a$],

[$q$Commit xabarini qanday yozish kerak?$q$,
$a$Ko'p loyihalar **Conventional Commits** shaklini ishlatadi:

```
feat(backend): sessiyalarni Postgres'da saqlash
fix(frontend): orqaga havolasidagi takroriy strelkani olib tashlash
docs: deploy qo'llanmasini yangilash
```

Tuzilishi: `tur(qamrov): buyruq shaklida qisqa tavsif`.

Amaliy qoidalar:

- Birinchi qator 72 belgidan oshmasin va nuqta bilan tugamasin.
- **Nima qilingani emas, nega qilingani** muhim — "nima" diff'da ko'rinadi. Sababni tanaga yozing.
- Bo'sh qatordan keyin batafsil tushuntirish; `Fixes #123` kabi havolalar oxirida.
- Bitta commit — bitta mantiqiy o'zgarish. "Hammasini tuzatdim" degan commit'ni keyin tahlil qilish ham, qaytarish ham qiyin.

Nega bu muhim: `git log`, `git blame` va `git bisect` — bularning hammasi commit tarixining sifatiga tayanadi. Yarim yildan keyin "bu qator nega shunday?" degan savolga javobni faqat yaxshi yozilgan commit beradi.

Bu repozitoriyda tarix aynan shu uslubda yuritilgan — `git log --oneline` ga qarab namuna olish mumkin.$a$],

[$q$rebase va merge — qaysi birini ishlatish kerak?$q$,
$a$**Merge** tarixni o'zgartirmaydi, qo'shimcha commit yaratadi va haqiqatan nima bo'lganini ko'rsatadi.

**Rebase** commit'larni yangi asos ustiga ko'chirib yozadi, natijada tarix chiziqli va o'qishga oson bo'ladi.

Amaliy qoida:

- **O'z branch'ingizni** `main` ga yangilash uchun `rebase` — toza tarix beradi:
  ```bash
  git fetch origin && git rebase origin/main
  ```
- **Umumiy branch'ni** (`main`) rebase qilmang. Qoida oddiy: **boshqalar tortib olgan commit'lar tarixini qayta yozmang.**
- PR'ni qo'shishda `squash merge` ko'p jamoada afzal: bitta funksiya bitta commit bo'ladi, `main` tarixi tiniq qoladi.

Rebase o'rtasida konflikt chiqsa:

```bash
# tuzating, keyin
git add <fayl> && git rebase --continue
git rebase --abort        # hammasini bekor qilib, boshiga qaytish
```

Rebase'dan keyin push qilish uchun `--force` kerak bo'ladi — lekin har doim `--force-with-lease` ishlatilsin: u sizdan keyin kimdir push qilgan bo'lsa, ishini o'chirib yubormaydi.$a$],

[$q$Konfliktni qanday hal qilaman?$q$,
$a$Konflikt — ikki tomon bir xil qatorlarni o'zgartirgani. Git belgilarni qo'yib, qarorni sizga qoldiradi:

```
<<<<<<< HEAD
let timeout = 30;
=======
let timeout = 60;
>>>>>>> feat/x
```

Tartib:

```bash
git status                 # qaysi fayllarda konflikt bor
# fayllarni tahrirlang, belgilarni butunlay olib tashlang
git add <fayl>
git rebase --continue      # yoki: git merge --continue
```

Foydali vositalar:

```bash
git diff --name-only --diff-filter=U    # faqat konfliktli fayllar
git checkout --ours <fayl>              # butunlay bizning versiya
git checkout --theirs <fayl>            # butunlay ularning versiyasi
git mergetool                           # vizual vosita
```

`--ours` va `--theirs` ma'nosi rebase vaqtida **almashadi** (chunki sizning commit'laringiz qayta qo'llanadi) — shuning uchun bu bayroqlarni ko'r-ko'rona ishlatmaslik, natijani ko'rib chiqish kerak.

Hal qilgandan keyin kodni **albatta ishga tushirib ko'ring**: konflikt sintaksis darajasida hal bo'lgan bo'lishi mumkin, lekin mantiq buzilgan bo'ladi. Avtomatik hal qilingan joylar ham xavfli — git ikki tomonning o'zgarishini qo'shib qo'yadi, natija esa ma'nosiz bo'lishi mumkin.$a$],

[$q$Ishni vaqtincha chetga qo'yish va o'zgarishlarni bekor qilish qanday?$q$,
$a$**Vaqtincha saqlash:**

```bash
git stash push -m "yarim tayyor filtr"
git stash list
git stash pop            # qaytarib, stash'ni o'chiradi
git stash apply          # qaytarib, stash'ni saqlab qoladi
git stash push -p        # tanlab, bo'laklab
```

**Bekor qilish — eng ko'p chalkashtiriladigan joy:**

```bash
git restore <fayl>                 # fayldagi saqlanmagan o'zgarishlar yo'qoladi
git restore --staged <fayl>        # staging'dan chiqaradi, o'zgarish qoladi
git reset --soft HEAD~1            # oxirgi commit'ni yechadi, o'zgarish qoladi
git reset --hard HEAD~1            # commit ham, o'zgarish ham YO'QOLADI
git revert <commit>                # teskari commit yaratadi — umumiy branch uchun
```

`--hard` va `restore` qaytarilmaydi — commit qilinmagan ish butunlay yo'qoladi.

**Adashsangiz — `reflog`:**

```bash
git reflog                    # HEAD qayerlarda bo'lgani
git reset --hard HEAD@{3}     # shu holatga qaytish
```

`reflog` commit qilingan har qanday narsani (hatto `reset --hard` dan keyin ham) 90 kun ichida qaytarish imkonini beradi. Shuning uchun xavfli operatsiyadan oldin tezda `git commit` qilib qo'yish — eng arzon sug'urta.$a$],

[$q$Katta yoki keraksiz fayllarni tarixdan qanday olib tashlayman?$q$,
$a$Avval oldini olish: `.gitignore` ni loyiha boshida to'g'ri yozish. Bu repozitoriyda `target/`, `node_modules/`, `.env`, `.pgdata/` allaqachon chiqarib tashlangan.

Tarixga tushib qolgan bo'lsa:

```bash
# eng katta obyektlarni topish
git rev-list --objects --all \
  | git cat-file --batch-check='%(objecttype) %(objectname) %(objectsize) %(rest)' \
  | awk '$1=="blob"' | sort -k3 -n | tail -20

# olib tashlash
git filter-repo --path node_modules --invert-paths
git filter-repo --strip-blobs-bigger-than 10M
```

`git filter-repo` — `filter-branch` ning zamonaviy o'rnini bosuvchisi (ancha tez va xavfsiz).

Shundan keyin:

1. `git push --force-with-lease --all` va `--tags`.
2. Hamkasblarga **qaytadan klon qilishni** aytish — aks holda ular eski tarixni qaytarib push qiladi.
3. Agar olib tashlangan narsa sir bo'lsa — **uni albatta rotatsiya qiling**, tarixni tozalash yetarli emas.

Katta binar fayllar haqiqatan kerak bo'lsa, `git-lfs` ishlatish to'g'ri yechim: fayllar alohida saqlanadi, repozitoriyda faqat ko'rsatkich qoladi.$a$]
]);

SELECT pg_temp.seed_doc('git-cicd', 'Kod review va pull request', ARRAY[
[$q$Nega PR kichik bo'lishi kerak?$q$,
$a$Review sifati PR hajmiga teskari proporsional. 50 qatorli o'zgarishda haqiqiy xatolar topiladi; 2000 qatorli PR'da esa "LGTM" yoziladi, chunki uni jiddiy ko'rib chiqish bir necha soat oladi.

Amaliy chegara — **400 qatorgacha**. Kattaroq bo'lsa, bo'lish yo'lini izlash kerak:

- Refaktoring alohida PR, funksional o'zgarish alohida. Ikkisi bitta diff'da bo'lsa, haqiqiy o'zgarishni ko'rish imkonsiz.
- Avval API/interfeys, keyin implementatsiya.
- Migratsiya alohida, uni ishlatadigan kod keyingi PR'da.
- Faylni ko'chirish/nomini o'zgartirish — har doim alohida commit yoki PR.

Qo'shimcha foyda: kichik PR tez qo'shiladi, demak konflikt kamroq, demak ish tezroq oqadi. Katta PR esa navbatda turganda `main` ketib qoladi va rebase azobi boshlanadi.

PR tavsifida yozish kerak: **nima**, **nega**, va **qanday tekshirildi**. Oxirgisi eng ko'p e'tibordan chetda qoladi, lekin reviewer uchun eng foydali qism.$a$],

[$q$Review paytida nimaga e'tibor berish kerak?$q$,
$a$Prioritet tartibida:

1. **To'g'rilik** — mantiq ishlaydimi, chegaraviy holatlar (bo'sh ro'yxat, `null`, 0, juda katta qiymat) hisobga olinganmi?
2. **Xavfsizlik** — avtorizatsiya tekshirilganmi, kirish ma'lumotlari validatsiya qilinganmi, SQL parametrlanganmi, sir log'ga tushmayaptimi?
3. **Xatolarni qayta ishlash** — xato yo'li sinovdan o'tganmi, yoki `unwrap()` bilan yiqiladimi?
4. **Testlar** — yangi mantiq qoplanganmi, test haqiqatan biror narsani tekshiradimi?
5. **Soddalik va qayta ishlatish** — bu kod loyihada allaqachon bormi? Soddaroq yo'l bormi?
6. **Nomlash va o'qiluvchanlik** — yarim yildan keyin tushunarli bo'ladimi?
7. **Uslub** — eng oxirida, chunki buni linter va formatter avtomatik bajarishi kerak.

Foydali savol: "bu o'zgarish buzilsa, biz qanday bilib qolamiz?" Agar javob yo'q bo'lsa, log yoki metrika yetishmayapti.

Ko'rib chiqishda **ishga tushirib ko'rish** ham review'ning bir qismi. Faqat diff o'qish bilan ko'p narsa sezilmaydi — ayniqsa UI o'zgarishlarida.$a$],

[$q$Review izohlarini qanday yozish kerak?$q$,
$a$Izoh **kodga** qaratilsin, odamga emas. "Bu yerda `null` bo'lishi mumkinmi?" — "siz unutgansiz" dan ko'ra ishchiroq.

Darajani aniq ko'rsatish katta farq qiladi:

- **blocking** — qo'shishdan oldin tuzatilishi kerak.
- **nit** — mayda, ixtiyoriy ("nit: nom `x` dan ko'ra `count` aniqroq").
- **question** — tushunmadim, tushuntirib bering.
- **praise** — yaxshi yechimni alohida aytish. Bu formallik emas: review faqat tanqiddan iborat bo'lsa, odamlar undan qochadi.

Yana ikki foydali odat:

- **Sababni yozish.** "Bu sekin" dan ko'ra "bu har qator uchun alohida so'rov yuboradi — N+1; bitta `IN (...)` bilan olish mumkin" ancha foydali.
- **Variantni taklif qilish.** Muammoni ko'rsatib, yo'l ham ko'rsatilsa, muhokama bir aylanishda tugaydi.

Muallif tomonidan: har bir izohga javob berish kerak — tuzatildi, yoki nega tuzatilmadi. Javobsiz qoldirilgan izoh keyin yana ko'tariladi va vaqt yo'qoladi.

Ikki-uch aylanishdan keyin ham kelishuv bo'lmasa, matnli muhokamani to'xtatib, ovozli gaplashish tezroq hal qiladi.$a$],

[$q$CI tekshiruvlarini majburiy qilish kerakmi?$q$,
$a$Ha. Odam e'tiboriga qoldirilgan narsa muqarrar o'tkazib yuboriladi.

GitHub'da `main` uchun branch protection: PR talab qilinadi, kamida bitta tasdiq, va **status check majburiy**.

Bu loyihada tekshiruvlar `justfile` da bir joyga yig'ilgan:

```bash
just ci     # fmt-check, lint, check-web, test
```

Shu bitta buyruq ham lokalda, ham GitHub Actions'da ishlatilsa, "mahalliyda o'tdi, CI'da yiqildi" holati kamayadi.

Majburiy qilish uchun yaxshi nomzodlar:

- formatlash tekshiruvi (`cargo fmt --check`) — bahs qilinmaydi, avtomatik;
- linter, ogohlantirishlar xato sifatida (`clippy -D warnings`);
- tiplar (`tsc --noEmit`);
- testlar;
- migratsiyalar toza bazada qo'llanishi.

Qo'shimcha nuqta: CI **tez** bo'lishi kerak. 20 daqiqalik quvur odamlarni uni chetlab o'tishga undaydi. Keshlash (`~/.cargo`, `node_modules`) va ishlarni parallellashtirish shu sababli ikkinchi darajali masala emas.$a$],

[$q$Squash, merge commit yoki rebase merge — qaysi biri?$q$,
$a$**Squash merge** — PR'dagi hamma commit bitta bo'lib `main` ga tushadi.

- `main` tarixi juda toza: bitta funksiya — bitta commit, `git bisect` oson.
- Oraliq commit'lar yo'qoladi (lekin PR'da saqlanib qoladi).
- Ko'p jamoada standart tanlov, ayniqsa commit'lar "wip", "fix typo" bo'lsa.

**Merge commit** — butun tarix saqlanadi, qo'shimcha commit qo'shiladi.

- Nima bo'lganini to'liq ko'rsatadi.
- Grafik murakkablashadi.
- Har bir commit mazmunli bo'lgan jamoalarda yaxshi ishlaydi.

**Rebase merge** — commit'lar `main` ustiga chiziqli ko'chiriladi, merge commit yo'q.

- Chiziqli tarix + alohida commit'lar saqlanadi.
- Lekin commit'lar yangi xeshga ega bo'ladi va ularning hech biri alohida sinovdan o'tmagan bo'lishi mumkin.

Tanlov jamoa odatiga bog'liq, lekin **bitta usulni tanlab, hammasiga qo'llash** muhim — aralash tarixni o'qish qiyin. Squash tanlasangiz, PR sarlavhasi `main` dagi commit xabariga aylanadi, shuning uchun sarlavhani Conventional Commits uslubida yozish odatini kiritish kerak.$a$],

[$q$Bir nechta PR bir-biriga to'sqinlik qilsa nima qilaman?$q$,
$a$Avval sababni ko'ring: odatda bu PR'lar juda uzoq yashayotgani yoki bir xil fayllarga tegayotganini bildiradi.

Amaliy choralar:

1. **Tartib belgilang.** Birini qo'shib, qolganlarini rebase qilish — eng oddiy yo'l. Navbatni oldindan kelishib olish vaqt tejaydi.
2. **Bog'liq PR zanjiri** (stacked PRs): B branch'i A ustida qurilgani ochiq ko'rsatiladi, A qo'shilgandan keyin B avtomatik toza bo'lib qoladi.
3. **Tez-tez rebase qiling.** Kunda bir marta `git fetch && git rebase origin/main` konfliktni kichik-kichik hal qilish imkonini beradi; haftada bir marta qilsangiz, bir katta jang bo'ladi.
4. **Faylni qayta tuzishni alohida ajratib oling** va uni birinchi qo'shing — formatlash yoki ko'chirish PR'i hamma narsa bilan konflikt qiladi, shuning uchun uni navbatda ushlab turish eng yomon variant.
5. **Mexanik konfliktlarni avtomatlashtiring.** Lock fayllar (`package-lock.json`, `Cargo.lock`) uchun qo'lda hal qilish o'rniga, `main` versiyasini olib buyruqni qayta ishga tushirish to'g'riroq:
   ```bash
   git checkout origin/main -- package-lock.json && npm install
   ```

Umumiy xulosa bitta: konflikt — kod muammosi emas, jarayon muammosi. Kichik PR va tez qo'shish bu muammoni manbasida hal qiladi.$a$]
]);

SELECT pg_temp.seed_doc('git-cicd', 'GitHub Actions bilan CI quvuri', ARRAY[
[$q$Workflow fayli qanday tuzilgan?$q$,
$a$`.github/workflows/ci.yml`:

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: dtolnay/rust-toolchain@stable
        with:
          components: rustfmt, clippy
      - uses: Swatinem/rust-cache@v2
      - run: cargo fmt --check
        working-directory: backend
      - run: cargo clippy --all-targets -- -D warnings
        working-directory: backend
      - run: cargo test
        working-directory: backend
```

Tushunchalar ierarxiyasi: **workflow** → **job** (alohida mashinada, parallel) → **step** (ketma-ket).

Muhim nuqtalar:

- `on: pull_request` bo'lmasa, tekshiruvlar PR'da ko'rinmaydi va majburiy qilib bo'lmaydi.
- Har bir job **toza mashinada** boshlanadi: bir job'dagi fayl ikkinchisida yo'q. Uzatish kerak bo'lsa `actions/upload-artifact`.
- Action versiyalarini qotirib qo'ying (`@v4`) — `@main` bilan ishlatish build'ni bir kunda tushuntirib bo'lmas holda buzishi mumkin.

Bu repozitoriyda CI workflow'i allaqachon bor: `.github/workflows/` ga qarang.$a$],

[$q$Build'ni tezlashtirish uchun nima qilish kerak?$q$,
$a$Ta'sir kuchi bo'yicha:

1. **Keshlash.** Rust uchun `Swatinem/rust-cache`, Node uchun `actions/setup-node` ning `cache: npm` parametri. Bu ko'pincha vaqtni bir necha baravar qisqartiradi.
2. **Parallel job'lar.** Backend va frontend tekshiruvlari bir-birini kutmasin — alohida job qilib qo'ying.
3. **Erta to'xtash.** Eng tez tekshiruv (formatlash) birinchi bo'lsin — 10 sekundda yiqilib, 10 daqiqalik testni kutmasin.
4. **Keraksiz ishni o'tkazib yuborish:**
   ```yaml
   on:
     pull_request:
       paths: ['backend/**', '.github/workflows/**']
   ```
5. **Eski ishlarni bekor qilish** — yangi push kelganda oldingisini davom ettirish ma'nosiz:
   ```yaml
   concurrency:
     group: ${{ github.workflow }}-${{ github.ref }}
     cancel-in-progress: true
   ```

Keshning o'zi muammo bo'lishi ham mumkin: buzilgan kesh tushunarsiz xatolar beradi. Shubha tug'ilsa, kesh kalitiga qo'lda versiya qo'shib (`v2-`) uni almashtirish — eng tez tekshiruv.

Vaqtni o'lchab boring: har bir qadamning davomiyligi workflow sahifasida ko'rinadi, shuning uchun optimizatsiyani taxmin bilan emas, raqam bilan qilish mumkin.$a$],

[$q$CI'da sirlarni qanday ishlataman?$q$,
$a$Repozitoriya sozlamalarida `Settings → Secrets and variables → Actions` orqali qo'shiladi, keyin:

```yaml
- name: Deploy
  env:
    SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY }}
    DATABASE_URL: ${{ secrets.DATABASE_URL }}
  run: ./scripts/deploy.sh
```

Qoidalar:

1. Sirni **`env:` orqali** uzatish kerak, buyruq qatoriga yozmaslik — buyruq qatori log'da va jarayonlar ro'yxatida ko'rinadi.
2. GitHub log'dagi sir qiymatlarini maskalaydi, lekin **o'zgartirilgan** shaklini (base64, bo'laklangan) maskalay olmaydi. `set -x` bilan ishlaydigan skriptlar sirni ochib qo'yishi mumkin.
3. **`pull_request` trigger'i fork'lardan sirlarni bermaydi** — bu ataylab qilingan himoya. `pull_request_target` esa beradi va shuning uchun xavfli: unda begona kod ishga tushishiga yo'l qo'ymaslik kerak.
4. **Environment secrets** + majburiy tasdiq — ishlab chiqarishga deploy uchun. Shunda deploy odam tasdiqlagandan keyin boshlanadi.
5. Har bir muhit uchun alohida sir, va imkon qadar **qisqa muddatli** hisob ma'lumotlari (OIDC bilan bulut provayderiga uzoq yashovchi kalitsiz ulanish mumkin).

Minimal ruxsat ham muhim:

```yaml
permissions:
  contents: read
```

Standart token ko'pincha keragidan ortiq huquqqa ega bo'ladi.$a$],

[$q$Matrix build nima uchun kerak?$q$,
$a$Bir xil job'ni bir necha konfiguratsiyada ishga tushiradi:

```yaml
strategy:
  fail-fast: false
  matrix:
    node: [20, 22]
    os: [ubuntu-latest, macos-latest]
runs-on: ${{ matrix.os }}
steps:
  - uses: actions/setup-node@v4
    with: { node-version: ${{ matrix.node }} }
```

Bu 4 ta parallel job beradi.

`fail-fast: false` muhim: standart holatda bitta kombinatsiya yiqilsa, qolganlari bekor qilinadi va siz muammo faqat bitta platformada ekanini bilmay qolasiz.

Matrix kutubxona va CLI uchun juda foydali (bir nechta versiya qo'llab-quvvatlanadi). Yagona serverda ishlaydigan ilova uchun esa odatda ortiqcha — bitta aniq muhitda sinash yetarli va tezroq.

Ehtiyot bo'ling: matrix job sonini tez ko'paytiradi (3 versiya × 3 OS = 9), bu esa navbat va xarajat. Kerakli kombinatsiyalarni `include`/`exclude` bilan cheklash mumkin.$a$],

[$q$Deploy'ni CI'dan qanday qilaman?$q$,
$a$Oddiy, bir serverli variant — SSH orqali:

```yaml
deploy:
  needs: check
  if: github.ref == 'refs/heads/main'
  runs-on: ubuntu-latest
  environment: production
  steps:
    - uses: actions/checkout@v4
    - run: |
        install -m 600 /dev/stdin ~/.ssh/key <<< "${{ secrets.DEPLOY_KEY }}"
        ssh -i ~/.ssh/key -o StrictHostKeyChecking=accept-new \
            deploy@${{ secrets.HOST }} 'cd /srv/portal && ./deploy.sh'
```

Muhim jihatlar:

- **`needs: check`** — tekshiruvlar o'tmasa deploy bo'lmasin.
- **`if: github.ref == ...`** — faqat `main` dan. PR'lar ishlab chiqarishga deploy qilmasin.
- **`environment: production`** — tasdiq va alohida sirlar shu orqali keladi.
- Serverdagi `deploy.sh` **idempotent** bo'lishi kerak: tortib olish, build, migratsiya, xizmatni reload, healthcheck. Yarim bajarilgan holatda qolmasligi muhim.
- Oxirida **healthcheck** va muvaffaqiyatsizlikda **avtomatik qaytish** bo'lsa, deploy'dan qo'rqmaslik mumkin bo'ladi.

Bu loyihada deploy qadamlari `docs/DEPLOY.uz.md` da yozilgan — CI skripti shu hujjatdagi ketma-ketlikni avtomatlashtirishi kerak, boshqa narsa o'ylab chiqarmasligi.$a$],

[$q$CI'da yiqilgan build'ni qanday debug qilaman?$q$,
$a$Tartib bilan:

1. **Log'ni oxiridan o'qing** — haqiqiy xato odatda birinchi yiqilgan qadamda, lekin ko'p chiqish orasida ko'rinmay ketadi. `Annotations` bo'limi uni ajratib ko'rsatadi.
2. **Batafsil log yoqing:**
   ```yaml
   env:
     ACTIONS_STEP_DEBUG: true
     RUST_BACKTRACE: 1
   ```
3. **Mahalliyda takrorlang.** Avval `just ci` ni toza holatda ishlating. Farq bo'lsa, sabab odatda muhitda: boshqa versiya, yo'q bo'lgan muhit o'zgaruvchisi, yoki `.gitignore` da qolib ketgan fayl (CI'da u yo'q!).
4. **Holatni chop eting** — tushunarsiz holatda qadam qo'shish eng tez yo'l:
   ```yaml
   - run: |
       pwd && ls -la
       env | grep -v -i secret | sort
       node --version && cargo --version
   ```
5. **Kesh bilan sinab ko'ring.** Kesh kalitini o'zgartirib qayta ishga tushirish buzilgan keshni chetlab o'tadi.
6. **Artefakt yig'ib oling** — yiqilgandan keyin ham:
   ```yaml
   - uses: actions/upload-artifact@v4
     if: failure()
     with: { name: logs, path: '**/*.log' }
   ```

Eng ko'p uchraydigan sabab — **mahalliy muhitga bog'liqlik**: commit qilinmagan fayl, global o'rnatilgan vosita, yoki mahalliy `.env`. CI toza mashinada ishlagani uchun bunday bog'liqliklarni darhol ochib beradi — bu CI'ning kamchiligi emas, asosiy foydasi.$a$]
]);

COMMIT;
