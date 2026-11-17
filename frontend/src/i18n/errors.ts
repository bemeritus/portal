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

  // tool_access.rs, users.rs («Внутренние инструменты»)
  "You do not have access to this tool": {
    ru: "У вас нет доступа к этому инструменту",
    uz: "Bu vositaga ruxsatingiz yo'q",
  },
  "That tool cannot be granted at that level": {
    ru: "Этот инструмент нельзя выдать на таком уровне",
    uz: "Bu vositani bunday darajada berib bo'lmaydi",
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
