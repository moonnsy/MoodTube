import { getContext } from '../../../extensions.js';
import { callPopup, generateQuietPrompt } from '../../../../script.js';

const extensionName = "MoodTube";
const LOG_PREFIX = "[MoodTube]";

// --- ПАЛИТРА ---
const ACCENT_COLOR = '#8db7d5'; 
const BG_COLOR = 'rgba(15, 20, 25, 0.75)'; 
const BLUR_CSS = 'backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);';

let isPlayerFolded = true;
let isAnalysisInProgress = false;
let isCurrentlyPlaying = false; 
let ytPlayer = null;
let audioFallback = null;
let isUsingAudioFallback = false;
let currentVolume = 50;

let trackQueue = [];
let currentQueueIndex = -1;

async function getAudioStream(videoId) {
    for (let url of PIPED_INSTANCES) {
        try {
            const res = await fetch(`${url}/streams/${videoId}`);
            if (!res.ok) continue;
            const data = await res.json();
            if (data.audioStreams && data.audioStreams.length > 0) {
                const stream = data.audioStreams.find(s => s.bitrate >= 120000) || data.audioStreams[0];
                if (stream && stream.url) return stream.url;
            }
        } catch (e) {}
    }
    return null;
}

// --- ПРЕДВАРИТЕЛЬНАЯ ПОДГОТОВКА ТРЕКОВ (ФОНОВАЯ) ---
async function preResolveTrack(index) {
    if (index < 0 || index >= trackQueue.length) return;
    const track = trackQueue[index];
    if (track.isResolved || track.isResolving) return;

    track.isResolving = true;
    updateQueueUI();

    // Пытаемся подготовить стрим заранее, но НЕ помечаем как "Failed", если не нашли.
    // Если не найдем сейчас, попробуем еще раз в handleBlockedVideo при реальной ошибке.
    let streamUrl = await getAudioStream(track.videoId);
    if (streamUrl) {
        track.streamUrl = streamUrl;
        track.isResolved = true;
    }
    
    track.isResolving = false;
    updateQueueUI();
}

function preResolveNextTracks() {
    // Подготавливаем следующие 2 трека
    for (let i = 1; i <= 2; i++) {
        preResolveTrack(currentQueueIndex + i);
    }
}

// --- YOUTUBE IFRAME API ---
function initYTPlayer() {
    if (ytPlayer || !window.YT || !window.YT.Player) return;
    
    ytPlayer = new YT.Player('moodtube-yt-container', {
        height: '1', width: '1',
        playerVars: { 'autoplay': 1, 'controls': 0, 'playsinline': 1 },
        events: {
            'onReady': (event) => { event.target.setVolume(currentVolume); },
            'onStateChange': (event) => {
                isCurrentlyPlaying = (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING);
                $('#moodtube-btn-playpause').attr('class', isCurrentlyPlaying ? 'fa-solid fa-pause moodtube-ctrl' : 'fa-solid fa-play moodtube-ctrl');
                if (event.data === YT.PlayerState.ENDED) {
                    playNextInQueue();
                }
            },
            'onError': (event) => {
                console.warn(`${LOG_PREFIX} YT Player Error:`, event.data);
                const failedTrack = trackQueue[currentQueueIndex];
                if (failedTrack && !failedTrack.isFallback) {
                    handleBlockedVideo(failedTrack, currentQueueIndex);
                    return;
                }
                playNextInQueue();
            }
        }
    });
}

function loadYouTubeAPI() {
    if (window.YT && window.YT.Player) {
        initYTPlayer();
        return;
    }

    const oldReady = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
        if (oldReady) oldReady();
        initYTPlayer();
    };

    if (document.getElementById('yt-iframe-api')) return;
    
    const tag = document.createElement('script');
    tag.id = 'yt-iframe-api';
    tag.src = "https://www.youtube.com/iframe_api";
    const firstScriptTag = document.getElementsByTagName('script')[0];
    firstScriptTag.parentNode.insertBefore(tag, firstScriptTag);
}

// --- БЕСПЛАТНЫЙ ПОИСК БЕЗ БЭКЕНДА (Dynamic Piped & Invidious API) ---
const PIPED_INSTANCES = [
    "https://pipedapi.tokhmi.xyz",
    "https://piapi.ggtyler.dev",
    "https://pipedapi.kavin.rocks",
    "https://pipedapi.smnz.de"
];

async function getInvidiousInstances() {
    try {
        const response = await fetch("https://api.invidious.io/instances.json?sort_by=health");
        if (!response.ok) return [];
        const data = await response.json();
        return data
            .filter(d => d[1] && d[1].type === 'https')
            .map(d => d[1].uri);
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to fetch Invidious instances`, e);
        return [
            "https://vid.puffyan.us",
            "https://invidious.nerdvpn.de",
            "https://invidious.tiekoetter.com"
        ];
    }
}

async function searchYouTube(query) {
    const safeQuery = encodeURIComponent(query + ' audio');

    // Пытаемся сначала Piped API
    for (let url of PIPED_INSTANCES) {
        try {
            console.log(`${LOG_PREFIX} Searching on Piped: ${url}`);
            const response = await fetch(`${url}/search?q=${safeQuery}&filter=all`);
            if (!response.ok) continue;

            const data = await response.json();
            const video = data.items?.find(item => item.type === 'stream' && item.url.includes('?v='));
            if (video) {
                return {
                    videoId: video.url.split('?v=')[1],
                    title: video.title,
                    videoThumbnails: [{ url: video.thumbnail }]
                };
            }
        } catch (e) {
            console.warn(`${LOG_PREFIX} Piped API ${url} failed.`);
        }
    }

    // Если Piped не сработал, берем живые Invidious
    const invidiousInstances = await getInvidiousInstances();
    const topInstances = invidiousInstances.slice(0, 15);

    for (let url of topInstances) {
        try {
            console.log(`${LOG_PREFIX} Searching on Invidious: ${url}`);
            const response = await fetch(`${url}/api/v1/search?q=${safeQuery}&type=video`);
            if (!response.ok) continue;

            const data = await response.json();
            if (data && data.length > 0) return data[0]; 
        } catch (e) {
            console.warn(`${LOG_PREFIX} Invidious API ${url} failed.`);
        }
    }

    return null;
}

function updatePlayerVisibility() {
    const $widget = $('#moodtube-mini-player');
    if (isPlayerFolded) $widget.hide();
    else $widget.css('display', 'flex'); 
}

function stopPlayback(message = 'Очередь завершена') {
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
    isCurrentlyPlaying = false;
    $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
    $('#moodtube-widget-title').text(message);
    updateQueueUI();
}

function playNextInQueue() {
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
    if (trackQueue.length === 0) {
        stopPlayback();
        return;
    }
    
    currentQueueIndex++;
    if (currentQueueIndex >= trackQueue.length) {
        currentQueueIndex = trackQueue.length;
        stopPlayback();
        return;
    }

    const track = trackQueue[currentQueueIndex];
    playTrack(track);
}

function playPrevInQueue() {
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
    if (trackQueue.length === 0 || currentQueueIndex <= 0) {
        if (ytPlayer && typeof ytPlayer.seekTo === 'function') ytPlayer.seekTo(0);
        return;
    }
    currentQueueIndex--;
    playTrack(trackQueue[currentQueueIndex]);
}

async function handleBlockedVideo(failedTrack, index) {
    console.log(`${LOG_PREFIX} Track blocked. Attempting emergency bypass for:`, failedTrack.title);
    
    if (currentQueueIndex === index) {
        $('#moodtube-widget-title').text('Ищем обход блока...');
    }
    
    // 1. Пробуем прямой стрим
    let streamUrl = await getAudioStream(failedTrack.videoId);
    
    if (streamUrl) {
        failedTrack.streamUrl = streamUrl;
        failedTrack.isResolved = true;
        if (currentQueueIndex === index) playTrack(failedTrack);
        return;
    }

    // 2. Ищем альтернативу
    const queries = ["remix", "cover", "live", "nightcore", "lyrics"];
    let baseSearch = failedTrack.originalQuery || failedTrack.title;
    baseSearch = baseSearch.replace(/\b(official|music video|audio|hd|hq|lyrics|video)\b/gi, '').trim();

    for (const q of queries) {
        if (currentQueueIndex !== index) break;
        let res = await searchYouTube(baseSearch + " " + q);
        if (res && res.videoId && res.videoId !== failedTrack.videoId) {
            let altStream = await getAudioStream(res.videoId);
            if (altStream) {
                failedTrack.videoId = res.videoId;
                failedTrack.title = res.title + " (Alt)";
                failedTrack.streamUrl = altStream;
                failedTrack.isResolved = true;
                if (currentQueueIndex === index) playTrack(failedTrack);
                return;
            }
        }
    }

    if (currentQueueIndex === index) {
        failedTrack.isFailed = true;
        $('#moodtube-widget-title').text('Не удалось запустить трек');
        updateQueueUI();
        setTimeout(playNextInQueue, 2500);
    }
}

function playTrack(videoInfo) {
    if (!videoInfo) return;
    
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
    
    // Если обход уже готов, используем его
    if (videoInfo.streamUrl) {
        isUsingAudioFallback = true;
        isCurrentlyPlaying = true;
        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
        $('#moodtube-widget-title').text(videoInfo.title);
        
        const thumbUrl = `https://i.ytimg.com/vi/${videoInfo.videoId}/mqdefault.jpg`;
        $('#moodtube-widget-cover').attr('src', thumbUrl);

        audioFallback.src = videoInfo.streamUrl;
        audioFallback.volume = currentVolume / 100;
        audioFallback.play().catch(e => {
            console.error("Audio Playback Error", e);
            handleBlockedVideo(videoInfo, currentQueueIndex);
        });
        
        preResolveNextTracks();
        updateQueueUI();
        return;
    }

    // Иначе пробуем стандартный YT
    const currentVideoId = videoInfo.videoId;
    $('#moodtube-widget-title').text(videoInfo.title || 'YouTube Track');
    
    const thumbUrl = `https://i.ytimg.com/vi/${currentVideoId}/mqdefault.jpg`;
    $('#moodtube-widget-cover')
        .off('error')
        .on('error', function() {
            $(this).off('error').attr('src', `https://i.ytimg.com/vi/${currentVideoId}/default.jpg`);
        })
        .attr('src', thumbUrl);
    
    if (ytPlayer && typeof ytPlayer.loadVideoById === 'function') {
        try {
            ytPlayer.loadVideoById(currentVideoId);
            isCurrentlyPlaying = true;
            $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
        } catch (e) {
            console.error(`${LOG_PREFIX} Error playing track:`, e);
            handleBlockedVideo(videoInfo, currentQueueIndex);
        }
    }

    preResolveNextTracks();
    updateQueueUI();
}

async function searchAndPlay(query) {
    $('#moodtube-widget-title').text('Ищем трек...');
    const videoInfo = await searchYouTube(query);
    
    if (videoInfo && videoInfo.videoId) {
        videoInfo.originalQuery = query;
        trackQueue.push(videoInfo);
        
        preResolveTrack(trackQueue.length - 1);
        
        if (trackQueue.length === 1 || !isCurrentlyPlaying) {
            currentQueueIndex = trackQueue.length - 1;
            playTrack(videoInfo);
        } else {
            updateQueueUI();
        }
        return true;
    } else {
        callPopup("MoodTube: Песня не найдена.", "warning");
        $('#moodtube-widget-title').text('Песня не найдена');
        return false;
    }
}

function updateQueueUI() {
    const $qList = $('#moodtube-queue-list');
    if (!$qList.length) return;
    
    $qList.empty();
    if (trackQueue.length === 0) {
        $qList.append('<div style="font-size:12px; color:#888; text-align:center; padding:10px;">Очередь пуста</div>');
        return;
    }

    trackQueue.forEach((track, index) => {
        const isCurrent = index === currentQueueIndex;
        let statusIcon = '';
        if (track.isResolving) statusIcon = '<i class="fa-solid fa-spinner fa-spin" style="font-size:10px; color:#aaa;"></i>';
        else if (track.isFailed) statusIcon = '<i class="fa-solid fa-triangle-exclamation" style="font-size:10px; color:#ff4444;" title="Не удалось запустить"></i>';
        else if (track.isResolved) statusIcon = '<i class="fa-solid fa-circle-check" style="font-size:10px; color:#00ff00;" title="Обход готов"></i>';

        const $item = $(`
            <div class="moodtube-queue-item" style="
                display:flex; align-items:center; gap:10px; padding:8px 10px; 
                cursor:pointer; border-radius:10px; margin-bottom:5px;
                background: ${isCurrent ? 'rgba(141, 183, 213, 0.2)' : 'rgba(0,0,0,0.3)'};
                border: 1px solid ${isCurrent ? ACCENT_COLOR : 'transparent'};
                transition: 0.2s;
            ">
                <img src="https://i.ytimg.com/vi/${track.videoId}/default.jpg" style="width:30px; height:30px; border-radius:5px; object-fit:cover;">
                <span style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; color:${track.isFailed ? '#ff4444' : (isCurrent ? '#fff' : '#aaa')}; text-decoration: ${track.isFailed ? 'line-through' : 'none'};">${track.title}</span>
                <div style="display:flex; gap:5px; align-items:center;">
                    ${statusIcon}
                    ${isCurrent ? '<i class="fa-solid fa-volume-high" style="color:' + ACCENT_COLOR + '; font-size:10px;"></i>' : ''}
                </div>
            </div>
        `);
        
        $item.on('click', () => {
            currentQueueIndex = index;
            playTrack(trackQueue[currentQueueIndex]);
        });
        
        $qList.append($item);
    });
}

// --- ВШИТЫЙ ИИ-ПРОМТ ---
async function triggerMoodAnalysisAndPlay() {
    if (isAnalysisInProgress) return;
    
    $('#moodtube-btn-ai').css('color', '#00ff00').addClass('fa-spin');
    isAnalysisInProgress = true;

    try {
        const context = getContext();
        if (!context?.chat?.length) {
            callPopup("DJ AI: Чат пуст!", "warning");
            return;
        }
        
        const snippet = context.chat.slice(-15).map(m => `${m.is_user ? 'User' : 'Character'}: ${m.mes}`).join('\n');
        
        const prompt = `[SYSTEM NOTE: CRITICAL OVERRIDE. YOU ARE A STRICT METADATA API. 
DO NOT ROLEPLAY. DO NOT SPEAK AS THE CHARACTER. NO GREETINGS. NO CONVERSATION.
Read the chat history and output ONLY a valid JSON object.
Rule 1: If a song is mentioned in the text, select it.
Rule 2: Otherwise, choose a fitting mood track.
Format strictly: {"Title": "Song Name", "Artist": "Artist Name"}

Chat History:
${snippet}]`;

        const customEnable = localStorage.getItem('moodtube_ai_enable') === 'true';
        const customUrl = localStorage.getItem('moodtube_ai_url');
        const customKey = localStorage.getItem('moodtube_ai_key');
        const customModel = localStorage.getItem('moodtube_ai_model') || 'gpt-3.5-turbo';

        let aiResponse;
        
        if (customEnable && customUrl && customKey) {
            console.log(`${LOG_PREFIX} Using Custom AI Endpoint...`);
            const res = await fetch(customUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${customKey}`
                },
                body: JSON.stringify({
                    model: customModel,
                    messages: [{ role: 'system', content: prompt }],
                    temperature: 0.7
                })
            });
            if (!res.ok) throw new Error(`Custom AI API Error: ${res.status}`);
            aiResponse = await res.json();
        } else {
            console.log(`${LOG_PREFIX} Using SillyTavern generateQuietPrompt...`);
            aiResponse = await generateQuietPrompt({ quietPrompt: prompt, quietToLoud: false, skipWIAN: true, quietName: 'System' });
        }

        if (!aiResponse) throw new Error("AI Timeout");

        console.log(`${LOG_PREFIX} Raw AI Response:`, aiResponse);

        // Умное извлечение текста из любых сложных объектов от API
        let aiText = "";
        if (typeof aiResponse === 'string') {
            aiText = aiResponse;
        } else if (aiResponse.text) {
            aiText = aiResponse.text;
        } else if (aiResponse.candidates?.[0]?.content?.parts?.[0]?.text) {
            // Специфично для Google Vertex AI (Gemini)
            aiText = aiResponse.candidates[0].content.parts[0].text;
        } else if (aiResponse.choices?.[0]?.message?.content) {
            // Специфично для OpenAI форматов
            aiText = aiResponse.choices[0].message.content;
        } else {
            // Если ничего не подошло, переводим весь объект в строку и ищем в нем
            aiText = JSON.stringify(aiResponse);
        }
        
        let parsed = null;
        
        // Попытка 1: Найти блок ```json ... ```
        const blockMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (blockMatch) {
            try { parsed = JSON.parse(blockMatch[1]); } catch(e) {}
        }
        
        // Попытка 2: Умный поиск первого { и соответствующего ему }
        if (!parsed) {
            // Ищем конструкцию, похожую на наш ожидаемый JSON
            const titleMatch = aiText.match(/\{\s*"[Tt]itle"/);
            if (titleMatch) {
                const startIdx = titleMatch.index;
                let depth = 0;
                let endIdx = -1;
                for (let i = startIdx; i < aiText.length; i++) {
                    if (aiText[i] === '{') depth++;
                    else if (aiText[i] === '}') {
                        depth--;
                        if (depth === 0) {
                            endIdx = i;
                            break;
                        }
                    }
                }
                if (endIdx !== -1) {
                    try { parsed = JSON.parse(aiText.substring(startIdx, endIdx + 1)); } catch(e) {}
                }
            }
        }
        
        // Попытка 3: Регулярные выражения как крайняя мера (очень агрессивный поиск)
        if (!parsed) {
            const titleMatch = aiText.match(/"(?:Title|title)"\s*:\s*"([^"]+)"/i);
            const artistMatch = aiText.match(/"(?:Artist|artist)"\s*:\s*"([^"]+)"/i);
            if (titleMatch || artistMatch) {
                parsed = {
                    Title: titleMatch ? titleMatch[1] : "",
                    Artist: artistMatch ? artistMatch[1] : ""
                };
            }
        }

        if (!parsed || (!parsed.Title && !parsed.title)) {
            console.error(`${LOG_PREFIX} Extracted string failed parsing:`, aiText);
            throw new Error("No valid JSON or song info found in response");
        }
        
        const searchQuery = `${parsed.Title || parsed.title} ${parsed.Artist || parsed.artist}`;
        
        await searchAndPlay(searchQuery);

    } catch (e) {
        console.error(`${LOG_PREFIX} DJ AI Parse Error:`, e);
        callPopup(`DJ AI Ошибка: Не смог разобрать ответ.`, "error");
    } finally {
        isAnalysisInProgress = false;
        $('#moodtube-btn-ai').css('color', ACCENT_COLOR).removeClass('fa-spin');
    }
}

// --- ФИЗИКА ПЕРЕТАСКИВАНИЯ И ИЗМЕНЕНИЯ РАЗМЕРА ---
function handleDrag($el, storageKey) {
    let isDragging = false;
    let startX, startY, initialLeft, initialTop;
    const el = $el[0];

    try {
        const savedPos = localStorage.getItem(storageKey);
        if (savedPos) {
            const pos = JSON.parse(savedPos);
            if (pos && pos.left && pos.top) {
                el.style.left = pos.left; el.style.top = pos.top;
                el.style.right = 'auto'; el.style.bottom = 'auto'; el.style.transform = 'none'; 
            }
        }
    } catch (e) {}

    const onStart = (e) => {
        if ($(e.target).hasClass('moodtube-ctrl') || $(e.target).is('input') || $(e.target).closest('#moodtube-resize-handle').length) return;
        startX = e.clientX || e.touches?.[0].clientX; startY = e.clientY || e.touches?.[0].clientY;
        const rect = el.getBoundingClientRect();
        initialLeft = rect.left; initialTop = rect.top;
        if (el.style.transform && el.style.transform.includes('translate')) {
            el.style.transform = 'none'; el.style.left = initialLeft + 'px'; el.style.top = initialTop + 'px';
        }
        isDragging = false;
        $(document).on('mousemove touchmove', onMove); $(document).on('mouseup touchend', onEnd);
    };

    const onMove = (e) => {
        const clientX = e.clientX || e.touches?.[0].clientX; const clientY = e.clientY || e.touches?.[0].clientY;
        const dx = clientX - startX; const dy = clientY - startY;
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) isDragging = true;
        el.style.left = `${initialLeft + dx}px`; el.style.top = `${initialTop + dy}px`;
    };

    const onEnd = () => {
        $(document).off('mousemove touchmove', onMove); $(document).off('mouseup touchend', onEnd);
        if (isDragging) localStorage.setItem(storageKey, JSON.stringify({ left: el.style.left, top: el.style.top }));
        setTimeout(() => isDragging = false, 100);
    };

    el.addEventListener('mousedown', onStart); el.addEventListener('touchstart', onStart, { passive: false });
}

function handleResize($el, $handle, storageKey) {
    let isResizing = false;
    let startX, startY, startWidth, startHeight;
    const el = $el[0];
    const handle = $handle[0];

    const onStart = (e) => {
        e.preventDefault(); e.stopPropagation();
        isResizing = true;
        startX = e.clientX || e.touches?.[0].clientX; startY = e.clientY || e.touches?.[0].clientY;
        const rect = el.getBoundingClientRect();
        startWidth = rect.width; startHeight = rect.height;
        $(document).on('mousemove touchmove', onMove); $(document).on('mouseup touchend', onEnd);
    };

    const onMove = (e) => {
        if (!isResizing) return;
        const clientX = e.clientX || e.touches?.[0].clientX; const clientY = e.clientY || e.touches?.[0].clientY;
        const dx = clientX - startX; const dy = clientY - startY;
        
        let newWidth = Math.max(160, startWidth + dx);
        let newHeight = Math.max(60, startHeight + dy);
        
        el.style.width = `${newWidth}px`; el.style.height = `${newHeight}px`;
    };

    const onEnd = () => {
        if (isResizing) {
            localStorage.setItem(storageKey, JSON.stringify({ width: el.style.width, height: el.style.height }));
            isResizing = false;
        }
        $(document).off('mousemove touchmove', onMove); $(document).off('mouseup touchend', onEnd);
    };

    handle.addEventListener('mousedown', onStart); handle.addEventListener('touchstart', onStart, { passive: false });
}

// --- УМНОЕ ВСТРАИВАНИЕ В ИНТЕРФЕЙС ---
function attachToUI() {
    if ($('#extensionsMenu').length > 0 && $('#moodtube-menu-item-container').length === 0) {
        $('#extensionsMenu').append(`
            <div id="moodtube-menu-item-container" class="extension_container interactable" tabindex="0">
                <div id="moodtube-wand-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0" style="color: ${ACCENT_COLOR};">
                    <i class="fa-solid fa-music" style="width: 20px; text-align: center;"></i>
                    <span>MoodTube</span>
                </div>
            </div>
        `);
        $('#moodtube-wand-item').on('click', () => {
            isPlayerFolded = !isPlayerFolded;
            updatePlayerVisibility();
        });
    }
}

// --- ИНИЦИАЛИЗАЦИЯ ИНТЕРФЕЙСА ---
async function initializeExtension() {
    if ($('#moodtube-yt-container').length === 0 && $('#yt-iframe-api').length === 0) {
        $('<div id="moodtube-yt-container" style="position:absolute; width:1px; height:1px; left:-9999px; top:-9999px; opacity:0; pointer-events:none;"></div>').appendTo('body');
    }
    loadYouTubeAPI();

    $(`<style>
        .moodtube-ctrl:hover { color: ${ACCENT_COLOR} !important; transform: scale(1.1); transition: 0.2s; }
        .moodtube-slider { -webkit-appearance: none; width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; outline: none; margin: 0 10px; }
        .moodtube-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: ${ACCENT_COLOR}; cursor: pointer; border: 2px solid #fff; box-shadow: 0 0 5px rgba(0,0,0,0.5); }
        
        #moodtube-mini-player { transition: opacity 0.3s; }
        #moodtube-inner-content { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 15px; width: 100%; height: 100%; box-sizing: border-box; }
        
        /* Responsive Row Layout */
        .moodtube-row-layout #moodtube-inner-content { flex-direction: row; justify-content: flex-start; gap: 12px; }
        .moodtube-row-layout #moodtube-cover-container { width: 50px !important; height: 50px !important; border-width: 2px !important; }
        .moodtube-row-layout #moodtube-cover-hole { width: 8px !important; height: 8px !important; }
        .moodtube-row-layout #moodtube-title-container { align-items: flex-start !important; text-align: left !important; flex: 1; min-width: 0; }
        .moodtube-row-layout #moodtube-volume-container { width: 80px; }
        
        /* Minimal Layout (Hidden elements) */
        .moodtube-no-cover #moodtube-cover-container { display: none !important; }
        .moodtube-no-vol #moodtube-volume-container { display: none !important; }
        .moodtube-no-title #moodtube-title-container { display: none !important; }
    </style>`).appendTo('head');

    setInterval(attachToUI, 1000);

    if ($('#moodtube-mini-player').length === 0) {
        let savedW = '250px';
        let savedH = '350px';
        try {
            const savedDim = localStorage.getItem('moodtube_dim');
            if (savedDim) {
                const dim = JSON.parse(savedDim);
                if (dim.width) savedW = dim.width;
                if (dim.height) savedH = dim.height;
            }
        } catch (e) {}
        
        $(`
        <div id="moodtube-mini-player" style="
            position: fixed; top: 150px; left: 50%; transform: translateX(-50%);
            background: ${BG_COLOR}; border: 1px solid rgba(141, 183, 213, 0.3);
            border-radius: 20px; padding: 20px; color: #fff;
            font-family: -apple-system, sans-serif;
            z-index: 9998; display: none; 
            box-shadow: 0 15px 35px rgba(0,0,0,0.8), inset 0 0 10px rgba(141, 183, 213, 0.1); 
            width: ${savedW}; height: ${savedH}; ${BLUR_CSS} cursor: grab; user-select: none;
            box-sizing: border-box; overflow: hidden;
        ">
            <div id="moodtube-inner-content">
                <div id="moodtube-cover-container" style="width: 140px; height: 140px; border-radius: 50%; background: #050505; border: 3px solid ${ACCENT_COLOR}; box-shadow: 0 5px 15px rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; position: relative; overflow: hidden; flex-shrink: 0; transition: 0.3s all;">
                    <img id="moodtube-widget-cover" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
                    <div id="moodtube-cover-hole" style="position: absolute; width: 14px; height: 14px; background: #222; border-radius: 50%; border: 1px solid ${ACCENT_COLOR}; transition: 0.3s all;"></div>
                </div>
                
                <div id="moodtube-title-container" style="display: flex; flex-direction: column; align-items: center; width: 100%; text-align: center; flex-shrink: 0;">
                    <span id="moodtube-widget-title" style="font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; margin-bottom: 2px;">No Track Selected</span>
                    <span style="color: ${ACCENT_COLOR}; font-size: 12px; font-weight: bold;">MoodTube DJ</span>
                </div>
                
                <div id="moodtube-controls-container" style="display: flex; gap: 15px; align-items: center; flex-shrink: 0;">
                    <i class="fa-solid fa-list-ul moodtube-ctrl" id="moodtube-btn-queue" style="cursor:pointer; color: ${ACCENT_COLOR}; font-size: 16px; transition: 0.3s;" title="Queue"></i>
                    <i class="fa-solid fa-backward-step moodtube-ctrl" id="moodtube-btn-prev" style="cursor:pointer; color: #fff; font-size: 18px; transition: 0.2s;" title="Previous"></i>
                    <i class="fa-solid fa-play moodtube-ctrl" id="moodtube-btn-playpause" style="cursor:pointer; font-size: 28px; color: #fff; transition: 0.2s; width: 28px; text-align: center;"></i>
                    <i class="fa-solid fa-forward-step moodtube-ctrl" id="moodtube-btn-next" style="cursor:pointer; color: #fff; font-size: 18px; transition: 0.2s;" title="Next"></i>
                    <i class="fa-solid fa-wand-magic-sparkles moodtube-ctrl" id="moodtube-btn-ai" style="cursor:pointer; color: ${ACCENT_COLOR}; font-size: 18px; transition: 0.3s;" title="Auto-DJ (AI)"></i>
                </div>

                <div id="moodtube-volume-container" style="display: flex; align-items: center; width: 90%; flex-shrink: 0;">
                    <i class="fa-solid fa-volume-low" style="font-size: 12px; color: ${ACCENT_COLOR};"></i>
                    <input type="range" id="moodtube-vol-slider" min="0" max="100" value="50" class="moodtube-slider moodtube-ctrl">
                    <i class="fa-solid fa-volume-high" style="font-size: 14px; color: ${ACCENT_COLOR};"></i>
                </div>
            </div>
            
            <div id="moodtube-queue-container" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; background:${BG_COLOR}; z-index:4; padding:15px; box-sizing:border-box; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
                    <span style="font-weight:bold; font-size:14px; color:${ACCENT_COLOR};">Очередь треков</span>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl" id="moodtube-btn-close-queue" style="cursor:pointer; font-size:14px; color:#fff;"></i>
                </div>
                <div id="moodtube-queue-list" style="flex:1; overflow-y:auto; padding-right:5px;">
                    <div style="font-size:12px; color:#888; text-align:center; padding:10px;">Очередь пуста</div>
                </div>
            </div>
            
            <div id="moodtube-settings-container" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; background:${BG_COLOR}; z-index:4; padding:15px; box-sizing:border-box; flex-direction:column; color: #fff; font-size: 12px; overflow-y: auto;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
                    <span style="font-weight:bold; font-size:14px; color:${ACCENT_COLOR};">Настройки AI</span>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl" id="moodtube-btn-close-settings" style="cursor:pointer; font-size:14px; color:#fff;"></i>
                </div>
                <div style="display:flex; flex-direction:column; gap:8px;">
                    <label style="display: flex; align-items: center; gap: 5px; cursor: pointer;">
                        <input type="checkbox" id="moodtube-setting-enable" style="cursor: pointer;">
                        <span>Использовать внешний ИИ API</span>
                    </label>
                    <label>OpenAI-совместимый URL API:</label>
                    <input type="text" id="moodtube-setting-url" placeholder="https://api.openai.com/v1/chat/completions" style="background: rgba(0,0,0,0.5); border: 1px solid ${ACCENT_COLOR}; color: white; padding: 5px; border-radius: 5px; width: 100%; box-sizing: border-box;">
                    
                    <label>API Key:</label>
                    <input type="password" id="moodtube-setting-key" placeholder="sk-..." style="background: rgba(0,0,0,0.5); border: 1px solid ${ACCENT_COLOR}; color: white; padding: 5px; border-radius: 5px; width: 100%; box-sizing: border-box;">
                    
                    <label>Модель:</label>
                    <input type="text" id="moodtube-setting-model" placeholder="gpt-3.5-turbo" style="background: rgba(0,0,0,0.5); border: 1px solid ${ACCENT_COLOR}; color: white; padding: 5px; border-radius: 5px; width: 100%; box-sizing: border-box;">
                    
                    <div style="display: flex; gap: 5px;">
                        <button id="moodtube-btn-test-settings" style="flex: 1; background: rgba(255,255,255,0.1); color: #fff; border: 1px solid ${ACCENT_COLOR}; padding: 8px; border-radius: 5px; cursor: pointer; font-weight: bold; margin-top: 5px;">Проверить</button>
                        <button id="moodtube-btn-save-settings" style="flex: 1; background: ${ACCENT_COLOR}; color: #000; border: none; padding: 8px; border-radius: 5px; cursor: pointer; font-weight: bold; margin-top: 5px;">Сохранить</button>
                    </div>
                    <span style="font-size: 10px; color: #aaa; margin-top: 5px;">Позволяет не отправлять всю историю и карточки персонажей при поиске.</span>
                </div>
            </div>
            
            <audio id="moodtube-audio-fallback" style="display:none;"></audio>
            
            <i class="fa-solid fa-gear moodtube-ctrl" id="moodtube-btn-settings" style="position: absolute; top: 12px; right: 40px; cursor: pointer; color: #888; font-size: 16px; z-index: 5;" title="Settings"></i>
            <i class="fa-solid fa-xmark moodtube-ctrl" id="moodtube-btn-close" style="position: absolute; top: 12px; right: 15px; cursor: pointer; color: #888; font-size: 16px; z-index: 5;" title="Close"></i>
            
            <div id="moodtube-resize-handle" style="position: absolute; bottom: 0; right: 0; width: 25px; height: 25px; cursor: nwse-resize; display: flex; justify-content: center; align-items: center; z-index: 10;">
                <i class="fa-solid fa-caret-down" style="color: rgba(255,255,255,0.2); font-size: 14px; transform: rotate(-45deg);"></i>
            </div>
        </div>
        `).appendTo('body');

        $('#moodtube-btn-playpause').on('click', () => {
            if (isUsingAudioFallback && audioFallback) {
                if (isCurrentlyPlaying) audioFallback.pause();
                else audioFallback.play();
            } else if (ytPlayer) {
                if (isCurrentlyPlaying) ytPlayer.pauseVideo();
                else ytPlayer.playVideo();
            }
        });

        $('#moodtube-btn-next').on('click', playNextInQueue);
        $('#moodtube-btn-prev').on('click', playPrevInQueue);
        
        $('#moodtube-btn-queue').on('click', () => {
            $('#moodtube-inner-content').hide();
            $('#moodtube-btn-close').hide();
            $('#moodtube-queue-container').css('display', 'flex');
            updateQueueUI();
        });

        $('#moodtube-btn-close-queue').on('click', () => {
            $('#moodtube-queue-container').hide();
            $('#moodtube-inner-content').css('display', '');
            $('#moodtube-btn-close').show();
        });
        
        $('#moodtube-btn-settings').on('click', () => {
            $('#moodtube-inner-content').hide();
            $('#moodtube-btn-close').hide();
            $('#moodtube-queue-container').hide();
            $('#moodtube-settings-container').css('display', 'flex');
            
            $('#moodtube-setting-enable').prop('checked', localStorage.getItem('moodtube_ai_enable') === 'true');
            $('#moodtube-setting-url').val(localStorage.getItem('moodtube_ai_url') || '');
            $('#moodtube-setting-key').val(localStorage.getItem('moodtube_ai_key') || '');
            $('#moodtube-setting-model').val(localStorage.getItem('moodtube_ai_model') || '');
        });

        $('#moodtube-btn-close-settings').on('click', () => {
            $('#moodtube-settings-container').hide();
            $('#moodtube-inner-content').css('display', '');
            $('#moodtube-btn-close').show();
        });

        $('#moodtube-btn-save-settings').on('click', () => {
            localStorage.setItem('moodtube_ai_enable', $('#moodtube-setting-enable').is(':checked') ? 'true' : 'false');
            localStorage.setItem('moodtube_ai_url', $('#moodtube-setting-url').val().trim());
            localStorage.setItem('moodtube_ai_key', $('#moodtube-setting-key').val().trim());
            localStorage.setItem('moodtube_ai_model', $('#moodtube-setting-model').val().trim());
            callPopup("MoodTube: Настройки AI сохранены", "success");
            $('#moodtube-btn-close-settings').click();
        });

        $('#moodtube-btn-test-settings').on('click', async () => {
            const url = $('#moodtube-setting-url').val().trim();
            const key = $('#moodtube-setting-key').val().trim();
            const model = $('#moodtube-setting-model').val().trim();
            
            if (!url || !key) {
                callPopup("Введите URL и API Key", "warning");
                return;
            }
            
            const oldText = $('#moodtube-btn-test-settings').text();
            $('#moodtube-btn-test-settings').text('⏳').prop('disabled', true);
            
            try {
                const res = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${key}`
                    },
                    body: JSON.stringify({
                        model: model,
                        messages: [{ role: 'user', content: 'respond with "ok"' }],
                        max_tokens: 10
                    })
                });
                
                if (res.ok) {
                    callPopup("Соединение успешно!", "success");
                } else {
                    const err = await res.json().catch(() => ({error: {message: "Unknown error"}}));
                    callPopup(`Ошибка: ${res.status} - ${err.error?.message || 'Check console'}`, "error");
                }
            } catch (e) {
                console.error(e);
                callPopup(`Ошибка сети: ${e.message}`, "error");
            } finally {
                $('#moodtube-btn-test-settings').text(oldText).prop('disabled', false);
            }
        });
        
        $('#moodtube-btn-close').on('click', () => {
            isPlayerFolded = true;
            updatePlayerVisibility();
        });
        
        $('#moodtube-btn-ai').on('click', async () => { await triggerMoodAnalysisAndPlay(); });

        $('#moodtube-vol-slider').on('input', function() {
            currentVolume = $(this).val();
            if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
                ytPlayer.setVolume(currentVolume);
            }
            if (audioFallback) {
                audioFallback.volume = currentVolume / 100;
            }
        });
        
        audioFallback = $('#moodtube-audio-fallback')[0];
        if (audioFallback) {
            audioFallback.addEventListener('play', () => {
                isCurrentlyPlaying = true;
                $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
            });
            audioFallback.addEventListener('pause', () => {
                isCurrentlyPlaying = false;
                $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
            });
            audioFallback.addEventListener('ended', playNextInQueue);
            audioFallback.addEventListener('error', () => {
                console.error(`${LOG_PREFIX} Audio fallback error`);
                playNextInQueue();
            });
        }

        handleDrag($('#moodtube-mini-player'), 'moodtube_player_pos');
        handleResize($('#moodtube-mini-player'), $('#moodtube-resize-handle'), 'moodtube_dim');

        // Responsive Observer
        const observer = new ResizeObserver(entries => {
            for (let entry of entries) {
                const w = entry.contentRect.width;
                const h = entry.contentRect.height;
                const $p = $(entry.target);
                
                $p.toggleClass('moodtube-row-layout', w > h * 1.3 && w > 280);
                $p.toggleClass('moodtube-no-cover', (h < 150 && w < 300) || h < 90);
                $p.toggleClass('moodtube-no-vol', w < 200 || h < 110);
                $p.toggleClass('moodtube-no-title', h < 70);
            }
        });
        observer.observe($('#moodtube-mini-player')[0]);
    }
    updatePlayerVisibility();
}

$(document).ready(() => { setTimeout(initializeExtension, 1500); });