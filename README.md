# Облака сообщений

Минималистичный статический сайт: сообщения превращаются в мягкие облака на экране.

## Как работает лимит

В статическом режиме сайт работает локально в браузере. Для реального общего лимита между всеми пользователями нужен общий backend.

В проект добавлен пример backend на Cloudflare Workers + Durable Object:

- `backend/cloudflare-worker.mjs`
- `backend/wrangler.example.toml`

Он хранит единое состояние неба: одновременно летит до 18 сообщений. Если места нет, новое сообщение попадает в общую FIFO-очередь. Когда облако уплывает, освобождается место, и первым запускается самое раннее сообщение из очереди.

## Что загрузить в GitHub

Загрузи в корень репозитория эти файлы:

- `index.html`
- `styles.css`
- `script.js`
- `.nojekyll`
- `README.md`

Папку `backend/` можно загрузить в репозиторий тоже, но GitHub Pages её не запускает. Её нужно деплоить отдельно как Cloudflare Worker.

Папку `src/` можно не загружать для сайта: это отдельный Java-файл из шаблона IDE, на работу страницы он не влияет.

## Локальный запуск

Открой `index.html` в браузере или запусти простой локальный сервер:

```bash
python3 -m http.server 8000
```

После этого открой:

```text
http://localhost:8000
```

## Публикация через GitHub Pages

1. Создай публичный репозиторий, например `VIBE`.
2. Загрузи файлы сайта в корень репозитория.
3. Открой `Settings` -> `Pages`.
4. В `Build and deployment` выбери `Deploy from a branch`.
5. В `Branch` выбери `main` и папку `/(root)`, затем нажми `Save`.

Через пару минут сайт будет доступен по адресу вида:

```text
https://<github-user>.github.io/VIBE/
```

## Подключение общего лимита

1. Разверни Worker из папки `backend/`.
2. Скопируй `backend/wrangler.example.toml` в `backend/wrangler.toml`.
3. После деплоя Worker возьми его URL, например:

```text
https://vibe-clouds.<account>.workers.dev
```

4. В `index.html` замени пустую строку:

```html
window.VIBE_API_URL = window.VIBE_API_URL || "";
```

на URL Worker:

```html
window.VIBE_API_URL = "https://vibe-clouds.<account>.workers.dev";
```

После этого лимит и очередь будут общими для всех пользователей сайта.
