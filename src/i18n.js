/**
 * Переклади бота: українська (основна), русский, English.
 *
 * Тексти в коді лишаються українськими, а перед відправкою L(lang, text) підставляє переклад.
 * Рядок шукається цілком, потім по рядках (для повідомлень із кількох рядків).
 * {0}, {1}… у шаблоні — змінні частини; вони теж перекладаються, якщо є в словнику
 * (наприклад, «Стать: Чоловік» → «Gender: Male»).
 * Збережені в базі значення (стать, ціль) завжди українські — на них спирається пошук.
 */

export const LANGS = ["uk", "ru", "en"];
export const LANG_NAMES = { uk: "🇺🇦 Українська", ru: "🇷🇺 Русский", en: "🇬🇧 English" };

// Мова за налаштуваннями Telegram, поки людина не обрала сама.
export function guessLang(code) {
  const c = String(code || "").toLowerCase();
  if (c.startsWith("uk")) return "uk";
  if (["ru", "be", "kk", "ky", "uz", "tg", "hy", "az"].some((x) => c.startsWith(x))) return "ru";
  if (!c) return "uk";
  return "en";
}

// [українська, русский, English]
const ENTRIES = [
  // ---------- мова ----------
  ["🌐 Мова", "🌐 Язык", "🌐 Language"],
  ["Обери мову / Выбери язык / Choose language", "Обери мову / Выбери язык / Choose language", "Обери мову / Выбери язык / Choose language"],
  ["Мову змінено: українська.", "Язык изменён: русский.", "Language set: English."],

  // ---------- кнопки меню ----------
  ["🍾 Гра в бутилочку", "🍾 Игра в бутылочку", "🍾 Spin the Bottle"],
  ["🔍 Знайти співрозмовника", "🔍 Найти собеседника", "🔍 Find a chat partner"],
  ["⏭ Наступний", "⏭ Следующий", "⏭ Next"],
  ["⛔ Завершити діалог", "⛔ Завершить диалог", "⛔ End chat"],
  ["👤 Мій профіль", "👤 Мой профиль", "👤 My profile"],
  ["📝 Заповнити анкету", "📝 Заполнить анкету", "📝 Fill in profile"],
  ["📷 Завантажити фото", "📷 Загрузить фото", "📷 Upload photo"],
  ["🎁 Запросити друзів", "🎁 Пригласить друзей", "🎁 Invite friends"],
  ["⚠️ Поскаржитись", "⚠️ Пожаловаться", "⚠️ Report"],
  ["📜 Правила", "📜 Правила", "📜 Rules"],
  ["❓ Допомога", "❓ Помощь", "❓ Help"],
  ["Моє місцезнаходження", "Моё местоположение", "My location"],
  ["Мені є 18", "Мне есть 18", "I'm 18+"],
  ["Мені немає 18", "Мне нет 18", "I'm under 18"],

  // ---------- значення з анкети ----------
  ["Чоловік", "Мужчина", "Male"],
  ["Жінка", "Женщина", "Female"],
  ["Інше", "Другое", "Other"],
  ["Чоловіка", "Мужчину", "A man"],
  ["Жінку", "Женщину", "A woman"],
  ["Будь-кого", "Кого угодно", "Anyone"],
  ["Спілкування", "Общение", "Chatting"],
  ["Дружба", "Дружба", "Friendship"],
  ["Стосунки", "Отношения", "Relationship"],
  ["Флірт", "Флирт", "Flirting"],
  ["Без фото", "Без фото", "No photo"],
  ["не вказано", "не указано", "not set"],
  ["є, бачать лише з Premium", "есть, видят только с Premium", "yes, visible with Premium only"],
  ["немає", "нет", "none"],
  ["активний", "активен", "active"],
  ["не активний", "не активен", "inactive"],
  ["активний до {0}", "активен до {0}", "active until {0}"],
  ["анкета", "анкета", "profile"],
  ["Анкета без імені", "Анкета без имени", "Profile without a name"],

  // ---------- вітання і лобі ----------
  ["Невідомий — анонімний чат.", "Невідомий — анонимный чат.", "Nevidomyi — anonymous chat."],
  ["Співрозмовник не бачить твоє ім’я, юзернейм і номер. Не надсилай контакти, адресу чи фото документів.", "Собеседник не видит твоё имя, юзернейм и номер. Не отправляй контакты, адрес или фото документов.", "Your chat partner can't see your name, username or phone number. Don't send contacts, your address or photos of documents."],
  ["Бот лише для людей від 18 років. Підтверди вік.", "Бот только для людей от 18 лет. Подтверди возраст.", "This bot is for adults (18+) only. Please confirm your age."],
  ["Ти в лобі.", "Ты в лобби.", "You're in the lobby."],
  ["Доступ до бота обмежено.", "Доступ к боту ограничен.", "Your access to the bot is restricted."],
  ["Спочатку заверши поточний діалог.", "Сначала заверши текущий диалог.", "Finish your current chat first."],
  ["Не так швидко, зачекай кілька секунд.", "Не так быстро, подожди несколько секунд.", "Not so fast, wait a few seconds."],
  ["Напиши мені в особисті — так чат лишається анонімним.", "Напиши мне в личку — так чат остаётся анонимным.", "Message me privately — that keeps the chat anonymous."],
  ["Фото, голос і стікери можна надсилати лише в діалозі.", "Фото, голос и стикеры можно отправлять только в диалоге.", "Photos, voice messages and stickers can only be sent during a chat."],
  ["Бот лише для повнолітніх", "Бот только для совершеннолетних", "Adults only"],
  ["Тоді цей бот не для тебе. Повертайся, коли виповниться 18.", "Тогда этот бот не для тебя. Возвращайся, когда исполнится 18.", "Then this bot isn't for you. Come back when you're 18."],
  ["Вік підтверджено", "Возраст подтверждён", "Age confirmed"],
  ["Вік підтверджено.", "Возраст подтверждён.", "Age confirmed."],
  ["Збережено", "Сохранено", "Saved"],

  // ---------- пошук і діалог ----------
  ["Обери.", "Выбери.", "Choose."],
  ["Випадково", "Случайно", "Random"],
  ["За анкетою", "По анкете", "By profile"],
  ["Пошук за віком, статтю і містом лише з Premium. Випадковий — безкоштовний.", "Поиск по возрасту, полу и городу только с Premium. Случайный — бесплатный.", "Search by age, gender and city is Premium only. Random search is free."],
  ["Знайомство за анкетою. Ім’я, юзернейм і номер не передаю.", "Знакомство по анкете. Имя, юзернейм и номер не передаю.", "Profile match. I don't share names, usernames or phone numbers."],
  ["Стать: {0}", "Пол: {0}", "Gender: {0}"],
  ["Вік: {0}", "Возраст: {0}", "Age: {0}"],
  ["Місто: {0}", "Город: {0}", "City: {0}"],
  ["Ціль: {0}", "Цель: {0}", "Goal: {0}"],
  ["Фото є. Його видно лише з Premium.", "Фото есть. Его видно только с Premium.", "There's a photo. It's visible with Premium only."],
  ["Пиши. «Наступний» шукає іншу анкету.", "Пиши. «Следующий» ищет другую анкету.", "Say hi. “Next” finds another profile."],
  ["Співрозмовника знайдено. Пиши — я передам повідомлення без твого імені.", "Собеседник найден. Пиши — я передам сообщение без твоего имени.", "Partner found. Type away — I'll pass your messages on without your name."],
  ["«Наступний» шукає когось іншого. «Завершити діалог» зупиняє розмову.", "«Следующий» ищет кого-то другого. «Завершить диалог» останавливает разговор.", "“Next” finds someone else. “End chat” stops the conversation."],
  ["Шукаю анкету за віком, статтю і містом. Якщо зараз нікого немає — зачекай.", "Ищу анкету по возрасту, полу и городу. Если сейчас никого нет — подожди.", "Looking for a profile by age, gender and city. If nobody's around right now, please wait."],
  ["Шукаю випадкову людину. Це безкоштовно. Якщо черга порожня — зачекай.", "Ищу случайного человека. Это бесплатно. Если очередь пуста — подожди.", "Looking for a random person. It's free. If the queue is empty, please wait."],
  ["Пошук скасовано.", "Поиск отменён.", "Search cancelled."],
  ["Співрозмовник недоступний.", "Собеседник недоступен.", "Your partner is unavailable."],
  ["Співрозмовник пішов шукати когось іншого.", "Собеседник ушёл искать кого-то другого.", "Your partner went to find someone else."],
  ["Діалог завершено.", "Диалог завершён.", "Chat ended."],
  ["Співрозмовник завершив діалог.", "Собеседник завершил диалог.", "Your partner ended the chat."],
  ["Ти і так у лобі.", "Ты и так в лобби.", "You're already in the lobby."],
  ["Зараз ти не в діалозі. Натисни «Знайти співрозмовника».", "Сейчас ты не в диалоге. Нажми «Найти собеседника».", "You're not in a chat right now. Tap “Find a chat partner”."],
  ["Не вдалося передати це повідомлення.", "Не удалось передать это сообщение.", "Couldn't deliver this message."],
  ["Ти зараз у діалозі. «Завершити діалог» або /stop зупиняє його.", "Ты сейчас в диалоге. «Завершить диалог» или /stop останавливает его.", "You're in a chat now. “End chat” or /stop ends it."],
  ["Пошук ще триває.", "Поиск ещё идёт.", "Search is still running."],
  ["Пошук ще триває. «Завершити діалог» скасовує його.", "Поиск ещё идёт. «Завершить диалог» отменяет его.", "Search is still running. “End chat” cancels it."],
  ["Скаржитись можна лише під час діалогу.", "Жаловаться можно только во время диалога.", "You can report only during a chat."],
  ["Скаргу збережено. Діалог завершено.", "Жалоба сохранена. Диалог завершён.", "Report saved. Chat ended."],

  // ---------- профіль ----------
  ["Профіль", "Профиль", "Profile"],
  ["Ім’я: {0}", "Имя: {0}", "Name: {0}"],
  ["Звідки: {0}", "Откуда: {0}", "From: {0}"],
  ["Про себе: {0}", "О себе: {0}", "About: {0}"],
  ["Фото: {0}", "Фото: {0}", "Photo: {0}"],
  ["Premium: {0}", "Premium: {0}", "Premium: {0}"],
  ["Пошуків за анкетою: {0}", "Поисков по анкете: {0}", "Profile searches: {0}"],
  ["Запросив друзів: {0}", "Пригласил друзей: {0}", "Friends invited: {0}"],

  // ---------- Premium ----------
  ["Статус: {0}", "Статус: {0}", "Status: {0}"],
  ["Випадковий пошук безкоштовний.", "Случайный поиск бесплатный.", "Random search is free."],
  ["Чат знайомств — за підпискою або разово:", "Чат знакомств — по подписке или разово:", "Dating chat — by subscription or one-off:"],
  ["Підписка — 1000⭐ кожні 30 днів", "Подписка — 1000⭐ каждые 30 дней", "Subscription — 1000⭐ every 30 days"],
  ["1 пошук — 1⭐", "1 поиск — 1⭐", "1 search — 1⭐"],
  ["1 день — 20⭐", "1 день — 20⭐", "1 day — 20⭐"],
  ["1 тиждень — 100⭐", "1 неделя — 100⭐", "1 week — 100⭐"],
  ["1 місяць — 1000⭐", "1 месяц — 1000⭐", "1 month — 1000⭐"],
  ["Підписку Telegram продовжує сам, поки не скасуєш у налаштуваннях.", "Подписку Telegram продлевает сам, пока не отменишь в настройках.", "Telegram renews the subscription automatically until you cancel it in settings."],
  ["За друга за посиланням — 3 години Premium.", "За друга по ссылке — 3 часа Premium.", "Each friend who joins via your link gives you 3 hours of Premium."],
  ["Підписка на знайомства · 1000⭐", "Подписка на знакомства · 1000⭐", "Dating subscription · 1000⭐"],
  ["1 пошук · 1⭐", "1 поиск · 1⭐", "1 search · 1⭐"],
  ["1 день · 20⭐", "1 день · 20⭐", "1 day · 20⭐"],
  ["1 тиждень · 100⭐", "1 неделя · 100⭐", "1 week · 100⭐"],
  ["1 місяць · 1000⭐", "1 месяц · 1000⭐", "1 month · 1000⭐"],
  ["Пошук за анкетою", "Поиск по анкете", "Profile search"],
  ["Premium на 1 день", "Premium на 1 день", "Premium for 1 day"],
  ["Premium на 1 тиждень", "Premium на 1 неделю", "Premium for 1 week"],
  ["Premium на 1 місяць", "Premium на 1 месяц", "Premium for 1 month"],
  ["Підписка на чат знайомств", "Подписка на чат знакомств", "Dating chat subscription"],
  ["1 пошук за анкетою", "1 поиск по анкете", "1 profile search"],
  ["1 день", "1 день", "1 day"],
  ["1 тиждень", "1 неделя", "1 week"],
  ["1 місяць", "1 месяц", "1 month"],
  ["30 днів", "30 дней", "30 days"],
  ["Чат знайомств на 30 днів. Далі Telegram спише 1000⭐ знову, поки не скасуєш підписку.", "Чат знакомств на 30 дней. Дальше Telegram спишет 1000⭐ снова, пока не отменишь подписку.", "Dating chat for 30 days. Telegram will then charge 1000⭐ again until you cancel."],
  ["{0} за {1}⭐. Оплата зірками Telegram.", "{0} за {1}⭐. Оплата звёздами Telegram.", "{0} for {1}⭐. Paid with Telegram Stars."],
  ["Тариф змінився. Відкрий Premium ще раз.", "Тариф изменился. Открой Premium ещё раз.", "The plan has changed. Open Premium again."],
  ["Оплату отримано, але тариф не збігся. Напиши в Premium ще раз.", "Оплата получена, но тариф не совпал. Открой Premium ещё раз.", "Payment received, but the plan didn't match. Please open Premium again."],
  ["⭐ Оплачено. +1 пошук. Натисни «Знайти співрозмовника».", "⭐ Оплачено. +1 поиск. Нажми «Найти собеседника».", "⭐ Paid. +1 search. Tap “Find a chat partner”."],
  ["Підписку на чат знайомств продовжено до {0}.", "Подписка на чат знакомств продлена до {0}.", "Dating chat subscription renewed until {0}."],
  ["Підписку оформлено до {0}. Далі Telegram продовжить її сам. Скасувати можна в налаштуваннях Telegram.", "Подписка оформлена до {0}. Дальше Telegram продлит её сам. Отменить можно в настройках Telegram.", "Subscribed until {0}. Telegram will renew it automatically. You can cancel in Telegram settings."],
  ["Оплачено. Пошук за анкетою відкрито: {0}.", "Оплачено. Поиск по анкете открыт: {0}.", "Paid. Profile search unlocked: {0}."],

  // ---------- запрошення друзів ----------
  ["Надішли другу це посилання:", "Отправь другу эту ссылку:", "Send this link to a friend:"],
  ["Уже запросили: {0}", "Уже пригласили: {0}", "Invited so far: {0}"],
  ["За кожного друга — 3 години Premium.", "За каждого друга — 3 часа Premium.", "Each friend gives you 3 hours of Premium."],
  ["🎁 Друг зайшов за твоїм посиланням. Тобі 3 години Premium.", "🎁 Друг зашёл по твоей ссылке. Тебе 3 часа Premium.", "🎁 A friend joined via your link. You get 3 hours of Premium."],
  ["📨 Поділитися посиланням", "📨 Поделиться ссылкой", "📨 Share link"],
  ["Анонімний чат і гра в бутилочку з подарунками. Заходь 👉", "Анонимный чат и игра в бутылочку с подарками. Заходи 👉", "Anonymous chat and Spin the Bottle with gifts. Join 👉"],

  // ---------- правила і допомога ----------
  ["• Лише 18+.", "• Только 18+.", "• 18+ only."],
  ["• Не надсилай контакти, адресу, документи і посилання на свої профілі.", "• Не отправляй контакты, адрес, документы и ссылки на свои профили.", "• Don't share contacts, your address, documents or links to your profiles."],
  ["• Не ображай співрозмовника.", "• Не оскорбляй собеседника.", "• Don't insult your chat partner."],
  ["• «Завершити діалог» або /stop зупиняє розмову.", "• «Завершить диалог» или /stop останавливает разговор.", "• “End chat” or /stop ends the conversation."],
  ["• «Наступний» шукає іншу людину.", "• «Следующий» ищет другого человека.", "• “Next” finds another person."],
  ["• Скарга — кнопка під час діалогу.", "• Жалоба — кнопка во время диалога.", "• Use the Report button during a chat."],
  ["🍾 Гра в бутилочку — гра за столом із подарунками", "🍾 Игра в бутылочку — игра за столом с подарками", "🍾 Spin the Bottle — table game with gifts"],
  ["🔍 Знайти — випадково безкоштовно або за анкетою з Premium", "🔍 Найти — случайно бесплатно или по анкете с Premium", "🔍 Find — random for free, or by profile with Premium"],
  ["⏭ Наступний — інша людина", "⏭ Следующий — другой человек", "⏭ Next — another person"],
  ["⛔ Завершити діалог — вийти", "⛔ Завершить диалог — выйти", "⛔ End chat — leave"],
  ["📝 Заповнити анкету — ім’я, стать, вік, місто, ціль", "📝 Заполнить анкету — имя, пол, возраст, город, цель", "📝 Fill in profile — name, gender, age, city, goal"],
  ["📷 Завантажити фото — скріпка, видно лише з Premium", "📷 Загрузить фото — скрепка, видно только с Premium", "📷 Upload photo — paperclip, visible with Premium only"],
  ["👤 Мій профіль — що вже збережено", "👤 Мой профиль — что уже сохранено", "👤 My profile — what's saved"],
  ["💎 Premium — зірки за пошук за анкетою", "💎 Premium — звёзды за поиск по анкете", "💎 Premium — Stars for profile search"],
  ["🎁 Запросити друзів — 3 години Premium", "🎁 Пригласить друзей — 3 часа Premium", "🎁 Invite friends — 3 hours of Premium"],
  ["⚠️ Поскаржитись — лише в діалозі", "⚠️ Пожаловаться — только в диалоге", "⚠️ Report — only during a chat"],
  ["🌐 Мова — українська, русский, English", "🌐 Язык — українська, русский, English", "🌐 Language — українська, русский, English"],
  ["/myid — твій Telegram ID", "/myid — твой Telegram ID", "/myid — your Telegram ID"],
  ["/stopnews — без новин", "/stopnews — без новостей", "/stopnews — no news"],
  ["/startnews — знову новини", "/startnews — снова новости", "/startnews — news again"],

  // ---------- анкета ----------
  ["Анкета. Як тебе звати?", "Анкета. Как тебя зовут?", "Profile. What's your name?"],
  ["Твоя стать?", "Твой пол?", "Your gender?"],
  ["Скільки тобі років? Напиши число від 18 до 99.", "Сколько тебе лет? Напиши число от 18 до 99.", "How old are you? Send a number from 18 to 99."],
  ["Звідки ти? Напиши місто або натисни «Моє місцезнаходження».", "Откуда ты? Напиши город или нажми «Моё местоположение».", "Where are you from? Type your city or tap “My location”."],
  ["Яка ціль знайомства?", "Какая цель знакомства?", "What are you looking for?"],
  ["Коротко про себе. До 300 символів.", "Коротко о себе. До 300 символов.", "A few words about yourself. Up to 300 characters."],
  ["Натисни скріпку біля поля і надішли фото. Його побачать лише люди з Premium. Або натисни «Без фото».", "Нажми скрепку возле поля и отправь фото. Его увидят только люди с Premium. Или нажми «Без фото».", "Tap the paperclip next to the input field and send a photo. Only Premium users will see it. Or tap “No photo”."],
  ["Для знайомств обери свою стать. Її бачить лише людина, яку підбере анкета.", "Для знакомств выбери свой пол. Его видит только человек, которого подберёт анкета.", "For dating, choose your gender. Only the person matched by your profile will see it."],
  ["Обери стать. У випадковому чаті її не показую.", "Выбери пол. В случайном чате его не показываю.", "Choose your gender. I don't show it in random chats."],
  ["Напиши свій вік числом, від 18 до 99. Він буде в анкеті.", "Напиши свой возраст числом, от 18 до 99. Он будет в анкете.", "Send your age as a number, 18 to 99. It will be in your profile."],
  ["Напиши свій вік числом, від 18 до 99.", "Напиши свой возраст числом, от 18 до 99.", "Send your age as a number, 18 to 99."],
  ["Надішли місто або натисни «Моє місцезнаходження».", "Отправь город или нажми «Моё местоположение».", "Send your city or tap “My location”."],
  ["Кого шукати?", "Кого искать?", "Who are you looking for?"],
  ["Який вік шукати?", "Какой возраст искать?", "What age range?"],
  ["Надішли місто, де шукати, або натисни «Моє місцезнаходження».", "Отправь город, где искать, или нажми «Моё местоположение».", "Send the city to search in, or tap “My location”."],
  ["Стать збережено: {0}.", "Пол сохранён: {0}.", "Gender saved: {0}."],
  ["Напиши ім’я, хоча б два символи.", "Напиши имя, хотя бы два символа.", "Type a name, at least two characters."],
  ["Потрібне ціле число від 18 до 99.", "Нужно целое число от 18 до 99.", "Please send a whole number from 18 to 99."],
  ["Напиши назву міста.", "Напиши название города.", "Type the city name."],
  ["Напиши хоча б кілька слів.", "Напиши хотя бы несколько слов.", "Write at least a few words."],
  ["Вік збережено: {0}.", "Возраст сохранён: {0}.", "Age saved: {0}."],
  ["Спочатку напиши своє місто.", "Сначала напиши свой город.", "Type your own city first."],
  ["Місто збережено.", "Город сохранён.", "City saved."],
  ["Інтереси збережено.", "Интересы сохранены.", "Interests saved."],
  ["Зараз місто не потрібне.", "Сейчас город не нужен.", "No city needed right now."],
  ["Не бачу місто за цією точкою. Напиши його словами.", "Не вижу город по этой точке. Напиши его словами.", "I can't find a city at this location. Please type it."],
  ["Це фото завелике. Надішли інше.", "Это фото слишком большое. Отправь другое.", "This photo is too large. Send another one."],
  ["Не вдалося зберегти фото. Надішли ще раз або натисни «Без фото».", "Не удалось сохранить фото. Отправь ещё раз или нажми «Без фото».", "Couldn't save the photo. Send it again or tap “No photo”."],

  // ---------- запит написати ----------
  ["Цієї анкети вже немає.", "Этой анкеты уже нет.", "This profile no longer exists."],
  ["Це твоя анкета. Написати собі не вийде.", "Это твоя анкета. Написать себе не получится.", "This is your own profile. You can't message yourself."],
  ["Запит пішов: {0}. Якщо людина прийме, відкриється діалог.", "Запрос отправлен: {0}. Если человек примет, откроется диалог.", "Request sent: {0}. If they accept, a chat will open."],
  ["Хочуть написати.", "Хотят написать.", "Someone wants to chat."],
  ["Прийняти", "Принять", "Accept"],
  ["Ні", "Нет", "No"],
  ["Запит уже не діє.", "Запрос уже недействителен.", "This request has expired."],
  ["Запит відхилено.", "Запрос отклонён.", "Request declined."],
  ["Людина не прийняла запит.", "Человек не принял запрос.", "They declined your request."],
  ["Зараз не вийшло: хтось уже в діалозі.", "Сейчас не получилось: кто-то уже в диалоге.", "Not possible right now: someone is already in a chat."],
  ["Зараз не вийшло відкрити діалог. Спробуй ще раз.", "Сейчас не получилось открыть диалог. Попробуй ещё раз.", "Couldn't open the chat right now. Try again."],
  ["Людина прийняла запит. Пиши. «Завершити діалог» зупиняє розмову.", "Человек принял запрос. Пиши. «Завершить диалог» останавливает разговор.", "They accepted your request. Say hi. “End chat” stops the conversation."],
  ["Діалог відкрито. Пиши. «Завершити діалог» зупиняє розмову.", "Диалог открыт. Пиши. «Завершить диалог» останавливает разговор.", "Chat opened. Say hi. “End chat” stops the conversation."],

  // ---------- команди і новини ----------
  ["🍾 Запустити спільну гру:", "🍾 Запустить общую игру:", "🍾 Start the group game:"],
  ["ВІДКРИТИ ГРУ", "ОТКРЫТЬ ИГРУ", "OPEN GAME"],
  ["Твій ID: {0}", "Твой ID: {0}", "Your ID: {0}"],
  ["✅ Ти відписався від новин бота.", "✅ Ты отписался от новостей бота.", "✅ You've unsubscribed from bot news."],
  ["✅ Ти знову підписаний на новини бота.", "✅ Ты снова подписан на новости бота.", "✅ You're subscribed to bot news again."],
  ["Щоб відписатись від новин: /stopnews", "Чтобы отписаться от новостей: /stopnews", "To unsubscribe from news: /stopnews"],

  // ---------- подарунки ----------
  ["Троянда", "Роза", "Rose"],
  ["Шоколадка", "Шоколадка", "Chocolate"],
  ["Ведмедик", "Мишка", "Teddy bear"],
  ["Каблучка", "Кольцо", "Ring"],
  ["Діамант", "Бриллиант", "Diamond"],
  ["Подарунок: {0}", "Подарок: {0}", "Gift: {0}"],
  ["Подарунок гравцю. Оплата зірками Telegram.", "Подарок игроку. Оплата звёздами Telegram.", "A gift for a player. Paid with Telegram Stars."],
  ["Подарунки в діалозі можна дарувати лише під час розмови. Натисни «Знайти співрозмовника». А за столом у грі можна дарувати гравцям, відкрий «🍾 Гра в бутилочку».", "Подарки в диалоге можно дарить только во время разговора. Нажми «Найти собеседника». А за столом в игре можно дарить игрокам, открой «🍾 Игра в бутылочку».", "Gifts in a chat can only be sent during a conversation. Tap “Find a chat partner”. At the game table you can gift players — open “🍾 Spin the Bottle”."],
  ["🎁 Обери подарунок для співрозмовника. Він отримає його анонімно.", "🎁 Выбери подарок для собеседника. Он получит его анонимно.", "🎁 Pick a gift for your chat partner. They'll receive it anonymously."],
  ["Діалог уже завершено, подарунок надіслати нікому.", "Диалог уже завершён, подарок отправить некому.", "The chat has ended, there's no one to send the gift to."],
  ["Ціна змінилась. Відкрий подарунки ще раз.", "Цена изменилась. Открой подарки ещё раз.", "The price has changed. Open gifts again."],
  ["Гравець уже вийшов зі столу. Подарунок не надіслано.", "Игрок уже вышел из-за стола. Подарок не отправлен.", "The player has left the table. The gift wasn't sent."],
  ["Оплату отримано, але подарунок не збігся. Зірки повернено.", "Оплата получена, но подарок не совпал. Звёзды возвращены.", "Payment received, but the gift didn't match. Your Stars were refunded."],
  ["Діалог уже завершено, тому подарунок не надіслано. Зірки повернено.", "Диалог уже завершён, поэтому подарок не отправлен. Звёзды возвращены.", "The chat has ended, so the gift wasn't sent. Your Stars were refunded."],
  ["Не вдалося доставити подарунок. Зірки повернено.", "Не удалось доставить подарок. Звёзды возвращены.", "Couldn't deliver the gift. Your Stars were refunded."],
  ["🎁 {0} подарував(ла) тобі: {1}!", "🎁 {0} подарил(а) тебе: {1}!", "🎁 {0} sent you a gift: {1}!"],
  ["🎁 Співрозмовник подарував тобі: {0}!", "🎁 Собеседник подарил тебе: {0}!", "🎁 Your chat partner sent you a gift: {0}!"],
  ["🎁 Подарунок «{0}» надіслано. Дякую!", "🎁 Подарок «{0}» отправлен. Спасибо!", "🎁 Gift “{0}” sent. Thank you!"],

  // ---------- гра: повідомлення сервера ----------
  ["Відкрий гру через Telegram.", "Открой игру через Telegram.", "Open the game from Telegram."],
  ["Некоректний initData", "Некорректный initData", "Invalid initData"],
  ["Сесія застаріла. Перезапусти гру.", "Сессия устарела. Перезапусти игру.", "Session expired. Restart the game."],
  ["Некоректний підпис", "Некорректная подпись", "Invalid signature"],
  ["Підпис Telegram не пройшов перевірку", "Подпись Telegram не прошла проверку", "Telegram signature check failed"],
  ["Не вдалося авторизувати Telegram.", "Не удалось авторизовать Telegram.", "Couldn't authorize with Telegram."],
  ["Спершу відкрий бота, натисни /start і підтверди вік.", "Сначала открой бота, нажми /start и подтверди возраст.", "Open the bot first, tap /start and confirm your age."],
  ["Анонім {0}", "Аноним {0}", "Anonymous {0}"],
  ["Гравець вийшов зі столу. Раунд скасовано.", "Игрок вышел из-за стола. Раунд отменён.", "A player left the table. Round cancelled."],
  ["🔒 Ви обрали побути наодинці. Пиши: я передам повідомлення без твого імені. «Завершити діалог» зупиняє розмову.", "🔒 Вы выбрали побыть наедине. Пиши: я передам сообщение без твоего имени. «Завершить диалог» останавливает разговор.", "🔒 You both chose to be alone. Type away: I'll pass your messages on without your name. “End chat” stops the conversation."],
  ["🔒 Подарунок спрацював: ви наодинці. Пиши: я передам повідомлення без твого імені. «Завершити діалог» зупиняє розмову.", "🔒 Подарок сработал: вы наедине. Пиши: я передам сообщение без твоего имени. «Завершить диалог» останавливает разговор.", "🔒 The gift worked: you're alone together. Type away: I'll pass your messages on without your name. “End chat” stops the conversation."],
  ["Запрошення вже неактуальне.", "Приглашение уже неактуально.", "The invitation has expired."],
  ["{0} дякує за подарунок, але поки лишається за столом.", "{0} благодарит за подарок, но пока остаётся за столом.", "{0} thanks you for the gift but is staying at the table for now."],
  ["Не вийшло: хтось із вас уже в іншому діалозі.", "Не получилось: кто-то из вас уже в другом диалоге.", "Didn't work: one of you is already in another chat."],
  ["Обери іншого гравця за столом.", "Выбери другого игрока за столом.", "Pick another player at the table."],
  ["Не вдалося створити рахунок. Спробуй ще раз.", "Не удалось создать счёт. Попробуй ещё раз.", "Couldn't create the invoice. Try again."],

  // ---------- гра: завдання ({name} — хто крутив) ----------
  ["Яке твоє найсмішніше побачення?", "Какое твоё самое смешное свидание?", "What was your funniest date?"],
  ["Коли ти востаннє закохувався(лась)?", "Когда ты в последний раз влюблялся(лась)?", "When did you last fall in love?"],
  ["Що тебе першим приваблює в людині?", "Что тебя первым привлекает в человеке?", "What's the first thing that attracts you to someone?"],
  ["Який твій найбільш незручний момент на побаченні?", "Какой твой самый неловкий момент на свидании?", "What's your most awkward moment on a date?"],
  ["Яка твоя найдивніша звичка?", "Какая твоя самая странная привычка?", "What's your weirdest habit?"],
  ["Що ти ніколи не пробачиш партнеру?", "Что ты никогда не простишь партнёру?", "What would you never forgive a partner for?"],
  ["Який комплімент ти пам'ятаєш досі?", "Какой комплимент ты помнишь до сих пор?", "Which compliment do you still remember?"],
  ["Ти більше романтик чи реаліст? Чому?", "Ты больше романтик или реалист? Почему?", "Are you more of a romantic or a realist? Why?"],
  ["Що для тебе ідеальний вечір удвох?", "Что для тебя идеальный вечер вдвоём?", "What's your idea of a perfect evening for two?"],
  ["Чи писав(ла) ти колись першим(ою)? Чим закінчилось?", "Писал(а) ли ты когда-нибудь первым(ой)? Чем закончилось?", "Have you ever texted first? How did it end?"],
  ["Яку пісню ти слухаєш, коли сумуєш?", "Какую песню ты слушаешь, когда грустишь?", "What song do you listen to when you're sad?"],
  ["Що {name} має зробити, щоб тебе вразити?", "Что {name} должен(на) сделать, чтобы тебя впечатлить?", "What would {name} have to do to impress you?"],
  ["Чи віриш ти в кохання з першого погляду?", "Веришь ли ты в любовь с первого взгляда?", "Do you believe in love at first sight?"],
  ["Що в тобі помічають найперше?", "Что в тебе замечают в первую очередь?", "What do people notice about you first?"],
  ["Яке перше враження в тебе про {name}?", "Какое у тебя первое впечатление о {name}?", "What's your first impression of {name}?"],
  ["Напиши {name} щирий комплімент.", "Напиши {name} искренний комплимент.", "Write {name} a sincere compliment."],
  ["Опиши себе трьома емоджі.", "Опиши себя тремя эмодзи.", "Describe yourself with three emojis."],
  ["Придумай для {name} миле прізвисько.", "Придумай для {name} милое прозвище.", "Come up with a cute nickname for {name}."],
  ["Напиши вірш із двох рядків про цей стіл.", "Напиши стих из двух строк про этот стол.", "Write a two-line poem about this table."],
  ["Запроси {name} на вигадане побачення: куди підете?", "Пригласи {name} на выдуманное свидание: куда пойдёте?", "Invite {name} on an imaginary date: where will you go?"],
  ["Напиши, яким би був ваш спільний фільм з {name}: назва і жанр.", "Напиши, каким был бы ваш общий фильм с {name}: название и жанр.", "Describe the movie you and {name} would star in: title and genre."],
  ["Напиши фразу, якою ти почав(ла) би знайомство з {name}.", "Напиши фразу, которой ты начал(а) бы знакомство с {name}.", "Write the line you'd use to start talking to {name}."],
  ["Опиши свій настрій зараз одним словом і одним емоджі.", "Опиши своё настроение сейчас одним словом и одним эмодзи.", "Describe your mood right now in one word and one emoji."],
  ["Вгадай, звідки {name}, і напиши чому так думаєш.", "Угадай, откуда {name}, и напиши, почему так думаешь.", "Guess where {name} is from and say why you think so."],
  ["Напиши три слова, які описують тебе на першому побаченні.", "Напиши три слова, которые описывают тебя на первом свидании.", "Write three words that describe you on a first date."],
  ["Порадь {name} фільм або серіал на вечір.", "Посоветуй {name} фильм или сериал на вечер.", "Recommend {name} a movie or show for tonight."],
  ["Напиши, що б ти приготував(ла) {name} на сніданок.", "Напиши, что бы ты приготовил(а) {name} на завтрак.", "Say what you'd make {name} for breakfast."],
  ["Що тобі подобається в {name}? Хоча б одне.", "Что тебе нравится в {name}? Хотя бы одно.", "What do you like about {name}? At least one thing."],
  ["Опиши свій ідеальний поцілунок.", "Опиши свой идеальный поцелуй.", "Describe your perfect kiss."],
  ["Куди б ти повів(ла) {name} на перше побачення?", "Куда бы ты повёл(а) {name} на первое свидание?", "Where would you take {name} on a first date?"],
  ["Надішли {name} повітряний поцілунок емоджі і поясни, за що 😘", "Отправь {name} воздушный поцелуй эмодзи и объясни, за что 😘", "Send {name} an emoji air kiss and say what it's for 😘"],
  ["Яка риса в протилежній статі тебе підкорює?", "Какая черта в противоположном поле тебя покоряет?", "Which trait in the opposite sex wins you over?"],
  ["Напиши {name}, яке в тебе склалося враження за цю гру.", "Напиши {name}, какое у тебя сложилось впечатление за эту игру.", "Tell {name} what impression you've formed during this game."],
  ["Опиши найромантичніший момент у твоєму житті.", "Опиши самый романтичный момент в твоей жизни.", "Describe the most romantic moment of your life."],
  ["Що для тебе важливіше: погляд, голос чи усмішка?", "Что для тебя важнее: взгляд, голос или улыбка?", "What matters more to you: eyes, voice or smile?"],
  ["Обійми чи поцілунок? Поясни свій вибір.", "Объятия или поцелуй? Объясни свой выбор.", "Hug or kiss? Explain your choice."],
  ["Напиши {name} фразу, від якої він(вона) усміхнеться.", "Напиши {name} фразу, от которой он(а) улыбнётся.", "Write {name} something that will make them smile."],
  ["Який твій найсміливіший романтичний досвід?", "Какой твой самый смелый романтический опыт?", "What's your boldest romantic experience?"],
  ["Що тебе найбільше заводить у партнері?", "Что тебя больше всего заводит в партнёре?", "What turns you on most in a partner?"],
  ["Яка твоя фантазія, якою комфортно поділитися?", "Какой фантазией тебе комфортно поделиться?", "Which fantasy are you comfortable sharing?"],
  ["Що для тебе найважливіше в інтимних стосунках?", "Что для тебя самое важное в интимных отношениях?", "What matters most to you in intimacy?"],
  ["Який романтичний сценарій ти хочеш спробувати?", "Какой романтический сценарий ты хочешь попробовать?", "Which romantic scenario would you like to try?"],
  ["Найнезвичайніше місце для поцілунку, де ти був(ла)?", "Самое необычное место для поцелуя, где ты был(а)?", "The most unusual place you've kissed someone?"],
  ["Що в {name} здається тобі найпривабливішим?", "Что в {name} кажется тебе самым привлекательным?", "What do you find most attractive about {name}?"],
  ["Опиши ідеальну ніч трьома словами.", "Опиши идеальную ночь тремя словами.", "Describe a perfect night in three words."],

  // ---------- команди в меню Telegram ----------
  ["Почати", "Начать", "Start"],
  ["Гра в бутилочку", "Игра в бутылочку", "Spin the Bottle"],
  ["Знайти співрозмовника", "Найти собеседника", "Find a chat partner"],
  ["Наступний співрозмовник", "Следующий собеседник", "Next partner"],
  ["Завершити діалог", "Завершить диалог", "End chat"],
  ["Мій профіль", "Мой профиль", "My profile"],
  ["Заповнити анкету", "Заполнить анкету", "Fill in profile"],
  ["Завантажити фото", "Загрузить фото", "Upload photo"],
  ["Запросити друзів", "Пригласить друзей", "Invite friends"],
  ["Поскаржитись", "Пожаловаться", "Report"],
  ["Правила", "Правила", "Rules"],
  ["Допомога", "Помощь", "Help"],
  ["Мій Telegram ID", "Мой Telegram ID", "My Telegram ID"],
  ["Відписатись від новин", "Отписаться от новостей", "Unsubscribe from news"],
  ["Знову отримувати новини", "Снова получать новости", "Get news again"],
  ["Подарувати подарунок", "Подарить подарок", "Send a gift"],
  ["Змінити мову", "Сменить язык", "Change language"],
];

const exact = { ru: new Map(), en: new Map() };
const templates = [];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

for (const [uk, ru, en] of ENTRIES) {
  if (/\{\d\}/.test(uk)) {
    const order = [];
    const pattern = uk.split(/(\{\d\})/).map((part) => {
      const m = /^\{(\d)\}$/.exec(part);
      if (!m) return escapeRe(part);
      order.push(Number(m[1]));
      return "([\\s\\S]*?)";
    }).join("");
    templates.push({ re: new RegExp(`^${pattern}$`), order, ru, en });
  } else {
    exact.ru.set(uk, ru);
    exact.en.set(uk, en);
  }
}

// Один рядок: точний збіг або шаблон. null — перекладу немає.
function one(lang, s) {
  const hit = exact[lang].get(s);
  if (hit !== undefined) return hit;
  for (const t of templates) {
    const m = t.re.exec(s);
    if (!m) continue;
    const vals = {};
    t.order.forEach((n, i) => { vals[n] = m[i + 1]; });
    return t[lang].replace(/\{(\d)\}/g, (_, n) => { const v = vals[n] ?? ""; return one(lang, v) ?? v; });
  }
  return null;
}

export function L(lang, text) {
  if (!text || typeof text !== "string" || !exact[lang]) return text;
  const whole = one(lang, text);
  if (whole !== null) return whole;
  if (!text.includes("\n")) return text;
  return text.split("\n").map((line) => one(lang, line) ?? line).join("\n");
}

// Кнопки клавіатур і інлайн-кнопки.
export function localizeMarkup(lang, markup) {
  if (!markup || !exact[lang]) return markup;
  const row = (r) => r.map((b) => (b && typeof b.text === "string" ? { ...b, text: L(lang, b.text) } : b));
  if (markup.keyboard) return { ...markup, keyboard: markup.keyboard.map(row) };
  if (markup.inline_keyboard) return { ...markup, inline_keyboard: markup.inline_keyboard.map(row) };
  return markup;
}

// Перекладений текст кнопки → український оригінал (для відповідей кнопками).
const reverse = new Map();
for (const [uk, ru, en] of ENTRIES) {
  if (/\{\d\}/.test(uk)) continue;
  for (const v of [uk, ru, en]) if (!reverse.has(v.toLowerCase())) reverse.set(v.toLowerCase(), uk);
}
export function toUk(text, allowed) {
  const uk = reverse.get(String(text).trim().toLowerCase());
  return uk && (!allowed || allowed.includes(uk)) ? uk : text;
}
