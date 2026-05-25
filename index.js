

import { getContext } from '../../../extensions.js';
import { generateRaw } from '../../../../script.js';

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
let sessionPlayedTracks = [];

async function fetchWithTimeout(url, options = {}, timeoutMs = 4000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(id);
        return response;
    } catch (e) {
        clearTimeout(id);
        throw e;
    }
}

function prefetchBypassData(track) {
    if (track.prefetchPromise) return;
    
    track.prefetchPromise = (async () => {
        try {
            console.log(`${LOG_PREFIX} Prefetching bypass for:`, track.title);
            
            let isBlocked = false;
            try {
                const oembedRes = await fetchWithTimeout(`https://noembed.com/embed?url=https://www.youtube.com/watch?v=${track.videoId}`, {}, 3000);
                const data = await oembedRes.json();
                if (data.error) {
                    isBlocked = true;
                }
            } catch(e) {
                try {
                    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent('https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=' + track.videoId + '&format=json')}`;
                    const proxyRes = await fetchWithTimeout(proxyUrl, {}, 3000);
                    if (proxyRes.status === 401 || proxyRes.status === 403 || proxyRes.status === 404) {
                        isBlocked = true;
                    }
                } catch(e2) {}
            }

            let streamUrl = await getPipedStream(track.videoId);
            if (!streamUrl) streamUrl = await getInvidiousStream(track.videoId);
            
            track.streamUrl = streamUrl;
            
            if (!streamUrl || isBlocked) {
                const queries = ["lyrics", "remix", "cover", "live"];
                let baseSearch = track.originalQuery || track.title;
                baseSearch = baseSearch.replace(/\b(official|music video|audio|hd|hq|lyrics|video)\b/gi, '').trim();
                for (const q of queries) {
                    let res = await searchYouTube(baseSearch + " " + q);
                    if (res && res.videoId && res.videoId !== track.videoId) {
                        track.fallbackInfo = res;
                        break;
                    }
                }
            }

            if (isBlocked) {
                console.log(`${LOG_PREFIX} Track proactively identified as blocked:`, track.title);
                track.proactivelyBlocked = true;
                
                const index = trackQueue.indexOf(track);
                if (index !== -1 && index !== currentQueueIndex) {
                    if (!track.streamUrl && track.fallbackInfo) {
                        track.fallbackInfo.isFallback = true;
                        track.fallbackInfo.originalQuery = track.originalQuery;
                        trackQueue[index] = track.fallbackInfo;
                        updateQueueUI();
                    }
                }
            }
        } catch(e) {
            console.warn(`${LOG_PREFIX} Prefetch error:`, e);
        }
    })();
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
                if (isUsingAudioFallback) return;
                isCurrentlyPlaying = (event.data === YT.PlayerState.PLAYING || event.data === YT.PlayerState.BUFFERING);
                $('#moodtube-btn-playpause').attr('class', isCurrentlyPlaying ? 'fa-solid fa-pause moodtube-ctrl' : 'fa-solid fa-play moodtube-ctrl');
                if (event.data === YT.PlayerState.ENDED) {
                    playNextInQueue();
                }
            },
            'onError': (event) => {
                console.warn(`${LOG_PREFIX} YT Player Error:`, event.data);
                const failedTrack = trackQueue[currentQueueIndex];
                if (failedTrack) {
                    handleBlockedVideo(failedTrack, currentQueueIndex);
                } else {
                    playNextInQueue();
                }
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
    "https://piapi.ggtyler.dev",
    "https://pipedapi.tokhmi.xyz",
    "https://pipedapi.kavin.rocks",
    "https://piped-api.lunar.icu",
    "https://pipedapi.ngn.tf",
    "https://api.piped.private.coffee",
    "https://pipedapi.adminforge.de",
    "https://pipedapi.smnz.de"
];

async function getInvidiousInstances() {
    const fallback = [
        "https://inv.thepixora.com",
        "https://invidious.jing.rocks",
        "https://yt.artemislena.eu",
        "https://invidious.private.coffee",
        "https://invidious.nerdvpn.de",
        "https://invidious.tiekoetter.com"
    ];
    try {
        const response = await fetch("https://api.invidious.io/instances.json?sort_by=health");
        if (!response.ok) return fallback;
        const data = await response.json();
        const instances = data
            .filter(d => d[1] && d[1].type === 'https' && d[1].api === true && d[1].cors === true && d[1].health > 50)
            .map(d => d[1].uri);
        return instances.length > 0 ? instances : fallback;
    } catch (e) {
        console.warn(`${LOG_PREFIX} Failed to fetch Invidious instances`, e);
        return fallback;
    }
}

async function getPipedStream(videoId) {
    try {
        const promises = PIPED_INSTANCES.map(async url => {
            const res = await fetchWithTimeout(`${url}/streams/${videoId}`, {}, 4000);
            if (!res.ok) throw new Error('Bad response');
            const data = await res.json();
            if (data.audioStreams && data.audioStreams.length > 0) {
                const stream = data.audioStreams.find(s => s.bitrate >= 120000) || data.audioStreams[0];
                if (stream && stream.url) return stream.url;
            }
            throw new Error('No stream');
        });
        return await Promise.any(promises);
    } catch (e) {
        return null;
    }
}

async function getInvidiousStream(videoId) {
    try {
        const invidiousInstances = await getInvidiousInstances();
        const topInstances = invidiousInstances.slice(0, 8);
        const promises = topInstances.map(async url => {
            const res = await fetchWithTimeout(`${url}/api/v1/videos/${videoId}`, {}, 4000);
            if (!res.ok) throw new Error('Bad response');
            const data = await res.json();
            if (data.adaptiveFormats) {
                const audioStreams = data.adaptiveFormats.filter(f => f.type && f.type.startsWith('audio'));
                if (audioStreams.length > 0) {
                    const stream = audioStreams.find(s => parseInt(s.bitrate || 0) >= 120000) || audioStreams[0];
                    if (stream && stream.url) return stream.url;
                }
            }
            throw new Error('No stream');
        });
        return await Promise.any(promises);
    } catch(e) {
        return null;
    }
}

async function searchYouTube(query, isRetry = false) {
    const cleanQuery = query.replace(/[\[\](){}]/g, '').trim();
    const safeQuery = encodeURIComponent(cleanQuery);

    console.log(`${LOG_PREFIX} Searching for: ${cleanQuery}${isRetry ? ' (Retry)' : ''}`);

    try {
        const pipedPromises = PIPED_INSTANCES.map(async url => {
            const response = await fetchWithTimeout(`${url}/search?q=${safeQuery}&filter=all`, {}, 4000);
            if (!response.ok) throw new Error('Bad response');
            const data = await response.json();
            const video = data.items?.find(item => (item.type === 'stream' || item.type === 'video') && (item.url || item.videoId));
            if (video) {
                const vId = video.videoId || (video.url ? video.url.split('?v=')[1] : null) || (video.url ? video.url.split('/').pop() : null);
                if (vId) {
                    return {
                        videoId: vId,
                        title: video.title,
                        videoThumbnails: [{ url: video.thumbnail || `https://i.ytimg.com/vi/${vId}/default.jpg` }]
                    };
                }
            }
            throw new Error('No video found');
        });
        
        const videoInfo = await Promise.any(pipedPromises);
        if (videoInfo) {
            console.log(`${LOG_PREFIX} Found on Piped:`, videoInfo.title);
            return videoInfo;
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} All Piped APIs failed for search.`);
    }

    try {
        const invidiousInstances = await getInvidiousInstances();
        const topInstances = invidiousInstances.slice(0, 10);
        const invPromises = topInstances.map(async url => {
            const response = await fetchWithTimeout(`${url}/api/v1/search?q=${safeQuery}&type=video`, {}, 4000);
            if (!response.ok) throw new Error('Bad response');
            const data = await response.json();
            if (data && data.length > 0) return data[0];
            throw new Error('No video found');
        });
        
        const videoInfo = await Promise.any(invPromises);
        if (videoInfo) {
            console.log(`${LOG_PREFIX} Found on Invidious:`, videoInfo.title);
            return videoInfo;
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} All Invidious APIs failed for search.`);
    }

    if (!isRetry) {
        const simplified = cleanQuery.replace(/\b(official|music video|audio|hd|hq|lyrics|video|4k|remastered|vevo|full album)\b/gi, '').replace(/\s+/g, ' ').trim();
        if (simplified !== cleanQuery && simplified.length > 2) {
            return await searchYouTube(simplified, true);
        }
    }

    console.error(`${LOG_PREFIX} All search APIs failed for: ${cleanQuery}`);
    return null;
}

function updatePlayerVisibility() {
    const $widget = $('#moodtube-mini-player');
    if (isPlayerFolded) $widget.hide();
    else $widget.css('display', 'flex'); 
}

function playNextInQueue() {
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
    if (trackQueue.length === 0) {
        if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
        isCurrentlyPlaying = false;
        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
        $('#moodtube-widget-title').text('Queue finished');
        return;
    }
    
    currentQueueIndex++;
    if (currentQueueIndex >= trackQueue.length) {
        currentQueueIndex = trackQueue.length;
        updateQueueUI();
        if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
        isCurrentlyPlaying = false;
        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
        $('#moodtube-widget-title').text('Queue finished');
        return;
    }

    const track = trackQueue[currentQueueIndex];
    if (!track.videoId && track.isSearching) {
        isCurrentlyPlaying = false;
        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
        $('#moodtube-widget-title').text(track.title);
        updateQueueUI();
    } else if (track.searchFailed) {
        playNextInQueue();
    } else {
        playTrack(track);
    }
}

function playPrevInQueue() {
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
    if (trackQueue.length === 0 || currentQueueIndex <= 0) {
        if (ytPlayer && typeof ytPlayer.seekTo === 'function') ytPlayer.seekTo(0);
        return;
    }
    currentQueueIndex--;
    const track = trackQueue[currentQueueIndex];
    if (!track.videoId && track.isSearching) {
        isCurrentlyPlaying = false;
        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
        $('#moodtube-widget-title').text(track.title);
        updateQueueUI();
    } else if (track.searchFailed) {
        playPrevInQueue();
    } else {
        playTrack(track);
    }
}

async function handleBlockedVideo(failedTrack, index) {
    failedTrack.fallbackDepth = (failedTrack.fallbackDepth || 0) + 1;
    if (failedTrack.isExhausted || failedTrack.fallbackDepth > 4) {
        console.warn(`${LOG_PREFIX} Bypass exhausted for:`, failedTrack.title);
        failedTrack.isExhausted = true;
        failedTrack.title = "❌ Заблокировано: " + failedTrack.title.replace("❌ Заблокировано: ", "");
        if (currentQueueIndex === index) playNextInQueue();
        return;
    }

    console.log(`${LOG_PREFIX} Track blocked. Attempting bypass for:`, failedTrack.title);
    
    // Ждем завершения префетча, если он идет
    if (failedTrack.prefetchPromise) {
        console.log(`${LOG_PREFIX} Waiting for prefetch to finish...`);
        await failedTrack.prefetchPromise;
    }
    
    // ШАГ 1: Direct Stream (Piped / Invidious)
    if (!failedTrack.step1Attempted) {
        failedTrack.step1Attempted = true;
        
        let streamUrl = failedTrack.streamUrl;
        if (!streamUrl) {
            if (currentQueueIndex === index) $('#moodtube-widget-title').text('Обход (1/2): Прямой поток...');
            streamUrl = await getPipedStream(failedTrack.videoId);
            if (!streamUrl) streamUrl = await getInvidiousStream(failedTrack.videoId);
        }
        
        if (streamUrl) {
            console.log(`${LOG_PREFIX} Direct stream found.`);
            failedTrack.isFallback = true;
            failedTrack.streamUrl = streamUrl; // Save for recursive attempts
            playAudioStream(failedTrack, streamUrl, index);
            return;
        }
    }

    // ШАГ 2: Крайний вариант — Поиск ремиксов/каверов
    if (!failedTrack.step3Attempted) {
        failedTrack.step3Attempted = true;
        if (currentQueueIndex === index) $('#moodtube-widget-title').text('Обход (2/2): Поиск замены...');
        
        let fallbackInfo = failedTrack.fallbackInfo;
        if (!fallbackInfo) {
            const queries = ["remix", "cover", "live", "nightcore"];
            let baseSearch = failedTrack.originalQuery || failedTrack.title;
            baseSearch = baseSearch.replace(/\b(official|music video|audio|hd|hq|lyrics|video)\b/gi, '').trim();
            for (const q of queries) {
                let res = await searchYouTube(baseSearch + " " + q);
                if (res && res.videoId && res.videoId !== failedTrack.videoId) {
                    fallbackInfo = res;
                    break;
                }
            }
        }
        
        if (fallbackInfo && fallbackInfo.videoId) {
            console.log(`${LOG_PREFIX} Found alternative:`, fallbackInfo.title);
            fallbackInfo.isFallback = true;
            fallbackInfo.fallbackDepth = failedTrack.fallbackDepth;
            fallbackInfo.originalQuery = failedTrack.originalQuery;
            trackQueue[index] = fallbackInfo;
            
            // БОНУС: Новый трек будет прогнан через Шаг 0 (YouTube), а если он заблочен — снова через 1 и 2!
            if (currentQueueIndex === index) {
                playTrack(fallbackInfo);
            } else {
                updateQueueUI();
            }
            return;
        }
    }

    // Финальное поражение
    console.error(`${LOG_PREFIX} All bypass attempts failed for:`, failedTrack.title);
    failedTrack.isExhausted = true;
    failedTrack.title = "❌ Заблокировано: " + failedTrack.title.replace("❌ Заблокировано: ", "");
    updateQueueUI();
    if (currentQueueIndex === index) {
        $('#moodtube-widget-title').text(failedTrack.title);
        // Быстрый пропуск, чтобы не застревать
        setTimeout(() => playNextInQueue(), 150);
    }
}

function playAudioStream(track, streamUrl, index) {
    if (currentQueueIndex !== index) return;
    
    console.log(`${LOG_PREFIX} Bypassing YouTube iframe with direct stream.`);
    isUsingAudioFallback = true;
    isCurrentlyPlaying = true;
    $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
    $('#moodtube-widget-title').text(track.title);
    
    audioFallback.src = streamUrl;
    audioFallback.volume = currentVolume / 100;
    audioFallback.play().catch(e => {
        console.error(`${LOG_PREFIX} Audio playback failed`, e);
        handleBlockedVideo(track, index); // Рекурсивно переходим к следующему шагу
    });
}

function playTrack(videoInfo) {
    if (!videoInfo || !videoInfo.videoId) return;
    
    if (sessionPlayedTracks[sessionPlayedTracks.length - 1] !== videoInfo.title) {
        sessionPlayedTracks.push(videoInfo.title);
    }
    
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }

    if (videoInfo.proactivelyBlocked) {
        if (videoInfo.streamUrl) {
            playAudioStream(videoInfo, videoInfo.streamUrl, trackQueue.indexOf(videoInfo));
            return;
        } else if (videoInfo.fallbackInfo) {
            videoInfo.fallbackInfo.isFallback = true;
            videoInfo.fallbackInfo.originalQuery = videoInfo.originalQuery;
            const idx = trackQueue.indexOf(videoInfo);
            if (idx !== -1) trackQueue[idx] = videoInfo.fallbackInfo;
            playTrack(videoInfo.fallbackInfo);
            return;
        }
    }
    
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
        }
    } else {
        console.warn(`${LOG_PREFIX} ytPlayer is not ready.`);
    }
    updateQueueUI();
}

function enqueueQuery(query) {
    const trackObj = {
        title: "Ищем: " + query,
        originalQuery: query,
        videoId: null,
        isSearching: true
    };
    trackQueue.push(trackObj);
    updateQueueUI();
    
    if (trackQueue.length === 1 || (!isCurrentlyPlaying && (ytPlayer ? ytPlayer.getPlayerState() !== YT.PlayerState.PLAYING && ytPlayer.getPlayerState() !== YT.PlayerState.BUFFERING : true))) {
        if (currentQueueIndex === -1 || currentQueueIndex >= trackQueue.length - 1) {
            currentQueueIndex = trackQueue.length - 1;
            $('#moodtube-widget-title').text(trackObj.title);
        }
    }
    resolveQueueBackground();
}

let isResolvingQueue = false;
async function resolveQueueBackground() {
    if (isResolvingQueue) return;
    isResolvingQueue = true;
    
    for (let i = 0; i < trackQueue.length; i++) {
        let track = trackQueue[i];
        if (!track.videoId && track.originalQuery && !track.searchFailed) {
            const videoInfo = await searchYouTube(track.originalQuery);
            if (videoInfo && videoInfo.videoId) {
                track.videoId = videoInfo.videoId;
                track.title = videoInfo.title;
                track.videoThumbnails = videoInfo.videoThumbnails;
                delete track.isSearching;
                
                prefetchBypassData(track);
                updateQueueUI();
                
                if (currentQueueIndex === i && (!isCurrentlyPlaying || (ytPlayer && ytPlayer.getPlayerState() === YT.PlayerState.ENDED))) {
                    playTrack(trackQueue[i]);
                }
            } else {
                track.searchFailed = true;
                delete track.isSearching;
                track.title = "❌ Не найдено: " + track.originalQuery;
                updateQueueUI();
                if (currentQueueIndex === i) {
                    playNextInQueue();
                }
            }
            await new Promise(r => setTimeout(r, 800));
        }
    }
    isResolvingQueue = false;
}

async function searchAndPlay(query) {
    enqueueQuery(query);
    return true;
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
        const $item = $(`
            <div class="moodtube-queue-item" style="
                display:flex; align-items:center; gap:10px; padding:8px 10px; 
                cursor:pointer; border-radius:10px; margin-bottom:5px;
                background: ${isCurrent ? 'rgba(141, 183, 213, 0.2)' : 'rgba(0,0,0,0.3)'};
                border: 1px solid ${isCurrent ? ACCENT_COLOR : 'transparent'};
                transition: 0.2s;
            ">
                <img src="${track.videoId ? `https://i.ytimg.com/vi/${track.videoId}/default.jpg` : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}" style="width:30px; height:30px; border-radius:5px; object-fit:cover; ${!track.videoId ? 'background:rgba(255,255,255,0.1);' : ''}">
                <span style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; color:${isCurrent ? '#fff' : '#aaa'};">${track.title}</span>
                ${isCurrent ? '<i class="fa-solid fa-volume-high" style="color:' + ACCENT_COLOR + '; font-size:10px; margin-right:5px;"></i>' : ''}
                <i class="fa-solid fa-heart-crack moodtube-btn-dislike moodtube-ctrl" style="color:rgba(255, 100, 100, 0.8); font-size:12px; cursor:pointer;" title="Не нравится (В бан-лист)"></i>
            </div>
        `);
        
        $item.on('click', (e) => {
            if ($(e.target).hasClass('moodtube-btn-dislike')) return;
            currentQueueIndex = index;
            playTrack(trackQueue[currentQueueIndex]);
        });

        $item.find('.moodtube-btn-dislike').on('click', (e) => {
            e.stopPropagation();
            let currentBannedSongs = localStorage.getItem('moodtube_ai_banned_songs') || '';
            const songToBan = `${track.title} ${track.artist || track.Artist || ''}`.trim();
            if (songToBan) {
                currentBannedSongs = currentBannedSongs ? currentBannedSongs + ', ' + songToBan : songToBan;
                localStorage.setItem('moodtube_ai_banned_songs', currentBannedSongs);
                $('#moodtube-setting-banned-songs').val(currentBannedSongs);
                toastr.success(`Трек добавлен в исключения`);
            }
            
            trackQueue.splice(index, 1);
            if (isCurrent) {
                currentQueueIndex--;
                playNextInQueue();
            } else if (index < currentQueueIndex) {
                currentQueueIndex--;
                updateQueueUI();
            } else {
                updateQueueUI();
            }
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
            toastr.warning("DJ AI: Чат пуст!");
            return;
        }
        
        const snippet = context.chat.slice(-15).map(m => `${m.is_user ? 'User' : 'Character'}: ${m.mes}`).join('\n');
        
        let genre = localStorage.getItem('moodtube_ai_genre') || '';
        let scenario = localStorage.getItem('moodtube_ai_scenario') || '';
        let banlist = localStorage.getItem('moodtube_ai_banlist') || '';
        let bannedSongs = localStorage.getItem('moodtube_ai_banned_songs') || '';
        let customPrompt = localStorage.getItem('moodtube_ai_custom') || '';
        
        let antiRepeatStr = sessionPlayedTracks.length > 0 
            ? `\nDo NOT pick any of these already played songs: ${sessionPlayedTracks.slice(-20).join(', ')}` 
            : '';
            
        let banListStr = '';
        if (banlist.trim()) banListStr += `\nDo NOT pick any songs from these artists: ${banlist}`;
        if (bannedSongs.trim()) banListStr += `\nDo NOT pick any of these specific songs: ${bannedSongs}`;
        let styleStr = '';
        if (genre.trim()) styleStr += `\nPreferred Genre/Style: ${genre}`;
        if (scenario.trim()) styleStr += `\nCurrent Scenario/Vibe: ${scenario}`;
        
        let rusrealRule = (scenario.includes('Русреал') || genre.includes('Русреал')) ? "\nRule: If the scenario or genre is 'Русреал', select ONLY Russian songs and artists (Russian language lyrics)." : "";

        let defaultPrompt = `[SYSTEM NOTE: CRITICAL OVERRIDE. YOU ARE A STRICT METADATA API. 
DO NOT ROLEPLAY. DO NOT SPEAK AS THE CHARACTER. NO GREETINGS. NO CONVERSATION.
Read the chat history and output ONLY a valid JSON object.
Rule 1: If a song is mentioned in the text, select it.
Rule 2: Otherwise, choose a fitting mood track. ${styleStr} ${antiRepeatStr} ${banListStr} ${rusrealRule}
Format strictly: {"Title": "Song Name", "Artist": "Artist Name"}

Chat History:
${snippet}]`;

        let prompt = defaultPrompt;
        if (customPrompt.trim()) {
            prompt = customPrompt.replace('{{snippet}}', snippet).replace('{{history}}', sessionPlayedTracks.join(', '));
        }
        
        console.log(`${LOG_PREFIX} --- AI Request Prompt ---\n`, prompt);

        const customEnable = localStorage.getItem('moodtube_ai_enable') === 'true';
        let customUrl = localStorage.getItem('moodtube_ai_url');
        if (customUrl && !customUrl.endsWith('/chat/completions')) {
            customUrl = customUrl.replace(/\/+$/, '') + '/chat/completions';
        }
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
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.3
                })
            });
            if (!res.ok) throw new Error(`Custom AI API Error: ${res.status}`);
            aiResponse = await res.json();
        } else {
            console.log(`${LOG_PREFIX} Using SillyTavern generateRaw (Pure Mode)...`);
            aiResponse = await generateRaw({ 
                prompt: prompt, 
                systemPrompt: '' 
            });
        }

        if (!aiResponse) throw new Error("AI Timeout");

        console.log(`${LOG_PREFIX} --- Raw AI Response ---\n`, aiResponse);

        // Умное извлечение текста из любых сложных объектов от API
        let aiText = extractAIText(aiResponse);
        
        console.log(`${LOG_PREFIX} --- Parsed AI Text ---\n`, aiText);
        
        let parsed = parseAISongJSON(aiText);

        if (!parsed || (!parsed.Title && !parsed.title)) {
            console.error(`${LOG_PREFIX} Extracted string failed parsing:`, aiText);
            throw new Error("No valid JSON or song info found in response");
        }
        
        const searchQuery = `${parsed.Title || parsed.title} ${parsed.Artist || parsed.artist}`;
        
        await searchAndPlay(searchQuery);

    } catch (e) {
        console.error(`${LOG_PREFIX} DJ AI Parse Error:`, e);
        toastr.error(`DJ AI Ошибка: Не смог разобрать ответ.`);
    } finally {
        isAnalysisInProgress = false;
        $('#moodtube-btn-ai').css('color', ACCENT_COLOR).removeClass('fa-spin');
    }
}

function extractAIText(aiResponse) {
    if (typeof aiResponse === 'string') return aiResponse;
    if (aiResponse.text) return aiResponse.text;
    if (aiResponse.candidates?.[0]?.content?.parts?.[0]?.text) return aiResponse.candidates[0].content.parts[0].text;
    if (aiResponse.choices?.[0]?.message?.content) return aiResponse.choices[0].message.content;
    return JSON.stringify(aiResponse);
}

function parseAISongJSON(aiText) {
    let parsed = null;
    const blockMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (blockMatch) {
        try { parsed = JSON.parse(blockMatch[1]); } catch(e) {}
    }
    if (!parsed) {
        const titleMatch = aiText.match(/\{\s*"[Tt]itle"/i);
        if (titleMatch) {
            const startIdx = titleMatch.index;
            let depth = 0;
            let endIdx = -1;
            for (let i = startIdx; i < aiText.length; i++) {
                if (aiText[i] === '{') depth++;
                else if (aiText[i] === '}') {
                    depth--;
                    if (depth === 0) { endIdx = i; break; }
                }
            }
            if (endIdx !== -1) {
                try { parsed = JSON.parse(aiText.substring(startIdx, endIdx + 1)); } catch(e) {}
            }
        }
    }
    if (!parsed) {
        const titleMatch = aiText.match(/"(?:Title|title)"\s*:\s*"([^"]+)"/i);
        const artistMatch = aiText.match(/"(?:Artist|artist)"\s*:\s*"([^"]+)"/i);
        if (titleMatch || artistMatch) {
            parsed = { Title: titleMatch ? titleMatch[1] : "", Artist: artistMatch ? artistMatch[1] : "" };
        }
    }
    return parsed;
}

// --- БАЛК-ГЕНЕРАЦИЯ (10 треков) ---
async function triggerBulkMoodAnalysisAndPlay() {
    if (isAnalysisInProgress) return;
    
    $('#moodtube-btn-bulk-ai').css('color', '#00ff00').addClass('fa-spin');
    isAnalysisInProgress = true;

    try {
        const context = getContext();
        if (!context?.chat?.length) {
            toastr.warning("DJ AI: Чат пуст!");
            return;
        }
        
        const snippet = context.chat.slice(-20).map(m => `${m.is_user ? 'User' : 'Character'}: ${m.mes}`).join('\n');
        
        let genre = localStorage.getItem('moodtube_ai_genre') || '';
        let scenario = localStorage.getItem('moodtube_ai_scenario') || '';
        let banlist = localStorage.getItem('moodtube_ai_banlist') || '';
        let bannedSongs = localStorage.getItem('moodtube_ai_banned_songs') || '';
        
        let antiRepeatStr = sessionPlayedTracks.length > 0 
            ? `\nDo NOT pick any of these already played songs: ${sessionPlayedTracks.slice(-20).join(', ')}` 
            : '';
            
        let banListStr = '';
        if (banlist.trim()) banListStr += `\nDo NOT pick any songs from these artists: ${banlist}`;
        if (bannedSongs.trim()) banListStr += `\nDo NOT pick any of these specific songs: ${bannedSongs}`;
        let styleStr = '';
        if (genre.trim()) styleStr += `\nPreferred Genre/Style: ${genre}`;
        if (scenario.trim()) styleStr += `\nCurrent Scenario/Vibe: ${scenario}`;
        
        let rusrealRule = (scenario.includes('Русреал') || genre.includes('Русреал')) ? "\nRule: If the scenario or genre is 'Русреал', select ONLY Russian songs and artists (Russian language lyrics)." : "";

        const bulkCount = parseInt($('#moodtube-bulk-count').val(), 10) || 10;
        let prompt = `[SYSTEM NOTE: CRITICAL OVERRIDE. YOU ARE A STRICT METADATA API. 
DO NOT ROLEPLAY. DO NOT SPEAK AS THE CHARACTER. NO GREETINGS. NO CONVERSATION.
Read the chat history and output ONLY a valid JSON array containing exactly ${bulkCount} track objects.
Choose fitting tracks based on the mood and scenario. ${styleStr} ${antiRepeatStr} ${banListStr} ${rusrealRule}
Format strictly: [{"Title": "Song Name", "Artist": "Artist Name"}, ...]

Chat History:
${snippet}]`;

        console.log(`${LOG_PREFIX} --- Bulk AI Request Prompt ---\n`, prompt);

        const customEnable = localStorage.getItem('moodtube_ai_enable') === 'true';
        let customUrl = localStorage.getItem('moodtube_ai_url');
        if (customUrl && !customUrl.endsWith('/chat/completions')) {
            customUrl = customUrl.replace(/\/+$/, '') + '/chat/completions';
        }
        const customKey = localStorage.getItem('moodtube_ai_key');
        const customModel = localStorage.getItem('moodtube_ai_model') || 'gpt-3.5-turbo';

        let aiResponse;
        if (customEnable && customUrl && customKey) {
            const res = await fetch(customUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${customKey}` },
                body: JSON.stringify({
                    model: customModel,
                    messages: [{ role: 'user', content: prompt }],
                    temperature: 0.8
                })
            });
            if (!res.ok) throw new Error(`Custom AI API Error: ${res.status}`);
            aiResponse = await res.json();
        } else {
            console.log(`${LOG_PREFIX} Using SillyTavern generateRaw (Pure Mode)...`);
            aiResponse = await generateRaw({ 
                prompt: prompt, 
                systemPrompt: '' 
            });
        }

        if (!aiResponse) throw new Error("AI Timeout");
        
        let aiText = extractAIText(aiResponse);
        console.log(`${LOG_PREFIX} --- Raw Bulk Response ---\n`, aiText);

        let tracks = [];
        const blockMatch = aiText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
        if (blockMatch) {
            try { tracks = JSON.parse(blockMatch[1]); } catch(e) {}
        }
        if (!tracks || tracks.length === 0) {
            const arrayMatch = aiText.match(/\[\s*\{[\s\S]*\}\s*\]/);
            if (arrayMatch) {
                try { tracks = JSON.parse(arrayMatch[0]); } catch(e) {}
            }
        }

        if (!Array.isArray(tracks) || tracks.length === 0) {
            throw new Error("Could not parse bulk tracks array");
        }

        toastr.success(`MoodTube: Генерирую очередь из ${tracks.length} треков...`);

        for (const track of tracks) {
            const query = `${track.Title || track.title} ${track.Artist || track.artist}`;
            await searchAndPlay(query);
        }

    } catch (e) {
        console.error(`${LOG_PREFIX} Bulk AI Error:`, e);
        toastr.error(`Bulk DJ Error: ${e.message}`);
    } finally {
        isAnalysisInProgress = false;
        $('#moodtube-btn-bulk-ai').css('color', ACCENT_COLOR).removeClass('fa-spin');
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
        if ($(e.target).hasClass('moodtube-ctrl') || $(e.target).is('input') || $(e.target).closest('#moodtube-resize-handle').length || $(e.target).closest('#moodtube-queue-list').length) return;
        if (e.type === 'touchstart') e.preventDefault(); // Prevent mobile screen scrolling when dragging the widget
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
            
            
            <audio id="moodtube-audio-fallback" style="display:none;"></audio>
            
            <i class="fa-solid fa-gear moodtube-ctrl" id="moodtube-btn-settings" style="position: absolute; top: 12px; right: 40px; cursor: pointer; color: #888; font-size: 16px; z-index: 5;" title="Settings"></i>
            <i class="fa-solid fa-xmark moodtube-ctrl" id="moodtube-btn-close" style="position: absolute; top: 12px; right: 15px; cursor: pointer; color: #888; font-size: 16px; z-index: 5;" title="Close"></i>
            
            <div id="moodtube-resize-handle" style="position: absolute; bottom: 0; right: 0; width: 25px; height: 25px; cursor: nwse-resize; display: flex; justify-content: center; align-items: center; z-index: 10;">
                <i class="fa-solid fa-caret-down" style="color: rgba(255,255,255,0.2); font-size: 14px; transform: rotate(-45deg);"></i>
            </div>
        </div>
        `).appendTo('body');
        
        // --- MOODTUBE SETTINGS MODAL (Dreamweaver-style) ---
        $(`<style id="moodtube-settings-css">
#mt-settings-modal {
    display: none;
    position: fixed !important;
    top: 0 !important; left: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    height: 100dvh !important;
    background-color: rgba(10, 15, 20, 0.55) !important;
    z-index: 999999 !important;
    backdrop-filter: blur(35px);
    font-family: 'Inter', 'Segoe UI', sans-serif;
}
.mt-flex-center {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; padding: 15px; box-sizing: border-box;
}
.mt-flex-container {
    display: flex; flex-direction: column;
    width: 100%; max-width: 480px; max-height: 92dvh;
    background-color: rgba(15, 20, 25, 0.88);
    backdrop-filter: blur(45px);
    border: 1px solid rgba(141, 183, 213, 0.3);
    border-radius: 16px;
    box-shadow: 0 30px 60px rgba(0,0,0,0.9) !important;
    overflow: hidden; box-sizing: border-box;
}
.mt-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 18px 22px;
    background-color: rgba(15, 20, 25, 0.8);
    flex-shrink: 0;
    border-bottom: 1px solid rgba(141, 183, 213, 0.2);
}
.mt-header h3 { margin: 0; font-size: 1.15em; font-weight: 600; color: #E5E7EB; letter-spacing: 0.5px; }
.mt-close { cursor: pointer; font-size: 1.2em; color: #9CA3AF; transition: color 0.2s; }
.mt-close:hover { color: #fff; }
.mt-content {
    padding: 20px; overflow-y: auto; flex-grow: 1;
    scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.15) transparent;
}
.mt-content::-webkit-scrollbar { width: 6px; }
.mt-content::-webkit-scrollbar-thumb { background-color: rgba(255,255,255,0.15); border-radius: 10px; }
.mt-category {
    margin-bottom: 14px; border-radius: 12px; overflow: hidden;
    background-color: rgba(30,30,36,0.5);
    border: 1px solid rgba(141, 183, 213, 0.1);
}
.mt-category:last-child { margin-bottom: 0; }
.mt-cat-title {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 16px; cursor: pointer; user-select: none;
    transition: background-color 0.2s;
}
.mt-cat-title:hover { background-color: rgba(255,255,255,0.04); }
.mt-cat-title i:first-child { font-size: 1em; width: 20px; text-align: center; color: ${ACCENT_COLOR} !important; }
.mt-cat-title h4 {
    margin: 0; font-size: 0.88em; font-weight: 500;
    text-transform: uppercase; letter-spacing: 1px; flex-grow: 1; color: #D1D5DB;
}
.mt-chevron { color: #8c93a1; font-size: 0.75em; transition: transform 0.3s ease; }
.mt-chevron.open { transform: rotate(180deg); }
.mt-cat-content { display: none; padding: 10px 14px 14px 14px; box-sizing: border-box; }
.mt-cat-content.open { display: block; }
.mt-tag {
    display: inline-block; padding: 7px 13px; margin: 0 5px 7px 0;
    background-color: rgba(45,45,50,0.8);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
    cursor: pointer; user-select: none;
    font-size: 0.82em; font-weight: 500; color: #D1D5DB;
    transition: all 0.2s ease;
    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
}

.mt-tag:active { transform: scale(0.96); }
/* Genre tags */
.mt-genre-tag:hover { border-color: ${ACCENT_COLOR}; color: #fff; background-color: rgba(141, 183, 213, 0.15); }
.mt-genre-tag.active { background-color: ${ACCENT_COLOR}; color: #111827; border-color: ${ACCENT_COLOR}; font-weight: 600; box-shadow: 0 0 10px rgba(141, 183, 213, 0.3); }
/* Mood tags */
.mt-mood-tag:hover { border-color: ${ACCENT_COLOR}; color: #fff; background-color: rgba(141, 183, 213, 0.15); }
.mt-mood-tag.active { background-color: ${ACCENT_COLOR}; color: #111827; border-color: ${ACCENT_COLOR}; font-weight: 600; box-shadow: 0 0 10px rgba(141, 183, 213, 0.3); }
/* Scenario tags */
.mt-scenario-tag:hover { border-color: ${ACCENT_COLOR}; color: #fff; background-color: rgba(141, 183, 213, 0.15); }
.mt-scenario-tag.active { background-color: ${ACCENT_COLOR}; color: #111827; border-color: ${ACCENT_COLOR}; font-weight: 600; box-shadow: 0 0 10px rgba(141, 183, 213, 0.3); }
/* API section */
.mt-input-field {
    background: rgba(20,20,25,0.6); border: 1px solid rgba(255,255,255,0.15);
    border-radius: 8px; color: #E5E7EB; padding: 10px 12px;
    font-size: 0.85em; outline: none; transition: 0.2s;
    width: 100%; box-sizing: border-box; font-family: inherit;
}
.mt-input-field:focus { border-color: ${ACCENT_COLOR}; background: rgba(30,30,36,0.8); }
.mt-input-field::placeholder { color: #6B7280; }
.mt-label { display: block; font-size: 0.82em; color: #9CA3AF; margin-bottom: 6px; margin-top: 10px; }
.mt-label:first-child { margin-top: 0; }
.mt-footer {
    padding: 14px 22px;
    background-color: rgba(15, 20, 25, 0.85);
    border-top: 1px solid rgba(141, 183, 213, 0.1);
    flex-shrink: 0;
}
.mt-footer-tags {
    display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px;
    font-size: 0.8em; min-height: 20px;
}
.mt-summary-tag {
    padding: 4px 10px; border-radius: 6px; font-weight: 600; font-size: 0.85em;
    box-shadow: 0 2px 4px rgba(0,0,0,0.3); cursor: pointer;
    transition: opacity 0.2s, transform 0.1s;
}
.mt-summary-tag:hover { opacity: 0.7; transform: scale(0.95); }
.mt-sum-genre { background-color: ${ACCENT_COLOR}; color: #111827; }
.mt-sum-mood { background-color: ${ACCENT_COLOR}; color: #111827; }
.mt-sum-scenario { background-color: ${ACCENT_COLOR}; color: #111827; }
.mt-btn-save {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    background: ${ACCENT_COLOR}; color: #000; font-weight: 600;
    font-size: 0.95em; cursor: pointer; transition: 0.2s; letter-spacing: 0.5px;
}
.mt-btn-save:hover { filter: brightness(1.15); }
.mt-btn-test {
    width: 100%; padding: 10px; margin-top: 8px;
    background: rgba(255,255,255,0.07); color: #E5E7EB;
    border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
    cursor: pointer; font-weight: 500; font-size: 0.85em; transition: 0.2s;
}
.mt-btn-test:hover { background: rgba(255,255,255,0.12); border-color: ${ACCENT_COLOR}; }
.mt-checkbox-row {
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    padding: 4px 0; font-size: 0.9em; color: #D1D5DB;
}
.mt-checkbox-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: ${ACCENT_COLOR}; }
@media (max-width: 600px) {
    .mt-flex-container { max-width: 100% !important; max-height: 100dvh !important; border-radius: 0 !important; border: none !important; }
    .mt-flex-center { padding: 0 !important; }
}
</style>`).appendTo('head');

        $(`
        <div id="mt-settings-modal">
            <div class="mt-flex-center">
                <div class="mt-flex-container">
                    <div class="mt-header">
                        <h3><i class="fa-solid fa-sliders" style="margin-right:8px; color:${ACCENT_COLOR};"></i>MoodTube</h3>
                        <div style="display:flex; align-items:center; gap:15px;">
                            <div style="display:flex; align-items:center; gap:5px;" title="Количество треков для генерации">
                                <div id="moodtube-btn-bulk-ai" class="moodtube-ctrl" style="display:flex; align-items:center; cursor:pointer; color: ${ACCENT_COLOR}; transition: 0.3s;">
                                    <i class="fa-solid fa-wand-magic-sparkles" style="font-size: 14px;"></i>
                                    <i class="fa-solid fa-wand-magic-sparkles" style="font-size: 14px; margin-left:-5px; margin-top:5px;"></i>
                                </div>
                                <input type="number" id="moodtube-bulk-count" value="10" min="1" max="30" style="width: 36px; background: rgba(0,0,0,0.4); border: 1px solid rgba(141, 183, 213, 0.4); color: #fff; border-radius: 4px; text-align: center; font-size: 12px; outline: none;" class="moodtube-ctrl">
                            </div>
                            <span class="mt-close" id="mt-close-settings">&#10006;</span>
                        </div>
                    </div>
                    <div class="mt-content">

                        <!-- API -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="api">
                                <i class="fa-solid fa-plug"></i>
                                <h4>API Настройки</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-api">
                                <label class="mt-checkbox-row">
                                    <input type="checkbox" id="moodtube-setting-enable">
                                    <span>Использовать внешний ИИ API</span>
                                </label>
                                <span class="mt-label">OpenAI-совместимый URL (автоматически добавим /chat/completions)</span>
                                <input type="text" id="moodtube-setting-url" class="mt-input-field" placeholder="Например: http://127.0.0.1:5000/v1">
                                <span class="mt-label">API Key</span>
                                <input type="password" id="moodtube-setting-key" class="mt-input-field">
                                <span class="mt-label">Модель</span>
                                <input type="text" id="moodtube-setting-model" class="mt-input-field">
                                <button id="moodtube-btn-test-settings" class="mt-btn-test">Проверить соединение</button>
                            </div>
                        </div>

                        <!-- Р–РђРќР  -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="genre">
                                <i class="fa-solid fa-music"></i>
                                <h4>Жанр</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-genre">
                                <div class="mt-tag mt-genre-tag">Rock</div>
                                <div class="mt-tag mt-genre-tag">Pop</div>
                                <div class="mt-tag mt-genre-tag">Hip-Hop</div>
                                <div class="mt-tag mt-genre-tag">R&B</div>
                                <div class="mt-tag mt-genre-tag">Jazz</div>
                                <div class="mt-tag mt-genre-tag">Blues</div>
                                <div class="mt-tag mt-genre-tag">Classical</div>
                                <div class="mt-tag mt-genre-tag">Electronic</div>
                                <div class="mt-tag mt-genre-tag">Lo-Fi</div>
                                <div class="mt-tag mt-genre-tag">Synthwave</div>
                                <div class="mt-tag mt-genre-tag">Cyberpunk</div>
                                <div class="mt-tag mt-genre-tag">Metal</div>
                                <div class="mt-tag mt-genre-tag">Punk</div>
                                <div class="mt-tag mt-genre-tag">Indie</div>
                                <div class="mt-tag mt-genre-tag">Folk</div>
                                <div class="mt-tag mt-genre-tag">Country</div>
                                <div class="mt-tag mt-genre-tag">Reggae</div>
                                <div class="mt-tag mt-genre-tag">Soul</div>
                                <div class="mt-tag mt-genre-tag">Funk</div>
                                <div class="mt-tag mt-genre-tag">Ambient</div>
                                <div class="mt-tag mt-genre-tag">Orchestral</div>
                                <div class="mt-tag mt-genre-tag">Cinematic</div>
                                <div class="mt-tag mt-genre-tag">K-Pop</div>
                                <div class="mt-tag mt-genre-tag">J-Pop</div>
                                <div class="mt-tag mt-genre-tag">Anime OST</div>
                                <div class="mt-tag mt-genre-tag">Game OST</div>
                                <div class="mt-tag mt-genre-tag">Phonk</div>
                                <div class="mt-tag mt-genre-tag">Drum & Bass</div>
                                <div class="mt-tag mt-genre-tag">House</div>
                                <div class="mt-tag mt-genre-tag">Techno</div>
                                <div class="mt-tag mt-genre-tag">Trance</div>
                                <span class="mt-label" style="display:block; width:100%; margin-top:10px;">Свои жанры (через запятую)</span>
                                <input type="text" id="mt-genre-custom" class="mt-input-field">
                            </div>
                        </div>

                        <!-- РќРђРЎРўР РћР•РќРР• / MOOD -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="mood">
                                <i class="fa-solid fa-heart-pulse"></i>
                                <h4>Настроение</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-mood">
                                <div class="mt-tag mt-mood-tag">Грустное</div>
                                <div class="mt-tag mt-mood-tag">Весёлое</div>
                                <div class="mt-tag mt-mood-tag">Романтичное</div>
                                <div class="mt-tag mt-mood-tag">Агрессивное</div>
                                <div class="mt-tag mt-mood-tag">Спокойное</div>
                                <div class="mt-tag mt-mood-tag">Меланхоличное</div>
                                <div class="mt-tag mt-mood-tag">Эпичное</div>
                                <div class="mt-tag mt-mood-tag">Мрачное</div>
                                <div class="mt-tag mt-mood-tag">Мечтательное</div>
                                <div class="mt-tag mt-mood-tag">Напряжённое</div>
                                <div class="mt-tag mt-mood-tag">Ностальгичное</div>
                                <div class="mt-tag mt-mood-tag">Мотивирующее</div>
                                <div class="mt-tag mt-mood-tag">Загадочное</div>
                                <div class="mt-tag mt-mood-tag">Жуткое</div>
                                <div class="mt-tag mt-mood-tag">Нежное</div>
                            </div>
                        </div>

                        <!-- РЎР¦Р•РќРђР РР™ -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="scenario">
                                <i class="fa-solid fa-clapperboard"></i>
                                <h4>Сценарий</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-scenario">
                                <div class="mt-tag mt-scenario-tag">Русреал</div>
                                <div class="mt-tag mt-scenario-tag">Драма</div>
                                <div class="mt-tag mt-scenario-tag">Экшн</div>
                                <div class="mt-tag mt-scenario-tag">Романтика</div>
                                <div class="mt-tag mt-scenario-tag">Хоррор</div>
                                <div class="mt-tag mt-scenario-tag">Комедия</div>
                                <div class="mt-tag mt-scenario-tag">Детектив</div>
                                <div class="mt-tag mt-scenario-tag">Фэнтези</div>
                                <div class="mt-tag mt-scenario-tag">Sci-Fi</div>
                                <div class="mt-tag mt-scenario-tag">Таверна</div>
                                <div class="mt-tag mt-scenario-tag">Бой</div>
                                <div class="mt-tag mt-scenario-tag">Погоня</div>
                                <div class="mt-tag mt-scenario-tag">Босс-файт</div>
                                <div class="mt-tag mt-scenario-tag">Путешествие</div>
                                <div class="mt-tag mt-scenario-tag">Ночь у костра</div>
                                <div class="mt-tag mt-scenario-tag">Бал</div>
                                <div class="mt-tag mt-scenario-tag">Тренировка</div>
                                <div class="mt-tag mt-scenario-tag">Исследование</div>
                                <div class="mt-tag mt-scenario-tag">Отдых</div>
                                <span class="mt-label" style="display:block; width:100%; margin-top:10px;">Свои сценарии (через запятую)</span>
                                <input type="text" id="mt-scenario-custom" class="mt-input-field">
                            </div>
                        </div>

                        <!-- Р‘РђРќ-Р›РРЎРў -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="banlist">
                                <i class="fa-solid fa-ban"></i>
                                <h4>Бан-лист (Исключения)</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-banlist">
                                <span class="mt-label" style="margin-top:0;">Песни (добавляются кнопкой дизлайка)</span>
                                <input type="text" id="moodtube-setting-banned-songs" class="mt-input-field">
                                <span class="mt-label">Артисты, которых ИИ НЕ будет подбирать</span>
                                <input type="text" id="moodtube-setting-banlist" class="mt-input-field">
                            </div>
                        </div>

                        <!-- РљРђРЎРўРћРњ / РЎР’РћР РўР•Р“Р -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="custom">
                                <i class="fa-solid fa-pen-nib"></i>
                                <h4>Кастом / Свои Теги</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-custom">
                                <span class="mt-label" style="margin-top:0;">Свои жанры (через запятую)</span>
                                <input type="text" id="mt-genre-custom-2" class="mt-input-field mt-sync-genre">
                                <span class="mt-label">Свои сценарии / настроение (через запятую)</span>
                                <input type="text" id="mt-scenario-custom-2" class="mt-input-field mt-sync-scenario">
                                
                                <hr style="border:0; border-top:1px solid rgba(255,255,255,0.05); margin:15px 0;">
                                
                                <span class="mt-label" style="margin-top:0; color:#ccc;">Кастомный промпт (заменяет стандартный)</span>
                                <span class="mt-label" style="margin-top:4px; font-size:0.78em;">Макросы: <b>{{snippet}}</b> — история чата, <b>{{history}}</b> — проигранные треки</span>
                                <textarea id="moodtube-setting-custom" class="mt-input-field" style="resize:vertical; min-height:100px; margin-top:8px;"></textarea>
                            </div>
                        </div>

                    </div>

                    <div class="mt-footer">
                        <div class="mt-footer-tags" id="mt-selected-summary"></div>
                        <button class="mt-btn-save" id="moodtube-btn-save-settings">Сохранить</button>
                    </div>
                </div>
            </div>
        </div>
        `).appendTo('body');


        // Sync custom inputs
        $(document).on('input', '.mt-sync-genre', function() {
            $('#mt-genre-custom, #mt-genre-custom-2').val($(this).val());
        });
        $(document).on('input', '.mt-sync-scenario', function() {
            $('#mt-scenario-custom, #mt-scenario-custom-2').val($(this).val());
        });



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
        
        // --- Settings modal: accordion toggle ---
        $(document).on('click', '.mt-cat-title', function() {
            const catName = $(this).data('mt-cat');
            const content = $(`#mt-cat-${catName}`);
            const chevron = $(this).find('.mt-chevron');
            content.toggleClass('open');
            chevron.toggleClass('open');
        });

        // --- Settings modal: tag toggle ---
        $(document).on('click', '.mt-tag', function() {
            $(this).toggleClass('active');
            mtUpdateSummary();
        });

        // --- Summary footer update ---
        function mtUpdateSummary() {
            const $summary = $('#mt-selected-summary');
            $summary.empty();
            $('#mt-cat-genre .mt-tag.active').each(function() {
                $summary.append(`<span class="mt-summary-tag mt-sum-genre" data-tag="${$(this).text()}">${$(this).text()}</span>`);
            });
            $('#mt-cat-mood .mt-tag.active').each(function() {
                $summary.append(`<span class="mt-summary-tag mt-sum-mood" data-tag="${$(this).text()}">${$(this).text()}</span>`);
            });
            $('#mt-cat-scenario .mt-tag.active').each(function() {
                $summary.append(`<span class="mt-summary-tag mt-sum-scenario" data-tag="${$(this).text()}">${$(this).text()}</span>`);
            });
            if ($summary.children().length === 0) {
                $summary.html('<span style="color:#6B7280; font-size:0.85em;">Теги не выбраны</span>');
            }
        }

        // --- Click summary tag to deselect ---
        $(document).on('click', '.mt-summary-tag', function() {
            const tagText = $(this).data('tag');
            $('.mt-tag').filter(function() { return $(this).text() === tagText; }).removeClass('active');
            mtUpdateSummary();
        });

        // --- Open settings ---
        $('#moodtube-btn-settings').on('click', () => {
            $('#mt-settings-modal').css('display', 'block');

            // Load plain inputs
            $('#moodtube-setting-enable').prop('checked', localStorage.getItem('moodtube_ai_enable') === 'true');
            $('#moodtube-setting-url').val(localStorage.getItem('moodtube_ai_url') || '');
            $('#moodtube-setting-key').val(localStorage.getItem('moodtube_ai_key') || '');
            $('#moodtube-setting-model').val(localStorage.getItem('moodtube_ai_model') || '');
            $('#moodtube-setting-banned-songs').val(localStorage.getItem('moodtube_ai_banned_songs') || '');
            $('#moodtube-setting-banlist').val(localStorage.getItem('moodtube_ai_banlist') || '');
            $('#moodtube-setting-custom').val(localStorage.getItem('moodtube_ai_custom') || '');

            // Restore active tags from localStorage
            const savedGenres = (localStorage.getItem('moodtube_ai_genre') || '').split(',').map(s => s.trim()).filter(Boolean);
            const savedScenario = (localStorage.getItem('moodtube_ai_scenario') || '').split(',').map(s => s.trim()).filter(Boolean);

            // Clear all tag states first
            $('.mt-tag').removeClass('active');
            $('#mt-genre-custom').val('');
            $('#mt-scenario-custom').val('');

            // Activate tags that match, collect unmatched for custom field
            const unmatchedGenres = [];
            savedGenres.forEach(g => {
                const $tag = $('#mt-cat-genre .mt-genre-tag').filter(function() { return $(this).text() === g; });
                if ($tag.length) $tag.addClass('active');
                else unmatchedGenres.push(g);
            });
            if (unmatchedGenres.length) {
                const val = unmatchedGenres.join(', ');
                $('#mt-genre-custom').val(val);
                $('#mt-genre-custom-2').val(val);
            }

            const unmatchedScenarios = [];
            savedScenario.forEach(s => {
                // Check mood tags first
                let $tag = $('#mt-cat-mood .mt-mood-tag').filter(function() { return $(this).text() === s; });
                if ($tag.length) { $tag.addClass('active'); return; }
                // Then scenario tags
                $tag = $('#mt-cat-scenario .mt-scenario-tag').filter(function() { return $(this).text() === s; });
                if ($tag.length) $tag.addClass('active');
                else unmatchedScenarios.push(s);
            });
            if (unmatchedScenarios.length) {
                const val = unmatchedScenarios.join(', ');
                $('#mt-scenario-custom').val(val);
                $('#mt-scenario-custom-2').val(val);
            }

            mtUpdateSummary();
        });

        // --- Close settings ---
        $('#mt-close-settings').on('click', () => {
            $('#mt-settings-modal').hide();
        });

        // --- Save settings ---
        $('#moodtube-btn-save-settings').on('click', () => {
            localStorage.setItem('moodtube_ai_enable', $('#moodtube-setting-enable').is(':checked') ? 'true' : 'false');
            localStorage.setItem('moodtube_ai_url', $('#moodtube-setting-url').val().trim());
            localStorage.setItem('moodtube_ai_key', $('#moodtube-setting-key').val().trim());
            localStorage.setItem('moodtube_ai_model', $('#moodtube-setting-model').val().trim());

            // Collect genres: active tags + custom input
            const genreTags = [];
            $('#mt-cat-genre .mt-genre-tag.active').each(function() { genreTags.push($(this).text()); });
            const genreCustom = $('#mt-genre-custom').val().trim();
            if (genreCustom) genreTags.push(...genreCustom.split(',').map(s => s.trim()).filter(Boolean));
            localStorage.setItem('moodtube_ai_genre', genreTags.join(', '));

            // Collect scenario: mood tags + scenario tags + custom input
            const scenarioTags = [];
            $('#mt-cat-mood .mt-mood-tag.active').each(function() { scenarioTags.push($(this).text()); });
            $('#mt-cat-scenario .mt-scenario-tag.active').each(function() { scenarioTags.push($(this).text()); });
            const scenarioCustom = $('#mt-scenario-custom').val().trim();
            if (scenarioCustom) scenarioTags.push(...scenarioCustom.split(',').map(s => s.trim()).filter(Boolean));
            localStorage.setItem('moodtube_ai_scenario', scenarioTags.join(', '));

            localStorage.setItem('moodtube_ai_banlist', $('#moodtube-setting-banlist').val().trim());
            localStorage.setItem('moodtube_ai_banned_songs', $('#moodtube-setting-banned-songs').val().trim());
            localStorage.setItem('moodtube_ai_custom', $('#moodtube-setting-custom').val().trim());

            toastr.success("Настройки MoodTube сохранены");
            $('#mt-settings-modal').hide();
        });

        $('#moodtube-btn-test-settings').on('click', async () => {
            let url = $('#moodtube-setting-url').val().trim();
            const key = $('#moodtube-setting-key').val().trim();
            const model = $('#moodtube-setting-model').val().trim();
            
            if (!url || !key) {
                toastr.warning("Введите URL и API Key");
                return;
            }
            
            if (!url.endsWith('/chat/completions')) {
                url = url.replace(/\/+$/, '') + '/chat/completions';
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
                    toastr.success("Соединение успешно!");
                } else {
                    const err = await res.json().catch(() => ({error: {message: "Unknown error"}}));
                    toastr.error(`Ошибка: ${res.status} - ${err.error?.message || 'Check console'}`);
                }
            } catch (e) {
                console.error(e);
                toastr.error(`Ошибка сети: ${e.message}`);
            } finally {
                $('#moodtube-btn-test-settings').text(oldText).prop('disabled', false);
            }
        });
        
        $('#moodtube-btn-close').on('click', () => {
            isPlayerFolded = true;
            updatePlayerVisibility();
        });
        
        $('#moodtube-btn-ai').on('click', async () => { await triggerMoodAnalysisAndPlay(); });
        $('#moodtube-btn-bulk-ai').on('click', async () => { await triggerBulkMoodAnalysisAndPlay(); });

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
                const track = trackQueue[currentQueueIndex];
                if (track) handleBlockedVideo(track, currentQueueIndex);
                else playNextInQueue();
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
