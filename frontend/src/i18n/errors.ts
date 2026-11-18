/**
 * Translations for the *server's* error sentences.
 *
 * The API writes its `{"error": "..."}` messages as finished English sentences
 * (see `backend/src/error.rs` and the route handlers). Rather than teach the
 * Rust side to negotiate a language — a change across every error site — the
 * client keeps this dictionary keyed by the exact English string and swaps in a
 * translation at the one place errors are shown (`ErrorFlash`). Anything not
 * listed here (an unforeseen message) falls through unchanged, so a missing
 * entry degrades to English rather than to a blank.
 *
 * Two messages carry a number, so they are matched by pattern, not by equality.
 */

type Lang = string;

/** Exact-match sentences: English source → { ru, uz }. */
export const EXACT: Record<string, { ru: string; uz: string }> = {
  // auth.rs
  "Not signed in": { ru: "Вы не вошли в систему", uz: "Tizimga kirilmagan" },
  "Your session has ended": { ru: "Ваша сессия завершена", uz: "Sessiyangiz tugadi" },
  "Administrators only": { ru: "Только для администраторов", uz: "Faqat administratorlar uchun" },
  "This account is disabled": { ru: "Эта учётная запись отключена", uz: "Bu hisob o'chirilgan" },
  "Invalid username or password": {
    ru: "Неверное имя пользователя или пароль",
    uz: "Foydalanuvchi nomi yoki parol noto'g'ri",
  },
  "No such endpoint": { ru: "Такого эндпоинта нет", uz: "Bunday endpoint yo'q" },
  "Something went wrong. Please try again.": {
    ru: "Что-то пошло не так. Пожалуйста, попробуйте снова.",
    uz: "Nimadir xato ketdi. Iltimos, qayta urinib ko'ring.",
  },

  // categories.rs
  "Category name is required": { ru: "Требуется название категории", uz: "Kategoriya nomi kerak" },
  "A category with that name already exists": {
    ru: "Категория с таким названием уже существует",
    uz: "Bunday nomli kategoriya allaqachon mavjud",
  },
  "That category no longer exists": {
    ru: "Этой категории больше не существует",
    uz: "Bu kategoriya endi mavjud emas",
  },
  "That category no longer exists. Reload the page and pick another.": {
    ru: "Этой категории больше не существует. Обновите страницу и выберите другую.",
    uz: "Bu kategoriya endi mavjud emas. Sahifani yangilab, boshqasini tanlang.",
  },
  "Cannot delete a category that still has documents": {
    ru: "Нельзя удалить категорию, в которой есть документы",
    uz: "Hujjatlari bor kategoriyani o'chirib bo'lmaydi",
  },

  // documents.rs
  "Document not found": { ru: "Документ не найден", uz: "Hujjat topilmadi" },
  "Title is required": { ru: "Требуется название", uz: "Sarlavha kerak" },
  "One of those categories no longer exists. Reload the page and try again.": {
    ru: "Одной из этих категорий больше не существует. Обновите страницу и попробуйте снова.",
    uz: "Bu kategoriyalardan biri endi mavjud emas. Sahifani yangilab, qayta urinib ko'ring.",
  },
  "You cannot move a document into that category": {
    ru: "Вы не можете переместить документ в эту категорию",
    uz: "Hujjatni bu kategoriyaga ko'chira olmaysiz",
  },

  // users.rs
  "Username is required": { ru: "Требуется имя пользователя", uz: "Foydalanuvchi nomi kerak" },
  "That username is already taken": {
    ru: "Это имя пользователя уже занято",
    uz: "Bu foydalanuvchi nomi allaqachon band",
  },
  "That user no longer exists": {
    ru: "Этого пользователя больше не существует",
    uz: "Bu foydalanuvchi endi mavjud emas",
  },
  "You cannot disable your own account": {
    ru: "Нельзя отключить собственную учётную запись",
    uz: "O'z hisobingizni o'chira olmaysiz",
  },

  // auth.rs (routes)
  "Please enter a username and password": {
    ru: "Введите имя пользователя и пароль",
    uz: "Foydalanuvchi nomi va parolni kiriting",
  },

  // documents.rs (history)
  "Revision not found": { ru: "Ревизия не найдена", uz: "Reviziya topilmadi" },
  "The category this version belonged to has been deleted. Edit the document and pick a category instead.":
    {
      ru: "Категория этой версии удалена. Откройте документ на правку и выберите категорию.",
      uz: "Bu versiya tegishli bo'lgan kategoriya o'chirilgan. Hujjatni tahrirlab, kategoriyani tanlang.",
    },

  // tools.rs (port checker)
  "Host is required": { ru: "Укажите хост", uz: "Hostni kiriting" },
  "Enter a hostname or IP address, not a URL": {
    ru: "Введите имя хоста или IP-адрес, а не URL",
    uz: "URL emas, host nomi yoki IP manzilni kiriting",
  },
  "Port must be between 1 and 65535": {
    ru: "Порт должен быть от 1 до 65535",
    uz: "Port 1 dan 65535 gacha bo'lishi kerak",
  },
  "Checking the server's own loopback addresses is not allowed": {
    ru: "Проверять собственные loopback-адреса сервера нельзя",
    uz: "Serverning o'z loopback manzillarini tekshirish mumkin emas",
  },

  // uploads.rs
  "File exceeds the size limit": {
    ru: "Файл превышает допустимый размер",
    uz: "Fayl ruxsat etilgan hajmdan katta",
  },
  "Only PNG, JPEG, GIF or WebP images are allowed": {
    ru: "Разрешены только изображения PNG, JPEG, GIF или WebP",
    uz: "Faqat PNG, JPEG, GIF yoki WebP rasmlarga ruxsat beriladi",
  },
  "No 'file' field in the request": {
    ru: "В запросе нет поля «file»",
    uz: "So'rovda 'file' maydoni yo'q",
  },

  // tool_access.rs, users.rs (internal tools)
  "You do not have access to this tool": {
    ru: "У вас нет доступа к этому инструменту",
    uz: "Bu vositaga ruxsatingiz yo'q",
  },
  "That tool cannot be granted at that level": {
    ru: "Этот инструмент нельзя выдать на таком уровне",
    uz: "Bu vositani bunday darajada berib bo'lmaydi",
  },

  // dc (server room)
  "Those units are already taken on that face": {
    ru: "Эти юниты на этой стороне уже заняты",
    uz: "Bu tomondagi bu yunitlar allaqachon band",
  },
  "The device does not fit in the rack's units": {
    ru: "Устройство не помещается в юниты стойки",
    uz: "Qurilma stoyka yunitlariga sig'maydi",
  },
  "Another object in this room already has that name": {
    ru: "В этой комнате уже есть объект с таким названием",
    uz: "Bu xonada shu nomli obyekt allaqachon bor",
  },
  "Remove the devices and cells from that object first": {
    ru: "Сначала уберите устройства и ячейки этого объекта",
    uz: "Avval bu obyektdagi qurilmalar va kataklarni olib tashlang",
  },
  "No such object in this room": {
    ru: "В этой комнате нет такого объекта",
    uz: "Bu xonada bunday obyekt yo'q",
  },
  "No such device in this room": {
    ru: "В этой комнате нет такого устройства",
    uz: "Bu xonada bunday qurilma yo'q",
  },
  "Devices go in racks": {
    ru: "Устройства ставятся только в стойки",
    uz: "Qurilmalar faqat stoykalarga o'rnatiladi",
  },
  "Shelf cells go on shelves": {
    ru: "Ячейки бывают только у стелажей",
    uz: "Kataklar faqat stellajlarda bo'ladi",
  },
  "No such cell on this shelf": {
    ru: "На этом стелаже нет такой ячейки",
    uz: "Bu stellajda bunday katak yo'q",
  },
  "A device needs a name": {
    ru: "Укажите название устройства",
    uz: "Qurilma nomini kiriting",
  },
  "Units out of range": {
    ru: "Юниты вне допустимого диапазона",
    uz: "Yunitlar ruxsat etilgan oraliqdan tashqarida",
  },
  "Power must not be negative": {
    ru: "Мощность не может быть отрицательной",
    uz: "Quvvat manfiy bo'lishi mumkin emas",
  },
  "A power source needs a power value": {
    ru: "Источник мощности указывается вместе со значением мощности",
    uz: "Quvvat manbai quvvat qiymati bilan birga ko'rsatiladi",
  },
  "Depth must be positive": {
    ru: "Глубина должна быть больше нуля",
    uz: "Chuqurlik noldan katta bo'lishi kerak",
  },
  "A cell needs a name": {
    ru: "Укажите, что стоит в ячейке",
    uz: "Katakda nima turganini kiriting",
  },
  "A note needs text": {
    ru: "Заметка не может быть пустой",
    uz: "Eslatma bo'sh bo'lishi mumkin emas",
  },
  "A view needs a name": {
    ru: "Укажите название вида",
    uz: "Ko'rinish nomini kiriting",
  },
  "Field of view out of range": {
    ru: "Угол обзора вне допустимого диапазона",
    uz: "Ko'rish burchagi ruxsat etilgan oraliqdan tashqarida",
  },
  "An object needs a name": {
    ru: "Укажите название объекта",
    uz: "Obyekt nomini kiriting",
  },
  "Rotation must be 0, 90, 180 or 270": {
    ru: "Поворот может быть только 0, 90, 180 или 270",
    uz: "Burilish faqat 0, 90, 180 yoki 270 bo'lishi mumkin",
  },
  "Mounting height must not be negative": {
    ru: "Высота установки не может быть отрицательной",
    uz: "O'rnatish balandligi manfiy bo'lishi mumkin emas",
  },
  "That catalog item does not exist": {
    ru: "Такой позиции в каталоге нет",
    uz: "Katalogda bunday pozitsiya yo'q",
  },
  "Archived catalog items cannot be placed": {
    ru: "Позиции из архива каталога нельзя размещать",
    uz: "Katalog arxividagi pozitsiyalarni joylashtirib bo'lmaydi",
  },
  "These settings are not valid for this kind of equipment": {
    ru: "Эти параметры не подходят для такого оборудования",
    uz: "Bu parametrlar bunday uskunaga mos emas",
  },
  "A change set needs at least one operation": {
    ru: "Нет изменений для сохранения",
    uz: "Saqlash uchun o'zgarish yo'q",
  },
  "Too many operations in one change set": {
    ru: "Слишком много изменений за один раз",
    uz: "Bir martada juda ko'p o'zgarish",
  },
  "An object's catalog item cannot be changed": {
    ru: "Позицию каталога у объекта менять нельзя",
    uz: "Obyektning katalog pozitsiyasini o'zgartirib bo'lmaydi",
  },
  "That cell is already empty": {
    ru: "Эта ячейка уже пуста",
    uz: "Bu katak allaqachon bo'sh",
  },
  "No such annotation in this room": {
    ru: "В этой комнате нет такой заметки",
    uz: "Bu xonada bunday eslatma yo'q",
  },
  "Room not found": {
    ru: "Комната не найдена",
    uz: "Xona topilmadi",
  },
  "The page is out of date. Reload it and try again.": {
    ru: "Страница устарела. Обновите её и попробуйте снова.",
    uz: "Sahifa eskirgan. Uni yangilab, qayta urinib ko'ring.",
  },
  "Unknown catalog section": {
    ru: "Неизвестный раздел каталога",
    uz: "Noma'lum katalog bo'limi",
  },
  "Height must be between 1 and 60 units": {
    ru: "Высота должна быть от 1 до 60 юнитов",
    uz: "Balandlik 1 dan 60 yunitgacha bo'lishi kerak",
  },
  "Unknown face": {
    ru: "Неизвестная сторона стойки",
    uz: "Stoykaning noma'lum tomoni",
  },
  "The file is not UTF-8 text. Save it as CSV UTF-8.": {
    ru: "Файл не в кодировке UTF-8. Сохраните его как «CSV UTF-8».",
    uz: "Fayl UTF-8 kodlashida emas. Uni «CSV UTF-8» sifatida saqlang.",
  },
  "Check the file first, then import it": {
    ru: "Сначала проверьте файл, затем импортируйте",
    uz: "Avval faylni tekshiring, keyin import qiling",
  },
  "The file changes nothing": {
    ru: "Файл ничего не меняет",
    uz: "Fayl hech narsani o'zgartirmaydi",
  },
  "The room was changed by someone else. Reload to see their changes.": {
    ru: "Комнату изменил кто-то другой. Обновите, чтобы увидеть изменения.",
    uz: "Xonani boshqa kishi o'zgartirdi. O'zgarishlarni ko'rish uchun yangilang.",
  },
  "The file has errors; nothing was imported.": {
    ru: "В файле есть ошибки; ничего не импортировано.",
    uz: "Faylda xatolar bor; hech narsa import qilinmadi.",
  },

  // client.ts (transport failures described on this side)
  "Could not reach the server. Check your connection.": {
    ru: "Не удалось связаться с сервером. Проверьте подключение.",
    uz: "Serverga ulanib bo'lmadi. Ulanishingizni tekshiring.",
  },
};

/**
 * Sentences with a value in them, matched by pattern. Each capture group is
 * substituted into the translation as `$1`, `$2`, ….
 */
export const PATTERNS: { re: RegExp; ru: string; uz: string }[] = [
  {
    re: /^Password must be at least (\d+) characters$/,
    ru: "Пароль должен содержать не менее $1 символов",
    uz: "Parol kamida $1 ta belgidan iborat bo'lishi kerak",
  },
  {
    re: /^Request failed \((\d+)\)$/,
    ru: "Запрос не выполнен ($1)",
    uz: "So'rov bajarilmadi ($1)",
  },
  {
    re: /^'(.+)' did not resolve — check the spelling$/,
    ru: "«$1» не разрешается — проверьте написание",
    uz: "'$1' manzilga aylanmadi — yozilishini tekshiring",
  },
  {
    re: /^Resolving '(.+)' timed out$/,
    ru: "Разрешение «$1» превысило время ожидания",
    uz: "'$1' ni aniqlash vaqti tugadi",
  },
  {
    re: /^'(.+)' did not resolve to any address$/,
    ru: "«$1» не разрешается ни в один адрес",
    uz: "'$1' hech qanday manzilga aylanmadi",
  },
  {
    re: /^Cell (\d+) is under a cooling unit and cannot be used$/,
    ru: "Ячейка $1 находится под кондиционером, её нельзя занять",
    uz: "$1-katak konditsioner ostida, uni band qilib bo'lmaydi",
  },
  {
    re: /^'(.+)' has devices but its contents are marked as not recorded$/,
    ru: "В «$1» есть устройства, но её содержимое отмечено как не записанное",
    uz: "«$1» ichida qurilmalar bor, lekin uning tarkibi yozilmagan deb belgilangan",
  },
  {
    re: /^'(.+)' does not fit inside the room$/,
    ru: "«$1» не помещается в комнату",
    uz: "«$1» xonaga sig'maydi",
  },
  {
    re: /^'(.+)' is higher than the room$/,
    ru: "«$1» выше потолка комнаты",
    uz: "«$1» xona shiftidan baland",
  },
  {
    re: /^'(.+)' overlaps '(.+)'$/,
    ru: "«$1» пересекается с «$2»",
    uz: "«$1» «$2» bilan kesishadi",
  },
  {
    re: /^'(.+)' is in the way of '(.+)'$/,
    ru: "«$1» мешает открыванию: «$2»",
    uz: "«$1» «$2» ochilishiga xalaqit beradi",
  },
];

/**
 * Translate a server error sentence into `lang`, or return it unchanged when
 * the language is English or the sentence is not one we know.
 */
export function translateApiError(message: string, lang: Lang): string {
  const code = lang.split("-")[0];
  if (code === "en") return message;

  const exact = EXACT[message];
  if (exact && (code === "ru" || code === "uz")) return exact[code];

  if (code === "ru" || code === "uz") {
    for (const p of PATTERNS) {
      const m = p.re.exec(message);
      if (m) return p[code].replace(/\$(\d)/g, (_, i: string) => m[Number(i)] ?? "");
    }
  }

  return message;
}
