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
const EXACT: Record<string, { ru: string; uz: string }> = {
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

  // client.ts (transport failures described on this side)
  "Could not reach the server. Check your connection.": {
    ru: "Не удалось связаться с сервером. Проверьте подключение.",
    uz: "Serverga ulanib bo'lmadi. Ulanishingizni tekshiring.",
  },
};

/** Sentences with a number in them, matched by pattern. */
const PASSWORD_RE = /^Password must be at least (\d+) characters$/;
const REQUEST_FAILED_RE = /^Request failed \((\d+)\)$/;

/**
 * Translate a server error sentence into `lang`, or return it unchanged when
 * the language is English or the sentence is not one we know.
 */
export function translateApiError(message: string, lang: Lang): string {
  const code = lang.split("-")[0];
  if (code === "en") return message;

  const exact = EXACT[message];
  if (exact && (code === "ru" || code === "uz")) return exact[code];

  const pw = PASSWORD_RE.exec(message);
  if (pw) {
    const n = pw[1];
    if (code === "ru") return `Пароль должен содержать не менее ${n} символов`;
    if (code === "uz") return `Parol kamida ${n} ta belgidan iborat bo'lishi kerak`;
  }

  const rf = REQUEST_FAILED_RE.exec(message);
  if (rf) {
    const n = rf[1];
    if (code === "ru") return `Запрос не выполнен (${n})`;
    if (code === "uz") return `So'rov bajarilmadi (${n})`;
  }

  return message;
}
