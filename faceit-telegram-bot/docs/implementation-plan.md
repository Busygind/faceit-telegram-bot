# План реализации Telegram бота FACEIT CS2 — Telegram Serverless

Актуализирован 15 октября 2026 года после выбора JavaScript + Telegram Serverless. Заменяет Python/Docker/VPS план. Каталог проекта: `/Users/busygind02/IdeaProject/faceit-telegram-bot`.

## Задача

Реализовать `/last <ник>`, `/stats <ник>`, `/poll`, `/setts`, `/ts`, меню и полный групповой путь без регистрации игроков. Карточка — утверждённый FACEIT Dark. Хранение — встроенная SQLite Telegram, выполнение — JS модули V8, без внешнего сервера.

## Структура

Переносимое ядро → тесты → Telegram обработчики → тесты сценариев → настройка и эксплуатация → финальная локальная проверка. Облачная приёмка выполняется после выдачи доступа отдельно; не обозначать её пройденной без BotFather и ключа FACEIT.

## Ограничения среды

- Использовать только `sdk`, `sdk/db` и собственные `.js` модули в `tgcloud/`. Нет runtime npm, Node.js, файловой системы или Buffer.
- Не предполагать наличие WebCrypto, env secrets, фоновых worker или scheduler: эти механизмы не документированы. Шифрование — bundled проверенная JS библиотека; конфигурацию создаёт локальный защищённый генератор.
- Обрабатывать длинную историю порциями с checkpoint и кнопкой «Продолжить»; не обещать автоматическую работу после завершения invocation.
- Не писать сырой Telegram update, FACEIT ключ или TeamSpeak пароль в логи. Не хранить ключ шифрования в той же SQLite, что ciphertext.
- Начать работу в изолированном временном каталоге, затем перенести проверенный проект в запрошенный каталог с разрешением файловой системы. Удалить промежуточные файлы.

## План исполнения

### Этап 1 Переносимое ядро

**Реализовать:** FACEIT HTTP клиент, возобновляемую историю 1/30 завершённых матчей, нормализатор BO3 и метрик с покрытием, SQLite репозиторий с compare-and-swap, шифрование с AAD chat_id, атомарную миграцию chat_id, FACEIT Dark PNG на Uint8Array с лицензированным bitmap atlas.

**Файлы:** `tgcloud/lib/faceit.js`, `tgcloud/lib/store.js`, `tgcloud/lib/credentials.js`, `tgcloud/lib/card.js`, `tgcloud/schema.js`, `docs/api-contract.md` внутри каталога проекта.

**Документация:** [Telegram Serverless](https://core.telegram.org/bots/serverless), [FACEIT Data API](https://docs.faceit.com/docs/data-api/data/), [noble ciphers](https://github.com/paulmillr/noble-ciphers).

**Проверка:** `node scripts/check.mjs`; `node scripts/render-demo.mjs`; визуально открыть PNG.

### Этап 2 Тесты ядра

**Добавить:** `tests/faceit.test.js`, `tests/store.test.js`, `tests/credentials.test.js`, `tests/card.test.js`; mock fetch, SQLite in-memory, синтетические fixtures. Проверить границы истории, 429, missing stats, формулы, шифрование, A/B/C, миграцию, PNG.

**Примеры:** публичные функции этапа 1.

**Проверка:** `node --test tests/faceit.test.js tests/store.test.js tests/credentials.test.js tests/card.test.js`.

### Этап 3 Telegram сценарии

**Реализовать:** `tgcloud/lib/bot.js`, `tgcloud/lib/text.js`, `tgcloud/lib/poll.js`, `tgcloud/handlers/message.js`, `tgcloud/handlers/callback_query.js`. Slash-меню, admin/member access, allowlist, group/topic контекст, обязательный ник, TS команда и best-effort удаление, нативный опрос с точными девятью вариантами/флагами. Checkpoints в SQLite, безопасная кнопка продолжения, idempotency без слепого retry неопределённого POST.

**Документация:** [sendPoll](https://core.telegram.org/bots/api#sendpoll), Serverless handlers и raw SQL.

**Примеры:** репозиторий, FACEIT service и renderer этапа 1.

**Проверка:** `node scripts/check.mjs`; тесты ядра этапа 2.

### Этап 4 Тесты пользовательского пути

**Добавить:** `tests/bot.test.js`, `tests/poll.test.js`, `tests/text.test.js`, `tests/helpers.js`.

**Проверить:** добавление → меню → TeamSpeak A/B/C → опрос → last/stats разных ников без регистрации; права, приватный/forward/edit отказ, @bot_username, восстановление checkpoint, кнопки чужого чата, двойной update, ambiguous sendPoll, текстовый fallback и ограничения длины.

**Проверка:** `node --test`; `node scripts/check.mjs`.

### Этап 5 Настройка и эксплуатация

**Реализовать:** `scripts/configure.mjs`, `scripts/deploy.mjs`, `tgcloud/lib/settings.js`, `.gitignore`, `package.json`, lock, `tgcloud.jsonc`, `README.md`, `docs/deployment.md`, `docs/acceptance.md`. Защищённая генерация локального private config из secret файла/переменной без печати; app CLI token отдельно, preflight перед push, no secrets в diff. Описать login → push → migrate → webhook sync, восстановление, ротацию, реальные ограничения и недоступную без ключей приёмку.

**Проверка:** `node --test`; `node scripts/check.mjs`; CLI help/version без login; dry-run настройки в disposable каталоге.

### Этап 6 Локальная приёмка и передача

**Выполнить:** все тесты и визуальную проверку; перенести проект без перезаписи существующего; повторить проверки в конечном каталоге; обновить tracker; удалить staging, временные downloads и caches. Передать точные шаги и оставшиеся внешние проверки.

**Проверка:** `node --test`; `node scripts/check.mjs`; проверка UTF-8/LF и отсутствия промежуточных файлов.

## Облачная приёмка после предоставления доступов

Включить Serverless в BotFather; получить CLI Access token через `tgcloud login` и Server side FACEIT API key через локальный secret файл. Проверить фактические limits исполнения/доступность функций аккаунта, загрузку PNG и HTTP FACEIT. Пройти сценарии в тестовых группах A/B/C, проверить реальный опрос с двумя участниками и сравнить FACEIT matchroom. Только после этого заявлять, что бот развёрнут и работает в Telegram.
