<p align="center">
  <img src="https://i.postimg.cc/5yB4kKTg/STYLE-Semi-realistic-digital-painting-WLOP-202605262006.jpg" alt="MoodTube Banner" width="100%">
</p>

## 🎧 Что такое MoodTube?

**MoodTube** — это ваш личный ИИ-диджей для ролевых в SillyTavern. Он не просто проигрывает музыку, а читает контекст вашей сцены и подбирает идеальный саундтрек. Больше не нужно отвлекаться от игры, чтобы найти нужный вайб — ИИ сделает всё за вас, обойдёт блокировки YouTube и спрячет нелюбимые треки.

---
## 🪄 Где найти расширение?

<p align="center">
  <img src="https://i.postimg.cc/X7QS7yML/Screenshot-20260526-181425-Yandex-Browser.jpg" alt="Где найти MoodTube" width="300">
</p>

После установки перезагрузите SillyTavern полностью. Иконка **MoodTube** (нотка) уютно поселится в меню расширений — там, где **Волшебная палочка**. Просто кликайте на неё, и плеер появится на экране!

---
## 🎛️ Главный плеер

<p align="center">
  <img src="https://i.postimg.cc/0QpbKCxT/IMG-0194-JPG-202605262031.jpg" alt="Интерфейс плеера" width="300">
</p>

Компактный виджет, который можно свободно перемещать по экрану и менять в размерах. В нём собрано всё самое необходимое:

* **✨ Волшебная палочка (Auto-DJ):** Главная магия расширения! Нажмите на неё, и ИИ проанализирует последние 15 сообщений чата, чтобы подобрать трек, который идеально ложится на текущие события в ролевой.
* **Список (Очередь):** Открывает список текущих и сгенерированных треков.
* **Шестерёнка (Настройки):** Открывает окно для тонкой настройки вайба, жанров и API.
* **Крестик:** Сворачивает плеер в маленькую удобную иконку в меню расширений.

---

## ⚙️ Настройки и генерация

<p align="center">
  <img src="https://i.postimg.cc/rpGkSZ0d/Screenshot-20260526-182615-Yandex-Browser.jpg" alt="Настройки MoodTube" width="500">
</p>

В меню настроек вы можете полностью контролировать то, как ИИ подбирает музыку. Выбирайте теги, чтобы задать нужное направление:

* **Жанры и Настроение:** От классики и эмбиента до киберпанка и агрессивного фонка.
* **Сценарии:** Подскажите диджею, что происходит. В таверне затишье? Начался босс-файт? Или у вас Русреал с дождливой драмой?
* <img width="20" height="20" src="https://img.icons8.com/ios-filled/50/8db7d5/cd-collection.png" alt="cd-collection" style="vertical-align: middle;"/> **Массовая генерация:** Укажите количество (до 30!) и нажмите на эту иконку. ИИ за секунды сгенерирует огромный тематический плейлист под вашу сцену. 
* **API Настройки:** По умолчанию используется ИИ самой Таверны, но вы можете подключить любой внешний OpenAI-совместимый API по ключу.

---

## 📜 Очередь и Умный обход

<p align="center">
  <img src="https://i.postimg.cc/ht1nm37V/Screenshot-20260526-182533-Yandex-Browser.jpg" alt="Очередь треков" width="300">
</p>

Музыка не должна прерываться на самом интересном месте. Поэтому у MoodTube есть своя система выживания:

* `⏳ Ищем` — ИИ уже нашёл трек и проверяет, доступен ли он для воспроизведения.
* `⚠️ Обход` — YouTube заблокировал видео из-за авторских прав (обычное дело). Но плеер не сдаётся: он автоматически ищет прямой аудио-поток через Invidious/Piped API или подбирает крутой кавер/ремикс.
* `❌ Заблокировано` — Случай, когда обход не удался. Трек будет пропущен, чтобы не стопорить очередь.

**Бан-лист:**
Если вам категорически не нравится песня или исполнитель, просто нажмите <img width="20" height="20" src="https://img.icons8.com/ios-filled/50/8db7d5/dislike.png" alt="dislike" style="vertical-align: middle;"/> в очереди. Трек мгновенно отправится в исключения, и ИИ больше никогда вам его не включит!


---

## 💿 Плейлисты MoodTube

Работают и в режиме YouTube, и в режиме Spotify. Плейлисты хранятся в настройках таверны на сервере, а не в браузере, поэтому они общие для компьютера и телефона.

* ❤ **Сердечко** добавляет играющий трек в «Любимые», повторное нажатие убирает.
* ➕ **Плюсик** у трека в очереди открывает окно «Добавить в плейлист». Там можно отметить нужные плейлисты галочками или сразу создать новый.
* Кнопка **«Плейлисты»** в шапке очереди открывает список плейлистов. В любой можно зайти: там треки, «Слушать», «Перемешать», переименование и удаление. Плейлист заменяет текущую очередь.
* **В режиме Spotify** в панели и в окне плюсика две вкладки: Spotify слева и MoodTube справа. Выбранная вкладка запоминается. В «Настройки → API → Spotify» можно выбрать, куда сохраняет сердечко и какие разделы показывает плюсик: Spotify и MoodTube, только Spotify или только MoodTube.
* Трек, добавленный в одном режиме, играет и в другом: если в плейлисте нет его id для текущего режима, MoodTube найдёт трек по названию.

Классы для тем: `.mt-pl-section` (`-spotify` / `-moodtube`), `.mt-pl-section-title`, `.mt-pl-section-add`, `.mt-playlist-item` (`.mt-playlist-fav`), `.mt-pl-cover`, `.mt-pl-count`, `.mt-pl-toolbar` > `.mt-pl-tool` (`.mt-pl-play` / `.mt-pl-shuffle` / `.mt-pl-rename` / `.mt-pl-delete`), `.mt-pl-track` (`.mt-pl-track-remove`), `.mt-pl-inline` (поле создания и переименования), окно `.mt-pl-modal` > `.mt-pl-modal-box` > `.mt-pl-option` (`.mt-is-added`), вкладки `.mt-pl-tabs` > `.mt-pl-tab` (`.mt-is-active`, `[data-mt-tab="spotify|moodtube"]`). Закрашенное сердечко — `.mt-btn-favorite.mt-is-active`.

---

## 🎨 Свои темы (Custom)

Выберите в настройках «Интерфейс → Тема оформления → **Custom**». Там можно задать цвета, картинки, подписи и свой CSS, а потом выгрузить всё одним `.json` и загрузить обратно. Импорт также понимает JSON-темы самой SillyTavern: из них берутся `custom_css` и основные цвета.

**Формат файла**
```json
{
    "type": "moodtube_theme",
    "version": 2,
    "name": "Cupid",
    "vars":   { "accent": "#ff7aa8", "accent_hover": "#ff9cbf", "bg_primary": "rgba(40,20,30,.9)", "bg_secondary": "...", "bg_input": "...", "border": "..." },
    "images": { "bg": "https://...", "scene": "", "cover_bg": "", "cover": "data:image/png;base64,...", "decor": "" },
    "labels": { "header": "cupid player", "subtitle": "love songs", "status_playing": "now playing..", "status_paused": "paused", "status_idle": "" },
    "custom_css": "@import url('https://fonts.googleapis.com/css2?family=Pixelify+Sans&display=swap');\n.mt-player { font-family: 'Pixelify Sans'; }"
}
```


**Каталог тем.** В редакторе Custom есть поле «Каталог тем». Туда вставляется ссылка на `index.json`, и MoodTube показывает галерею: превью, название, автор, описание. Кнопка «Установить» подставляет тему в редактор, применится она после «Сохранить». Последний адрес каталога запоминается.

```json
{
    "type": "moodtube_catalog",
    "version": 1,
    "name": "Название каталога",
    "themes": [
        {
            "id": "rose-vinyl",
            "name": "Rose Vinyl",
            "author": "ник",
            "description": "Пиксельный розовый плеер с пластинкой",
            "file": "themes/vinyl/rose-vinyl.json",
            "preview": "previews/rose-vinyl.png",
            "tags": ["light", "pixel"],
            "version": 1
        }
    ]
}
```
`file` и `preview` можно указывать относительными (от адреса `index.json`) или полными ссылками. Файл темы — обычный `moodtube_theme` v2. Ссылки на каталог:
`https://raw.githubusercontent.com/<user>/<repo>/<branch>/index.json` или `https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/index.json`.


Галерея показывается сеткой. Перекрасы одной темы собираются в одну карточку с выбором варианта. Группа определяется автоматически по общей части названия («Rose Vinyl», «Mint Vinyl» → «Vinyl»; «Clear Case», «Clear Case Holo» → «Clear Case»). Управлять этим можно необязательными полями темы в `index.json`:
* `"group": "Vinyl"` — явная группа, приоритетнее автоопределения;
* `"variant": "Rose"` — подпись варианта в списке (по умолчанию это название без имени группы);
* `"swatch": "#e0709a"` — цвет варианта. Если он задан у всех тем группы, вместо выпадающего списка показываются цветные кружки.

Над сеткой есть поиск и фильтр по самым частым тегам. Если поиск попал в конкретный перекрас, карточка сразу переключается на него.
Ограничения безопасности:
* принимаются только https-ссылки с `raw.githubusercontent.com`, `cdn.jsdelivr.net`, `gist.githubusercontent.com` и `*.github.io`, и для каталога, и для файлов тем и превью;
* `index.json` не больше 512 КБ, файл темы не больше 2 МБ;
* перед установкой показывается предупреждение «Тема из внешнего источника»;
* тема проходит тот же разбор, что и импорт файла (`normalizeCustomTheme`, `cssUrlValue`), ничего не выполняется.

**Как подключается CSS.** Свой CSS идёт отдельным `<style>` без добавок спереди, поэтому `@import` работает. Базовые стили плеера заданы на классах с низкой специфичностью, так что `!important` для них не нужен.

**Структура плеера**
```
.mt-player#moodtube-mini-player        [data-mt-state="playing|paused|idle"], .mt-is-playing / .mt-is-paused / .mt-is-idle, .mt-dj-busy
├─ .mt-slot.mt-slot-bg                 картинка --mt-img-bg (под всем)
├─ .mt-slot.mt-slot-scene              картинка --mt-img-scene (область под сцену)
├─ .mt-player-header
│  ├─ .mt-player-header-title          подпись «Заголовок плеера» (пустая — скрыта)
│  └─ .mt-player-status                подпись статуса, меняется по состоянию
├─ .mt-player-body
│  ├─ .mt-cover > .mt-slot-cover-bg (--mt-img-cover-bg), .mt-cover-img, .mt-slot-cover (--mt-img-cover), .mt-cover-hole
│  ├─ .mt-track-info > .mt-track-title, .mt-track-subtitle, .mt-btn-favorite
│  ├─ .mt-progress > .mt-time-current, .mt-progress-slider, .mt-time-total
│  ├─ .mt-controls > .mt-btn-queue, .mt-btn-prev, .mt-btn-play, .mt-btn-next, .mt-btn-ai(.mt-is-busy) > .mt-btn-icon(.fa-spin)
│  └─ .mt-volume > .mt-volume-low, .mt-volume-slider, .mt-volume-high
├─ .mt-slot.mt-slot-decor              картинка --mt-img-decor (поверх, клики проходят насквозь)
├─ .mt-panel.mt-panel-queue / .mt-panel-playlists
│  └─ .mt-queue-item(.mt-is-current / .mt-is-blocked / .mt-is-searching) > .mt-queue-thumb, .mt-queue-title, .mt-queue-now, .mt-queue-add, .mt-queue-dislike; пусто — .mt-queue-empty
├─ .mt-window-btn.mt-btn-settings / .mt-btn-close
└─ .mt-resize-handle
```
Плавающая кнопка: `.mt-fab` > `.mt-fab-icon`. У неё те же классы состояния, что и у плеера. Пока кнопку тащат, на ней висит `.mt-is-dragging`, а внутри DreamAlbum — `.mt-fab-docked`. Inline у кнопки только координаты.

Тени текста из тем таверны сбрасываются: `.mt-player *, .mt-fab * { text-shadow: none }`. Если тень нужна, верните её своим CSS.

Размер плеера меняет `.moodtube-row-layout` (горизонтальный режим), `.moodtube-no-cover`, `.moodtube-no-vol` и `.moodtube-no-title`.

**Цвета текста и окно настроек** (`#mt-settings-modal`) тоже задаются переменными. По умолчанию цвета прежние, поэтому светлую тему можно собрать по одной строке на цвет:
```css
#mt-settings-modal, .mt-player, .mt-fab {
    --mt-text: #3a2230;            /* основной текст (заголовки, поля, кнопки) */
    --mt-text-dim: #9a6b80;        /* приглушённый текст (подписи, крестик, время, очередь) */
    --mt-text-on-accent: #fff;     /* текст на акцентном фоне (активные теги, «Сохранить») */
}
#mt-settings-modal {
    --mt-overlay: rgba(255,200,220,.5);            /* затемнение фона за окном */
    --mt-modal-shadow: 0 10px 30px rgba(0,0,0,.3); /* тень окна */
}
```
Тонкая настройка: `--mt-text-soft` (заголовки категорий, теги, чекбоксы), `--mt-text-strong` (текст при наведении), `--mt-text-placeholder`, `--mt-divider`. Если они не заданы, берутся `--mt-text` и `--mt-text-dim`. Три основных цвета текста можно задать и в редакторе темы.

В окне настроек: `.mt-subpanel` (подпанели), `.mt-theme-editor` (редактор темы), `.mt-spotify-settings`, `.mt-divider`, `.mt-label-strong`, `.mt-label-accent`, `.mt-status-text`. Плашки `code` берут фон `--mt-bg-input`. Рамка окна `.mt-flex-container` стилизуется через `#mt-settings-modal .mt-flex-container`: так тема таверны её не перебивает, а в своей теме пишите селектор с той же специфичностью.


**Вид «Полоса под шапкой таверны»** («Интерфейс → Вид плеера»). Это узкая полоса прямо над чатом: она стоит в `#sheld` перед `#chat`, поэтому чат сдвигается вниз, а не перекрывается. Кнопка справа открывает полный плеер с очередью, плейлистами, поиском и настройками.
```
.mt-dock#moodtube-dock                 те же классы состояния: .mt-is-playing / .mt-is-paused / .mt-is-idle, [data-mt-state], .mt-dj-busy
├─ .mt-slot.mt-dock-slot-bg            картинка --mt-img-dock
├─ .mt-dock-inner
│  ├─ .mt-dock-cover > .mt-dock-cover-img
│  ├─ .mt-dock-info > .mt-dock-title, .mt-dock-subtitle   (подпись берётся из «Подпись под треком»)
│  └─ .mt-dock-controls > .mt-dock-fav(.mt-is-active), .mt-dock-prev, .mt-dock-play, .mt-dock-next, .mt-dock-ai(.mt-is-busy), .mt-dock-expand(.mt-is-open)
└─ .mt-dock-progress > .mt-dock-progress-fill   (клик — перемотка)
```
Переменные: `--mt-dock-height` (48px), `--mt-dock-bg`, `--mt-dock-cover-size` (36px), `--mt-dock-cover-radius` (50%), `--mt-dock-track`, `--mt-dock-progress`. Когда включён этот вид, у `body` есть класс `.mt-layout-dock`.
**Слайдеры** защищены от глобальных стилей таверны. Их вид меняется переменными, `!important` не нужен:
`--mt-slider-track`, `--mt-slider-track-height`, `--mt-slider-track-radius`, `--mt-slider-progress` (Firefox), `--mt-slider-thumb-size`, `--mt-slider-thumb-bg`, `--mt-slider-thumb-bg-hover`, `--mt-slider-thumb-border`, `--mt-slider-thumb-radius`, `--mt-slider-thumb-shadow`.
