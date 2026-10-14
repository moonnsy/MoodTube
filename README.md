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

## 🎨 Свои темы (Custom)

Выберите в настройках «Интерфейс → Тема оформления → **Custom**». Там можно задать цвета, картинки, подписи и свой CSS, а потом выгрузить всё одним `.json` и загрузить обратно. Импорт также понимает JSON-темы самой SillyTavern: из них берутся `custom_css` и основные цвета.

**Формат файла**
```json
{
    "type": "moodtube_theme",
    "version": 2,
    "name": "Cupid",
    "vars":   { "accent": "#ff7aa8", "accent_hover": "#ff9cbf", "bg_primary": "rgba(40,20,30,.9)", "bg_secondary": "...", "bg_input": "...", "border": "..." },
    "images": { "bg": "https://...", "scene": "", "cover": "data:image/png;base64,...", "decor": "" },
    "labels": { "header": "cupid player", "subtitle": "love songs", "status_playing": "now playing..", "status_paused": "paused", "status_idle": "" },
    "custom_css": "@import url('https://fonts.googleapis.com/css2?family=Pixelify+Sans&display=swap');\n.mt-player { font-family: 'Pixelify Sans'; }"
}
```

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
│  ├─ .mt-cover > .mt-cover-img, .mt-slot-cover (--mt-img-cover), .mt-cover-hole
│  ├─ .mt-track-info > .mt-track-title, .mt-track-subtitle, .mt-btn-favorite
│  ├─ .mt-progress > .mt-time-current, .mt-progress-slider, .mt-time-total
│  ├─ .mt-controls > .mt-btn-queue, .mt-btn-prev, .mt-btn-play, .mt-btn-next, .mt-btn-ai(.mt-is-busy)
│  └─ .mt-volume > .mt-volume-low, .mt-volume-slider, .mt-volume-high
├─ .mt-slot.mt-slot-decor              картинка --mt-img-decor (поверх, клики проходят насквозь)
├─ .mt-panel.mt-panel-queue / .mt-panel-playlists
├─ .mt-window-btn.mt-btn-settings / .mt-btn-close
└─ .mt-resize-handle
```
Размер плеера меняет `.moodtube-row-layout` (горизонтальный режим), `.moodtube-no-cover`, `.moodtube-no-vol` и `.moodtube-no-title`.

**Слайдеры** защищены от глобальных стилей таверны. Их вид меняется переменными, `!important` не нужен:
`--mt-slider-track`, `--mt-slider-track-height`, `--mt-slider-track-radius`, `--mt-slider-progress` (Firefox), `--mt-slider-thumb-size`, `--mt-slider-thumb-bg`, `--mt-slider-thumb-bg-hover`, `--mt-slider-thumb-border`, `--mt-slider-thumb-radius`, `--mt-slider-thumb-shadow`.
