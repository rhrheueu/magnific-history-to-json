# Freepik History → JSON (Chrome Extension)

## Цель
Сделать Chrome-расширение (Manifest V3), которое выгружает историю промптов Freepik (Pikaso) со страницы History в JSON и предлагает пользователю скачать файл для отчётов.

## Что делает
- Проматывает историю на странице `https://www.freepik.com/pikaso/projects/history` до конца.
- Собирает данные по каждому промпту.
- Поля JSON: `prompt`, `model`, `quality`, `types`, `resolutions`, `tags`.
- `model` определяется по тегам/иконкам, `quality` берётся из тегов.
- Сохраняет JSON через стандартную загрузку Chrome.
- Показывает pop-up прогресс с кнопкой `Stop`.

## Как устроено
- `background.js`: инжектит `parser.js` по клику через `chrome.scripting.executeScript`.
- `background.js`: принимает `FREEPIK_EXPORT_READY` и скачивает JSON через `chrome.downloads.download`.
- `parser.js`: проверяет, что открыта нужная страница.
- `parser.js`: определяет скролл-контейнер, проматывает ленту и собирает данные из DOM по `data-cy`-селекторам.
- `parser.js`: нормализует теги/типы/разрешения и отправляет результат в `background.js`.
- `manifest.json`: права `downloads`, `activeTab`, `scripting` и `host_permissions` для доменов Freepik.

## Файлы
- `manifest.json` — манифест MV3.
- `background.js` — инжект скрипта и скачивание JSON.
- `parser.js` — логика парсинга + UI прогресса.
- `icons/` — иконки расширения.

## Настройки парсера
В `parser.js`:
- `SETTINGS.endCheckCycles` — сколько циклов подряд без новых промптов считать концом ленты.
- `SETTINGS.maxIters` — максимальное число итераций (страховка от вечного цикла).
- `SETTINGS.stepDelayMs` — пауза между итерациями.

## Итоговый файл
Файл сохраняется в загрузках с именем вида `freepik_history_YYYY-MM-DD.json`.
