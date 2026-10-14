

import { getContext } from '../../../extensions.js';
import { generateRaw, eventSource, event_types } from '../../../../script.js';

if (!localStorage.getItem('moodtube_spotify_scopes_v3')) {
    localStorage.removeItem('moodtube_spotify_token');
    localStorage.setItem('moodtube_spotify_scopes_v3', 'true');
    console.log("[MoodTube] Old Spotify token cleared to apply new scopes.");
}

const extensionName = "MoodTube";
const LOG_PREFIX = "[MoodTube]";

// --- ПАЛИТРА ---
const ACCENT_COLOR = 'var(--mt-accent)'; 
const BG_COLOR = 'var(--mt-bg-primary)'; 
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

let ytTesterPlayer = null;
let ytTesterReady = false;
let testerResolve = null;
let testerTimeoutId = null;

function testVideoPlayable(videoId) {
    return new Promise(async (resolve) => {
        console.log(`${LOG_PREFIX} [Tester] Starting test for videoId: ${videoId}`);
        
        // Ждем, пока тестер будет готов (до 4 секунд)
        for(let i=0; i<20; i++) { 
            if(ytTesterReady && ytTesterPlayer && typeof ytTesterPlayer.loadVideoById === 'function') break; 
            await new Promise(r=>setTimeout(r, 200)); 
        }
        
        // Если тестер так и не загрузился, считаем видео рабочим (чтобы не стопорить очередь)
        if (!ytTesterReady || !ytTesterPlayer || typeof ytTesterPlayer.loadVideoById !== 'function') {
            console.warn(`${LOG_PREFIX} [Tester] ytTesterPlayer not ready, assuming playable.`);
            resolve(true); 
            return;
        }
        
        testerResolve = resolve;
        console.log(`${LOG_PREFIX} [Tester] Calling loadVideoById(${videoId})`);
        try {
            ytTesterPlayer.loadVideoById(videoId);
        } catch(e) {
            console.error(`${LOG_PREFIX} [Tester] loadVideoById error:`, e);
            resolve(true);
            return;
        }
        
        testerTimeoutId = setTimeout(() => {
            if (testerResolve) {
                console.log(`${LOG_PREFIX} [Tester] Timeout reached (5s). Assuming playable.`);
                try { ytTesterPlayer.stopVideo(); } catch(e){}
                testerResolve(true);
                testerResolve = null;
            }
        }, 5000);
    });
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

    if ($('#moodtube-yt-tester').length === 0) {
        $('<div id="moodtube-yt-tester" style="position:fixed; width:2px; height:2px; bottom:0; right:0; opacity:0.01; pointer-events:none; z-index:-1;"></div>').appendTo('body');
    }
    
    ytTesterPlayer = new YT.Player('moodtube-yt-tester', {
        height: '1', width: '1',
        playerVars: { 'autoplay': 1, 'controls': 0, 'playsinline': 1, 'mute': 1 },
        events: {
            'onReady': (event) => { 
                try { event.target.mute(); } catch(err){}
                ytTesterReady = true; 
            },
            'onStateChange': (event) => {
                // Точно ждем состояния PLAYING (1). BUFFERING (3) может сработать до ошибки копирайта!
                if (event.data === YT.PlayerState.PLAYING) {
                    if (testerResolve) {
                        clearTimeout(testerTimeoutId);
                        try { event.target.stopVideo(); } catch(err){}
                        testerResolve(true);
                        testerResolve = null;
                    }
                }
            },
            'onError': (event) => {
                if (testerResolve) {
                    clearTimeout(testerTimeoutId);
                    testerResolve(false);
                    testerResolve = null;
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


// --- SPOTIFY API & PLAYER ---
let spotifyPlayer = null;
let spotifyDeviceId = null;
let isSpotifyReady = false;
let currentSpotifyTrackId = null;

function generateRandomString(length) {
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const values = crypto.getRandomValues(new Uint8Array(length));
    let text = '';
    for (let i = 0; i < values.length; i++) {
        text += possible[values[i] % possible.length];
    }
    return text;
}

async function sha256(plain) {
    if (!window.crypto || !window.crypto.subtle) {
        toastr.error("Браузер блокирует авторизацию (требуется HTTPS)");
        throw new Error("crypto.subtle is undefined. Requires HTTPS.");
    }
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return hash;
}

function base64encode(hash) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

async function authSpotify() {
    const clientId = $('#moodtube-spotify-client-id').val().trim();
    if (!clientId) { toastr.error("Введите Client ID"); return; }
    
    const codeVerifier = generateRandomString(64);
    const hashed = await sha256(codeVerifier);
    const codeChallenge = base64encode(hashed);
    const redirectUri = window.location.origin + '/';
    
    localStorage.setItem('moodtube_spotify_verifier', codeVerifier);
    localStorage.setItem('moodtube_spotify_client_id', clientId);
    localStorage.setItem('moodtube_spotify_redirect', redirectUri);
    
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
        scope: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state playlist-read-private playlist-read-collaborative playlist-modify-public playlist-modify-private user-library-read user-library-modify',
        show_dialog: 'true'
    });
    
    window.open(`https://accounts.spotify.com/authorize?${params.toString()}`, '_blank');
}

async function handleSpotifyCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const verifier = localStorage.getItem('moodtube_spotify_verifier');
    const clientId = localStorage.getItem('moodtube_spotify_client_id');
    const redirectUri = localStorage.getItem('moodtube_spotify_redirect') || (window.location.origin + '/');
    
    if (code && verifier && clientId) {
        const payload = new URLSearchParams({
            client_id: clientId,
            grant_type: 'authorization_code',
            redirect_uri: redirectUri,
            code_verifier: verifier,
            code: code,
        });
        
        try {
            const res = await fetch('https://accounts.spotify.com/api/token', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: payload
            });
            if (res.ok) {
                const tokenData = await res.json();
                tokenData.expires_at = Date.now() + tokenData.expires_in * 1000;
                localStorage.setItem('moodtube_spotify_token', JSON.stringify(tokenData));
                
                document.body.innerHTML = '<div style="display:flex; justify-content:center; align-items:center; height:100vh; background:#121212; color:#1DB954; font-family:sans-serif; font-size:24px;">Авторизация успешна! Можете закрыть эту вкладку.</div>';
                setTimeout(() => window.close(), 1500);
            } else {
                const errText = await res.text();
                toastr.error("Ошибка Spotify: " + errText);
                console.error("[MoodTube] Spotify auth token error:", errText);
                document.body.innerHTML = '<div style="display:flex; justify-content:center; align-items:center; height:100vh; background:#121212; color:#ff4444; font-family:sans-serif; font-size:20px; text-align:center; padding: 20px;">Ошибка Spotify: ' + errText + '<br><br>Закройте вкладку и попробуйте снова.</div>';
            }
        } catch(e) {
            console.error("[MoodTube] Spotify auth error", e);
        }
        localStorage.removeItem('moodtube_spotify_verifier');
    }
}

async function refreshSpotifyToken() {
    let tokenData = null;
    try { tokenData = JSON.parse(localStorage.getItem('moodtube_spotify_token')); } catch(e){}
    if (!tokenData || !tokenData.refresh_token) return null;
    
    if (Date.now() < tokenData.expires_at - 60000) return tokenData.access_token;
    
    const clientId = localStorage.getItem('moodtube_spotify_client_id');
    const payload = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: tokenData.refresh_token,
        client_id: clientId,
    });
    
    try {
        const res = await fetch('https://accounts.spotify.com/api/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: payload
        });
        if (res.ok) {
            const newToken = await res.json();
            if (!newToken.refresh_token) newToken.refresh_token = tokenData.refresh_token;
            newToken.expires_at = Date.now() + newToken.expires_in * 1000;
            localStorage.setItem('moodtube_spotify_token', JSON.stringify(newToken));
            return newToken.access_token;
        } else {
            console.warn("[MoodTube] Failed to refresh Spotify token");
        }
    } catch(e) { console.error("[MoodTube] Refresh token error", e); }
    return null;
}

function initSpotifyPlayer() {
    if (spotifyPlayer && isSpotifyReady) return;
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = async () => {
        const token = await refreshSpotifyToken();
        if (!token) return;

        function createAndConnectPlayer(attempt) {
            attempt = attempt || 1;
            console.log('[MoodTube] Spotify SDK: creating player, attempt ' + attempt);
            
            const player = new window.Spotify.Player({
                name: 'MoodTube Web Player',
                getOAuthToken: cb => { 
                    refreshSpotifyToken().then(t => { if(t) cb(t); });
                },
                volume: currentVolume / 100
            });

            player.addListener('ready', ({ device_id }) => {
                console.log('[MoodTube] Spotify Ready with Device ID', device_id);
                spotifyDeviceId = device_id;
                isSpotifyReady = true;
                spotifyPlayer = player;
            });

            player.addListener('not_ready', ({ device_id }) => {
                console.log('[MoodTube] Spotify Device ID has gone offline', device_id);
                isSpotifyReady = false;
                spotifyDeviceId = null;
            });

            player.addListener('initialization_error', ({ message }) => {
                console.error('[MoodTube] Spotify initialization_error:', message);
                if (attempt < 3) {
                    console.log('[MoodTube] Retrying in ' + (attempt * 2) + 's...');
                    setTimeout(() => createAndConnectPlayer(attempt + 1), attempt * 2000);
                } else {
                    toastr.error("Spotify SDK не смог инициализироваться: " + message);
                }
            });

            player.addListener('authentication_error', ({ message }) => {
                console.error('[MoodTube] Spotify authentication_error:', message);
                toastr.warning("Spotify: ошибка токена. Попробуйте переавторизоваться.");
            });

            player.addListener('account_error', ({ message }) => {
                console.error('[MoodTube] Spotify account_error:', message);
                toastr.error("Spotify: ошибка аккаунта — " + message);
            });
            
            player.addListener('player_state_changed', state => {
                if (!state) return;
                isCurrentlyPlaying = !state.paused;
                $('#moodtube-btn-playpause').attr('class', isCurrentlyPlaying ? 'fa-solid fa-pause moodtube-ctrl' : 'fa-solid fa-play moodtube-ctrl');
                
                if (state.paused && state.position === 0 && state.track_window.previous_tracks.find(x => x.id === currentSpotifyTrackId)) {
                    if (!state.track_window.current_track || state.track_window.current_track.id !== currentSpotifyTrackId) {
                        currentSpotifyTrackId = null;
                        playNextInQueue();
                    }
                } else if (state.track_window.current_track) {
                    currentSpotifyTrackId = state.track_window.current_track.id;
                }
            });

            player.connect().then(success => {
                if (success) {
                    console.log('[MoodTube] Spotify player connect() succeeded');
                    spotifyPlayer = player;
                } else {
                    console.warn('[MoodTube] Spotify player connect() returned false');
                    if (attempt < 3) {
                        console.log('[MoodTube] Retrying connect in ' + (attempt * 2) + 's...');
                        setTimeout(() => createAndConnectPlayer(attempt + 1), attempt * 2000);
                    } else {
                        toastr.error("Spotify плеер не смог подключиться после 3 попыток.");
                    }
                }
            }).catch(err => {
                console.error('[MoodTube] Spotify connect() error:', err);
                if (attempt < 3) {
                    setTimeout(() => createAndConnectPlayer(attempt + 1), attempt * 2000);
                }
            });
        }

        createAndConnectPlayer(1);
    };
}

async function searchSpotify(query) {
    const token = await refreshSpotifyToken();
    if (!token) {
        console.warn("[MoodTube] No Spotify token for search");
        return null;
    }
    const cleanQuery = query.replace(/[\[\](){}]/g, '').trim();
    try {
        const res = await fetch(`https://api.spotify.com/v1/search?q=${encodeURIComponent(cleanQuery)}&type=track&limit=1`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (data.tracks && data.tracks.items && data.tracks.items.length > 0) {
            const track = data.tracks.items[0];
            return {
                videoId: track.uri,
                spotifyId: track.id,
                title: `${track.artists[0].name} - ${track.name}`,
                videoThumbnails: track.album.images.length > 0 ? [{url: track.album.images[0].url}] : [],
                isSpotify: true
            };
        }
    } catch (e) {
        console.error("[MoodTube] Spotify search error", e);
    }
    return null;
}

let userSpotifyPlaylists = [];
let userSpotifyId = null;

async function fetchSpotifyPlaylists() {
    const token = await refreshSpotifyToken();
    if (!token) return [];
    
    let localPls = [];
    try { localPls = JSON.parse(localStorage.getItem('moodtube_local_playlists') || '[]'); } catch(e){}

    try {
        const res = await fetch(`https://api.spotify.com/v1/me/playlists?limit=50`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            userSpotifyPlaylists = data.items;
        } else {
            console.warn("[MoodTube] Spotify API blocked fetching playlists. Using local cache.");
        }
    } catch(e) { console.error(e); }
    
    try {
        const merged = [...(userSpotifyPlaylists || [])];
        for (const lp of localPls) {
            if (lp && lp.id && !merged.find(p => p && p.id === lp.id)) merged.push(lp);
        }
        return merged;
    } catch(e) {
        console.error("Merge error:", e);
        return localPls || [];
    }
}

async function fetchSpotifyUser() {
    if (userSpotifyId) return userSpotifyId;
    const token = await refreshSpotifyToken();
    if (!token) return null;
    try {
        const res = await fetch(`https://api.spotify.com/v1/me`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        if (res.ok) {
            const data = await res.json();
            userSpotifyId = data.id;
            return data.id;
        }
    } catch(e) { console.error(e); }
    return null;
}

async function showSpotifyPlaylists() {
    $('#moodtube-inner-content').hide();
    $('#moodtube-queue-container').hide();
    $('#moodtube-btn-close').hide();
    $('#moodtube-spotify-playlists-container').css('display', 'flex');
    
    const $list = $('#moodtube-playlists-list');
    $list.empty().append('<div style="text-align:center; padding:10px;"><i class="fa-solid fa-spinner fa-spin"></i> Загрузка...</div>');
    
    try {
        const playlists = await fetchSpotifyPlaylists();
        $list.empty();
        
        if (!playlists || playlists.length === 0) {
            $list.append('<div class="mt-queue-empty">Плейлисты не найдены. Создайте новый в меню трека.</div>');
            return;
        }
        
        playlists.forEach(pl => {
            if (!pl || !pl.id) return;
            const imgUrl = (pl.images && pl.images.length > 0) ? pl.images[0].url : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            const $item = $(`
                <div class="mt-queue-item mt-playlist-item">
                    <img class="mt-queue-thumb" src="${mtEscapeHtml(imgUrl)}">
                    <span class="mt-queue-title mt-playlist-title">${mtEscapeHtml(pl.name || 'Без названия')}</span>
                </div>
            `);
            $item.on('click', () => {
                playSpotifyPlaylist(`spotify:playlist:${pl.id}`, pl.name || 'Без названия');
            });
            $list.append($item);
        });
    } catch(err) {
        $list.empty().append('<div style="font-size:12px; color:#f55; text-align:center; padding:10px;">Ошибка загрузки плейлистов.</div>');
        console.error(err);
    }
}

async function playSpotifyPlaylist(uri, name) {
    const token = await refreshSpotifyToken();
    if (!token || !spotifyDeviceId) return;
    
    fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
        method: 'PUT',
        body: JSON.stringify({ context_uri: uri }),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
    }).then(() => {
        isCurrentlyPlaying = true;
        window.isSpotifyPlaylistActive = true;
        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
        toastr.success(`Включен плейлист: ${name}`);
        $('#moodtube-btn-close-playlists').trigger('click');
        $('#moodtube-widget-title').text(`Playlist: ${name}`);
    }).catch(e => { console.error(e); toastr.error("Ошибка при включении плейлиста"); });
}

function showSpotifyAddToPlaylistMenu(track) {
    if ($('#moodtube-add-playlist-modal').length === 0) {
        $(`
        <div id="moodtube-add-playlist-modal" style="display:none; position:fixed; top:0; left:0; width:100vw; height:100vh; background:rgba(0,0,0,0.6); z-index:9999999; justify-content:center; align-items:center; backdrop-filter:blur(5px);">
            <div style="background:var(--mt-bg-primary); border:1px solid var(--mt-border); border-radius:12px; width:300px; max-height:80vh; display:flex; flex-direction:column; box-shadow:0 10px 30px rgba(0,0,0,0.5);">
                <div style="padding:15px; border-bottom:1px solid var(--mt-border); display:flex; justify-content:space-between; align-items:center;">
                    <span style="font-weight:bold; color:#fff;">Добавить в плейлист</span>
                    <i class="fa-solid fa-xmark moodtube-ctrl" id="moodtube-close-add-modal" style="cursor:pointer; color:#888;"></i>
                </div>
                <div style="padding:10px; border-bottom:1px solid var(--mt-border);">
                    <button id="moodtube-btn-create-new-pl" style="width:100%; padding:8px; background:var(--mt-accent); color:#000; border:none; border-radius:5px; cursor:pointer; font-weight:bold;">+ Создать новый</button>
                </div>
                <div id="moodtube-add-playlists-list" style="flex:1; overflow-y:auto; padding:10px;">
                </div>
            </div>
        </div>
        `).appendTo('body');

        $('#moodtube-close-add-modal').on('click', () => {
            $('#moodtube-add-playlist-modal').hide();
        });

        $('#moodtube-add-playlist-modal').on('click', (e) => {
            if (e.target.id === 'moodtube-add-playlist-modal') {
                $('#moodtube-add-playlist-modal').hide();
            }
        });
    }

    const spotifyId = track.videoId.split(':')[2];
    $('#moodtube-add-playlist-modal').css('display', 'flex');
    
    $('#moodtube-create-pl-view').hide();
    $('#moodtube-add-playlists-list').show();
    $('#moodtube-btn-create-new-pl').show();
    $('#moodtube-new-pl-name').val('');
    
    const $list = $('#moodtube-add-playlists-list');
    $list.empty().append('<div style="text-align:center; padding:10px;"><i class="fa-solid fa-spinner fa-spin"></i></div>');

    fetchSpotifyPlaylists().then(playlists => {
        $list.empty();
        
        if (!playlists || playlists.length === 0) {
            $list.append('<div style="text-align:center; padding:10px; color:#888; font-size:13px;">Нет сохраненных плейлистов.</div>');
            return;
        }
        try {
            playlists.forEach(pl => {
                if (!pl || !pl.id) return;
                const $item = $(`
                    <div style="padding:10px; border-radius:5px; cursor:pointer; color:#fff; font-size:13px; margin-bottom:5px; background:rgba(255,255,255,0.05);">
                        ${pl.name || 'Без названия'}
                    </div>
                `);
                $item.on('click', async () => {
                    const token = await refreshSpotifyToken();
                    if (token) {
                        try {
                            const uriParam = encodeURIComponent(track.videoId);
                            const res = await fetch(`https://api.spotify.com/v1/playlists/${pl.id}/items?uris=${uriParam}`, {
                                method: 'POST',
                                headers: { Authorization: `Bearer ${token}` }
                            });
                            if (res.ok) {
                                toastr.success(`Трек добавлен в "${pl.name}"`);
                                $('#moodtube-add-playlist-modal').hide();
                            } else {
                                const err = await res.json().catch(()=>({}));
                                toastr.error("Spotify: " + (err.error?.message || "Не удалось добавить"));
                            }
                        } catch(e) { console.error(e); }
                    }
                });
                $list.append($item);
            });
        } catch(err) {
            $list.append('<div style="text-align:center; padding:10px; color:#f55; font-size:13px;">Ошибка отображения</div>');
        }
    });

    $('#moodtube-btn-create-new-pl').off('click').on('click', async () => {
        $('#moodtube-add-playlists-list').hide();
        $('#moodtube-btn-create-new-pl').hide();
        
        if ($('#moodtube-create-pl-view').length === 0) {
            $(`
            <div id="moodtube-create-pl-view" style="padding:10px; display:flex; flex-direction:column; gap:10px;">
                <input type="text" id="moodtube-new-pl-name" placeholder="Название плейлиста..." style="padding:8px 10px; border-radius:5px; border:1px solid var(--mt-border); background:var(--mt-bg-input); color:#fff; outline:none; font-family:inherit;">
                <div style="display:flex; gap:10px;">
                    <button id="moodtube-btn-cancel-create" style="flex:1; padding:8px; background:rgba(255,255,255,0.1); color:#fff; border:none; border-radius:5px; cursor:pointer;">Отмена</button>
                    <button id="moodtube-btn-confirm-create" style="flex:1; padding:8px; background:var(--mt-accent); color:#000; border:none; border-radius:5px; cursor:pointer; font-weight:bold;">Создать</button>
                </div>
            </div>
            `).insertAfter('#moodtube-add-playlists-list');
            
            $('#moodtube-btn-cancel-create').on('click', () => {
                $('#moodtube-create-pl-view').hide();
                $('#moodtube-add-playlists-list').show();
                $('#moodtube-btn-create-new-pl').show();
                $('#moodtube-new-pl-name').val('');
            });
        }
        
        $('#moodtube-create-pl-view').show();
        $('#moodtube-new-pl-name').focus();
        
        $('#moodtube-btn-confirm-create').off('click').on('click', async () => {
            const name = $('#moodtube-new-pl-name').val().trim();
            if (!name) return;
            
            const oldText = $('#moodtube-btn-confirm-create').text();
            $('#moodtube-btn-confirm-create').text('⏳').prop('disabled', true);
            
            const userId = await fetchSpotifyUser();
            if (!userId) { 
                toastr.error("Не удалось получить User ID"); 
                $('#moodtube-btn-confirm-create').text(oldText).prop('disabled', false);
                return; 
            }
            
            const token = await refreshSpotifyToken();
            if (token) {
                try {
                    const res = await fetch(`https://api.spotify.com/v1/me/playlists`, {
                        method: 'POST',
                        body: JSON.stringify({ name: name, public: false }),
                        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
                    });
                    if (res.ok) {
                        const newPl = await res.json();
                        
                        // Save to local cache
                        let localPls = [];
                        try { localPls = JSON.parse(localStorage.getItem('moodtube_local_playlists') || '[]'); } catch(e){}
                        localPls.push({ id: newPl.id, name: newPl.name });
                        localStorage.setItem('moodtube_local_playlists', JSON.stringify(localPls));
                        
                        const uriParam = encodeURIComponent(track.videoId);
                        const addRes = await fetch(`https://api.spotify.com/v1/playlists/${newPl.id}/items?uris=${uriParam}`, {
                            method: 'POST',
                            headers: { Authorization: `Bearer ${token}` }
                        });
                        if (addRes.ok) {
                            toastr.success(`Плейлист "${name}" создан и трек добавлен!`);
                            $('#moodtube-add-playlist-modal').hide();
                            $('#moodtube-btn-cancel-create').trigger('click');
                        } else {
                            const err = await addRes.json().catch(()=>({}));
                            toastr.error("Spotify: " + (err.error?.message || "Не удалось добавить трек"));
                        }
                    } else {
                        const err = await res.json().catch(()=>({}));
                        toastr.error("Spotify: " + (err.error?.message || "Ошибка создания плейлиста"));
                    }
                } catch(e) { console.error(e); toastr.error("Сетевая ошибка при создании плейлиста"); }
            }
            $('#moodtube-btn-confirm-create').text(oldText).prop('disabled', false);
        });
    });
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
// --- MP3 IndexedDB Cache ---
const MT_DB_NAME = 'MoodTubeAudioDB';
const MT_STORE_NAME = 'mp3_cache';

function openMtDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(MT_DB_NAME, 1);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(MT_STORE_NAME)) {
                db.createObjectStore(MT_STORE_NAME);
            }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

async function saveMp3ToCache(videoId, blob) {
    try {
        const db = await openMtDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(MT_STORE_NAME, 'readwrite');
            const store = tx.objectStore(MT_STORE_NAME);
            store.put(blob, videoId);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
        });
    } catch(e) { console.warn(`${LOG_PREFIX} Failed to save MP3 to DB:`, e); }
}

async function getMp3FromCache(videoId) {
    try {
        const db = await openMtDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(MT_STORE_NAME, 'readonly');
            const store = tx.objectStore(MT_STORE_NAME);
            const req = store.get(videoId);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    } catch(e) { return null; }
}

let activeObjectUrls = {};
function getMp3ObjectUrl(videoId, blob) {
    if (activeObjectUrls[videoId]) {
        URL.revokeObjectURL(activeObjectUrls[videoId]);
    }
    const url = URL.createObjectURL(blob);
    activeObjectUrls[videoId] = url;
    return url;
}

async function getNetEaseStream(query) {
    try {
        // 1. Ищем ID песни
        const searchRes = await fetchWithTimeout(`https://music-api.gdstudio.xyz/api.php?types=search&count=3&source=netease&name=${encodeURIComponent(query)}`, {}, 4000);
        if (!searchRes.ok) return null;
        const searchData = await searchRes.json();
        if (!searchData || searchData.length === 0 || !searchData[0].id) return null;

        // 2. Получаем прямую ссылку на mp3 по ID
        const urlRes = await fetchWithTimeout(`https://music-api.gdstudio.xyz/api.php?types=url&source=netease&id=${searchData[0].id}`, {}, 4000);
        if (!urlRes.ok) return null;
        const urlData = await urlRes.json();
        
        if (urlData && urlData.url && urlData.url.startsWith("http")) {
            return urlData.url;
        }
    } catch (e) {
        console.warn(`${LOG_PREFIX} NetEase bypass failed`);
    }
    return null;
}
let isMtBackgroundPrefetching = false;
async function startBackgroundPrefetch() { return; }

async function handleBlockedVideo(failedTrack, index) {
    failedTrack.fallbackDepth = (failedTrack.fallbackDepth || 0) + 1;
    if (failedTrack.isExhausted || failedTrack.fallbackDepth > 4) {
        console.warn(`${LOG_PREFIX} Bypass exhausted for:`, failedTrack.title);
        failedTrack.isExhausted = true;

        updateQueueUI();
        if (currentQueueIndex === index) playNextInQueue();
        return;
    }

    console.log(`${LOG_PREFIX} Track blocked. Attempting bypass for:`, failedTrack.title);
    
    if (failedTrack.prefetchPromise) {
        console.log(`${LOG_PREFIX} Waiting for prefetch to finish...`);
        await failedTrack.prefetchPromise;
    }
    
    let baseSearch = failedTrack.originalQuery || failedTrack.title;
    baseSearch = baseSearch.replace(/\b(official|music video|audio|hd|hq|lyrics|video)\b/gi, '').trim();

    // ШАГ 1: Китайский фоллбэк (NetEase API) - СРАЗУ ПОСЛЕ ЮТУБА
    if (!failedTrack.stepNetEaseAttempted) {
        failedTrack.stepNetEaseAttempted = true;
        if (currentQueueIndex === index) $('#moodtube-widget-title').text('Обход (1/3): NetEase API...');
        
        console.log(`${LOG_PREFIX} Attempting NetEase API bypass for:`, baseSearch);
        const netEaseUrl = await getNetEaseStream(baseSearch);
        
        if (netEaseUrl) {
            console.log(`${LOG_PREFIX} NetEase proxy stream found!`);
            failedTrack.isFallback = true;
            failedTrack.streamUrl = netEaseUrl; 
            playAudioStream(failedTrack, netEaseUrl, index);
            return;
        }
    }

    // ШАГ 2: Direct Stream (Piped / Invidious)
    if (!failedTrack.step1Attempted) {
        failedTrack.step1Attempted = true;
        
        let streamUrl = failedTrack.streamUrl;
        if (!streamUrl) {
            if (currentQueueIndex === index) $('#moodtube-widget-title').text('Обход (2/3): Прямой поток...');
            streamUrl = await getPipedStream(failedTrack.videoId);
            if (!streamUrl) streamUrl = await getInvidiousStream(failedTrack.videoId);
        }
        
        if (streamUrl) {
            console.log(`${LOG_PREFIX} Direct stream found.`);
            failedTrack.isFallback = true;
            failedTrack.streamUrl = streamUrl; 
            playAudioStream(failedTrack, streamUrl, index);
            return;
        }
    }

    // ШАГ 3: Поиск ремиксов/каверов
    if (!failedTrack.step3Attempted) {
        failedTrack.step3Attempted = true;
        if (currentQueueIndex === index) $('#moodtube-widget-title').text('Обход (3/3): Поиск замены...');
        
        let fallbackInfo = failedTrack.fallbackInfo;
        if (!fallbackInfo) {
            const queries = ["remix", "cover", "live", "nightcore"];
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

    updateQueueUI();
    if (currentQueueIndex === index) {
        $('#moodtube-widget-title').text(failedTrack.title);
        setTimeout(() => playNextInQueue(), 150);
    }
}

function playAudioStream(track, streamUrl, index) {
    if (currentQueueIndex !== index) return;
    
    console.log(`${LOG_PREFIX} Bypassing YouTube iframe with direct stream.`);
    
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        try { ytPlayer.stopVideo(); } catch(e) {}
    }
    if (audioFallback) {
        try { audioFallback.pause(); audioFallback.removeAttribute('src'); audioFallback.load(); } catch(e) {}
    }

    isUsingAudioFallback = true;
    isCurrentlyPlaying = true;
    $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
    
    if (track.title.includes("Обход: ") || track.title.includes("Ожидание")) {
        track.title = track.originalQuery || track.title.replace(/.*Обход: |.*Ожидание/gi, '').trim();
    }
    $('#moodtube-widget-title').text(track.title);
    
    // Сбрасываем и устанавливаем обложку (из поиска или дефолт)
    setImgWithFallback(document.getElementById('moodtube-widget-cover'), getTrackThumbCandidates(track));
    
    updateQueueUI();
    
    audioFallback.src = streamUrl;
    audioFallback.volume = currentVolume / 100;
    audioFallback.play().catch(e => {
        console.error(`${LOG_PREFIX} Audio playback failed`, e);
        track.stepNetEaseAttempted = false;
        track.step1Attempted = false;
        track.step3Attempted = false;
        track.streamUrl = null;
        handleBlockedVideo(track, index);
    });
    
    // Сбрасываем иконку сердечка
    $('#moodtube-btn-favorite').removeClass('fa-solid').addClass('fa-regular');
}

async function playTrack(videoInfo) {
    if (!videoInfo || (!videoInfo.videoId && !videoInfo.streamUrl)) return;

    window.dispatchEvent(new CustomEvent('moodtube:trackchange', {
        detail: { title: videoInfo.title, videoId: videoInfo.videoId }
    }));

    // Check if we have a cached Blob first!
    if (videoInfo.videoId && !videoInfo.streamUrl) {
        const cachedBlob = await getMp3FromCache(videoInfo.videoId);
        if (cachedBlob) {
            console.log(`${LOG_PREFIX} Playing from IndexedDB Cache!`);
            videoInfo.isFallback = true;
            videoInfo.streamUrl = getMp3ObjectUrl(videoInfo.videoId, cachedBlob);
        }
    }

    // Explicitly stop any playing media to prevent overlapping
    if (typeof spotifyPlayer !== 'undefined' && spotifyPlayer && isSpotifyReady) {
        try { spotifyPlayer.pause(); } catch(e) {}
    }
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
        try { ytPlayer.stopVideo(); } catch(e) {}
    }
    if (audioFallback) { 
        try { audioFallback.pause(); audioFallback.removeAttribute('src'); audioFallback.load(); } catch(e) {} 
        isUsingAudioFallback = false; 
    }
    isCurrentlyPlaying = false;

    if (sessionPlayedTracks[sessionPlayedTracks.length - 1] !== videoInfo.title) {
        sessionPlayedTracks.push(videoInfo.title);
    }
    
    if (videoInfo.proactivelyBlocked || videoInfo.isFallback || videoInfo.streamUrl || videoInfo.fallbackInfo) {
        if (videoInfo.streamUrl) {
            updateQueueUI();
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
    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';

    if (source === 'spotify' && videoInfo.videoId && videoInfo.videoId.startsWith('spotify:track:')) {
        $('#moodtube-widget-title').text(videoInfo.title || 'Spotify Track');
        const thumbUrl = (videoInfo.videoThumbnails && videoInfo.videoThumbnails.length > 0) ? videoInfo.videoThumbnails[0].url : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        $('#moodtube-widget-cover').attr('src', thumbUrl);
        
        currentSpotifyTrackId = null; // Предотвращаем ложное срабатывание авто-скипа старого трека
        window.isSpotifyPlaylistActive = false;
        
        refreshSpotifyToken().then(token => {
            if (token && spotifyDeviceId) {
                fetch(`https://api.spotify.com/v1/me/player/play?device_id=${spotifyDeviceId}`, {
                    method: 'PUT',
                    body: JSON.stringify({ uris: [videoInfo.videoId] }),
                    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
                }).then(res => {
                    if (res.ok) {
                        isCurrentlyPlaying = true;
                        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
                    } else {
                        res.json().then(data => toastr.error("Spotify: " + (data.error?.message || "Ошибка API"))).catch(()=>{});
                    }
                }).catch(e => console.error(e));
            } else {
                toastr.error("Spotify плеер не готов!");
                playNextInQueue();
            }
        });
        updateQueueUI();
        
        // Сбрасываем иконку сердечка
        $('#moodtube-btn-favorite').removeClass('fa-solid').addClass('fa-regular');
        return;
    }

    $('#moodtube-widget-title').text(videoInfo.title || 'YouTube Track');
    
    // Подтягиваем картинку и сбрасываем старую для избежания "залипания"
    $('#moodtube-widget-cover').attr('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
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
    
    // Сбрасываем иконку сердечка
    $('#moodtube-btn-favorite').removeClass('fa-solid').addClass('fa-regular');
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
    
    try {
        for (let i = 0; i < trackQueue.length; i++) {
            let track = trackQueue[i];
            if (!track.videoId && track.originalQuery && !track.searchFailed) {
                const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
                let videoInfo = null;
                if (source === 'spotify') {
                    videoInfo = await searchSpotify(track.originalQuery);
                    if (!videoInfo) videoInfo = await searchYouTube(track.originalQuery); // fallback
                } else {
                    videoInfo = await searchYouTube(track.originalQuery);
                }
                if (videoInfo && videoInfo.videoId) {
                    track.videoId = videoInfo.videoId;
                    track.title = videoInfo.title;
                    track.videoThumbnails = videoInfo.videoThumbnails;
                    delete track.isSearching;
                    
                    updateQueueUI();
                    
                    // Если это первый трек, пускаем сразу в главный плеер
                    if (currentQueueIndex === i && (!isCurrentlyPlaying || (ytPlayer && ytPlayer.getPlayerState() === YT.PlayerState.ENDED))) {
                        track.isValidated = true; // Считаем валидным, если сразу пускаем, ошибки поймает главный плеер
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
                // Небольшая пауза между поисками
                await new Promise(r => setTimeout(r, 400));
            }
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Background search error:`, e);
    } finally {
        isResolvingQueue = false;
        // Запускаем фоновый тестер
        startBackgroundTester();
    }
}

let isTestingQueue = false;
async function startBackgroundTester() {
    if (isTestingQueue) return;
    isTestingQueue = true;

    try {
        for (let i = 0; i < trackQueue.length; i++) {
            let track = trackQueue[i];
            // Проверяем только те, что уже найдены (есть videoId), но еще не валидировались и не зафейлились
            if (track.videoId && !track.isValidated && !track.searchFailed && !track.proactivelyBlocked && !track.isFallback) {
                
                // Пропускаем тест, если это трек, который УЖЕ играет
                if (currentQueueIndex === i) {
                    track.isValidated = true;
                    continue;
                }
                
                // Пропускаем тест для Spotify треков (у них нет YouTube ID)
                if (track.videoId.startsWith('spotify:')) {
                    track.isValidated = true;
                    continue;
                }

                track.title = "⏳ " + track.title;
                updateQueueUI();
                
                const isPlayable = await testVideoPlayable(track.videoId);
                
                if (isPlayable) {
                    track.title = track.title.replace("⏳ ", "");
                    track.isValidated = true;
                    updateQueueUI();
                } else {
                    track.title = track.title.replace("⏳ ", "⚠️ Обход: ");
                    updateQueueUI();
                    
                    let baseSearch = track.originalQuery || track.title;
                    baseSearch = baseSearch.replace(/\b(official|music video|audio|hd|hq|lyrics|video|⚠️ Обход:|⏳)\b/gi, '').trim();

                    // ШАГ 1 (ДЛЯ ТЕСТЕРА): Сразу идем к китайцам (NetEase API)
                    console.log(`${LOG_PREFIX} [Tester] Attempting NetEase API bypass for:`, baseSearch);
                    const netEaseUrl = await getNetEaseStream(baseSearch);
                    
                    if (netEaseUrl) {
                        console.log(`${LOG_PREFIX} [Tester] NetEase proxy stream found!`);
                        track.streamUrl = netEaseUrl;
                        track.proactivelyBlocked = true;
                        track.isValidated = true;
                        track.isFallback = true;
                        track.title = track.originalQuery || baseSearch; // Возвращаем чистое название
                        updateQueueUI();
                    } else {
                        // ШАГ 2 (ДЛЯ ТЕСТЕРА): Прямые потоки Piped / Invidious
                        let streamUrl = await getPipedStream(track.videoId);
                        if (!streamUrl) streamUrl = await getInvidiousStream(track.videoId);
                        
                        if (streamUrl) {
                            track.streamUrl = streamUrl;
                            track.title = track.title.replace("⚠️ Обход: ", "");
                            track.proactivelyBlocked = true;
                            track.isValidated = true;
                            updateQueueUI();
                        } else {
                            // ШАГ 3 (ДЛЯ ТЕСТЕРА): Ищем Cover/Remix/Live
                            const queries = ["lyrics", "remix", "cover", "live"];
                            let foundFallback = false;
                            
                            for (const q of queries) {
                                let res = await searchYouTube(baseSearch + " " + q);
                                if (res && res.videoId && res.videoId !== track.videoId) {
                                    const isCoverPlayable = await testVideoPlayable(res.videoId);
                                    if (isCoverPlayable) {
                                        track.videoId = res.videoId;
                                        track.title = res.title;
                                        track.videoThumbnails = res.videoThumbnails;
                                        track.isValidated = true;
                                        track.isFallback = true;
                                        foundFallback = true;
                                        break;
                                    }
                                }
                            }
                            
                            if (foundFallback) {
                                updateQueueUI();
                            } else {
                                // Вот теперь точно всё, сдаемся
                                track.searchFailed = true;
                                track.isValidated = true;

                                updateQueueUI();
                            }
                        }
                    }
                }
            }
        }
    } catch (e) {
        console.error(`${LOG_PREFIX} Background tester error:`, e);
    } finally {
        isTestingQueue = false;
        // Если за время тестов добавились новые сырые треки, перезапустим резолвер
        if (trackQueue.some(t => !t.videoId && t.originalQuery && !t.searchFailed)) {
            setTimeout(resolveQueueBackground, 500);
        } else if (trackQueue.some(t => t.videoId && !t.isValidated && !t.searchFailed)) {
            // Или если добавились новые треки для тестов
            setTimeout(startBackgroundTester, 500);
        }
    }
}

async function searchAndPlay(query) {
    enqueueQuery(query);
    return true;
}

function getActiveChatId() {
    try {
        const ctx = getContext();
        if (!ctx) return null;
        return ctx.chatId || ctx.groupId || (ctx.characterId !== undefined ? String(ctx.characterId) : null);
    } catch { return null; }
}

let currentLoadedChatId = null;

function saveQueueCache() {
    if (!currentLoadedChatId) return;
    const chatId = getActiveChatId();
    if (!chatId || chatId !== currentLoadedChatId) return;
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem('moodtube_queue_cache') || '{}'); } catch(e){}
    const safeQueue = trackQueue.map(t => {
        let copy = { ...t };
        delete copy.prefetchPromise;
        if (copy.streamUrl && typeof copy.streamUrl === 'string' && copy.streamUrl.startsWith('blob:')) {
            copy.streamUrl = null;
        }
        return copy;
    });
    cache[chatId] = {
        queue: safeQueue,
        currentIndex: currentQueueIndex,
        playedTracks: sessionPlayedTracks
    };
    try {
        localStorage.setItem('moodtube_queue_cache', JSON.stringify(cache));
    } catch(e) {
        console.error('[MoodTube] Failed to save queue cache', e);
    }
}

function clearQueueState(skipSave = false) {
    trackQueue = [];
    currentQueueIndex = -1;
    sessionPlayedTracks = [];
    updateQueueUI(skipSave);
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
    if (typeof spotifyPlayer !== 'undefined' && spotifyPlayer) { try { spotifyPlayer.pause(); } catch(e) {} }
    isCurrentlyPlaying = false;
    $('#moodtube-widget-title').text('No Track Selected');
    $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
    $('#moodtube-widget-cover').attr('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
}

let mtInitialRestoreDone = false;

function restoreQueueCache() {
    const chatId = getActiveChatId();
    if (!chatId) {
        if (!mtInitialRestoreDone) {
            setTimeout(restoreQueueCache, 500);
            return;
        }
        currentLoadedChatId = null;
        clearQueueState(true);
        return;
    }

    if (mtInitialRestoreDone && currentLoadedChatId === chatId) {
        return;
    }

    mtInitialRestoreDone = true;
    currentLoadedChatId = chatId;
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem('moodtube_queue_cache') || '{}'); } catch(e){}
    if (cache[chatId] && cache[chatId].queue) {
        const c = cache[chatId];
        trackQueue = c.queue || [];
        trackQueue.forEach(t => {
            if (t.streamUrl && typeof t.streamUrl === 'string' && t.streamUrl.startsWith('blob:')) t.streamUrl = null;
        });
        currentQueueIndex = c.currentIndex !== undefined ? c.currentIndex : -1;
        sessionPlayedTracks = c.playedTracks || [];
        updateQueueUI(true);
        if (currentQueueIndex >= 0 && currentQueueIndex < trackQueue.length) {
            const track = trackQueue[currentQueueIndex];
            $('#moodtube-widget-title').text(track.title || 'YouTube Track');
            setImgWithFallback(document.getElementById('moodtube-widget-cover'), getTrackThumbCandidates(track));
            if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
            if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
            isCurrentlyPlaying = false;
            $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
            
            if (track.isFallback || track.streamUrl) {
                isUsingAudioFallback = true;
                if (track.streamUrl) {
                    audioFallback.src = track.streamUrl;
                    audioFallback.load();
                } else if (track.videoId) {
                    getMp3FromCache(track.videoId).then(cachedBlob => {
                        if (cachedBlob) {
                            track.streamUrl = getMp3ObjectUrl(track.videoId, cachedBlob);
                            if (currentQueueIndex >= 0 && trackQueue[currentQueueIndex] === track) {
                                audioFallback.src = track.streamUrl;
                                audioFallback.load();
                            }
                        }
                    });
                }
            } else if (track.videoId && !track.videoId.startsWith('spotify:') && ytPlayer && typeof ytPlayer.cueVideoById === 'function') {
                try { ytPlayer.cueVideoById(track.videoId); } catch(e) {}
            }
        } else {
            $('#moodtube-widget-title').text(trackQueue.length > 0 ? (currentQueueIndex >= trackQueue.length ? 'Queue finished' : 'Ready to play') : 'No Track Selected');
            $('#moodtube-widget-cover').attr('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
            if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
            if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
            isCurrentlyPlaying = false;
            $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
        }
    } else {
        clearQueueState(true);
    }
}

const MT_EMPTY_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Обложка трека: для YouTube сначала берём i.ytimg.com по videoId (прокси зеркал Piped/Invidious часто лежат),
// затем — картинки из ответа поиска. При ошибке загрузки <img> переходит к следующему варианту.
function getTrackThumbCandidates(track, size = 'mqdefault') {
    const list = [];
    if (!track) return list;
    const id = track.videoId;
    if (id && !String(id).startsWith('spotify:')) {
        list.push(`https://i.ytimg.com/vi/${id}/${size}.jpg`);
        if (size !== 'hqdefault') list.push(`https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
    }
    (track.videoThumbnails || []).forEach(t => { if (t && t.url && !list.includes(t.url)) list.push(t.url); });
    return list;
}

function setImgWithFallback(img, candidates) {
    if (!img) return;
    const queue = (candidates || []).slice();
    let current = queue.length ? queue.shift() : MT_EMPTY_IMG;
    img.onerror = () => {
        // src поменял другой код (новый трек и т.п.) — старую цепочку не продолжаем
        if (img.getAttribute('src') !== current) return;
        current = queue.length ? queue.shift() : MT_EMPTY_IMG;
        if (current === MT_EMPTY_IMG) img.onerror = null;
        img.src = current;
    };
    img.src = current;
}

function mtEscapeHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateQueueUI(skipSave = false) {
    const $qList = $('#moodtube-queue-list');
    if (!$qList.length) return;
    
    $qList.empty();
    if (trackQueue.length === 0) {
        $qList.append('<div class="mt-queue-empty">Очередь пуста</div>');
        if (!skipSave) saveQueueCache();
        return;
    }

    trackQueue.forEach((track, index) => {
        const isCurrent = index === currentQueueIndex;
        const isSpotifyTrack = track.videoId && track.videoId.startsWith('spotify:');
        const showSpotifyAdd = isSpotifyTrack && (localStorage.getItem('moodtube_playback_source') === 'spotify');
        const itemClasses = ['moodtube-queue-item', 'mt-queue-item'];
        if (isCurrent) itemClasses.push('mt-is-current');
        if (track.isExhausted) itemClasses.push('mt-is-blocked');
        if (track.isSearching) itemClasses.push('mt-is-searching');
        const $item = $(`
            <div class="${itemClasses.join(' ')}">
                <img class="mt-queue-thumb${!track.videoId ? ' mt-is-empty' : ''}" alt="">
                <span class="mt-queue-title">${track.isExhausted ? '❌ Заблокировано: ' : ''}${mtEscapeHtml(track.title)}</span>
                ${isCurrent ? '<i class="fa-solid fa-volume-high mt-queue-now"></i>' : ''}
                ${showSpotifyAdd ? '<div class="moodtube-btn-add-playlist moodtube-ctrl mt-queue-add" title="Добавить в плейлист Spotify"><i class="fa-solid fa-plus"></i></div>' : ''}
                <div class="moodtube-btn-dislike moodtube-ctrl mt-queue-dislike" title="Не нравится (В бан-лист)"></div>
            </div>
        `);
        
        setImgWithFallback($item.find('.mt-queue-thumb')[0], getTrackThumbCandidates(track, 'default'));

        $item.on('click', (e) => {
            if ($(e.target).hasClass('moodtube-btn-dislike') || $(e.target).closest('.moodtube-btn-add-playlist').length > 0) return;
            currentQueueIndex = index;
            playTrack(trackQueue[currentQueueIndex]);
        });

        $item.find('.moodtube-btn-add-playlist').on('click', (e) => {
            e.stopPropagation();
            showSpotifyAddToPlaylistMenu(track);
        });

        $item.find('.moodtube-btn-dislike').on('click', (e) => {
            e.stopPropagation();
            let currentBannedSongs = localStorage.getItem('moodtube_global_banned_songs');
            if (currentBannedSongs === null) currentBannedSongs = getMtSetting('banned_songs') || '';
            const songToBan = `${track.title} ${track.artist || track.Artist || ''}`.trim();
            if (songToBan && !currentBannedSongs.includes(songToBan)) {
                currentBannedSongs = currentBannedSongs ? currentBannedSongs + ', ' + songToBan : songToBan;
                localStorage.setItem('moodtube_global_banned_songs', currentBannedSongs);
                $('#moodtube-setting-banned-songs').val(currentBannedSongs);
                toastr.success(`Трек добавлен в глобальные исключения`);
            } else if (currentBannedSongs.includes(songToBan)) {
                toastr.info(`Трек уже в исключениях`);
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
    
    if (!skipSave) saveQueueCache();
}

// --- ВШИТЫЙ ИИ-ПРОМТ ---
function getMtSetting(key) {
    const chatId = getActiveChatId();
    if (chatId) {
        let data = {};
        try { data = JSON.parse(localStorage.getItem('moodtube_chat_data') || '{}'); } catch(e){}
        if (data[chatId] && data[chatId][key] !== undefined) return data[chatId][key];
    }
    return '';
}

function saveMtSetting(key, val) {
    const chatId = getActiveChatId();
    if (chatId) {
        let data = {};
        try { data = JSON.parse(localStorage.getItem('moodtube_chat_data') || '{}'); } catch(e){}
        if (!data[chatId]) data[chatId] = {};
        data[chatId][key] = val;
        localStorage.setItem('moodtube_chat_data', JSON.stringify(data));
    }
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-mt-theme', theme || 'blue');
    $('#mt-settings-modal').attr('data-mt-theme', theme || 'blue');
    $('#moodtube-mini-player').attr('data-mt-theme', theme || 'blue');
    const custom = theme === 'custom' ? loadCustomTheme() : null;
    applyCustomThemeCss(custom);
    applyThemeLabels(custom);
}

// --- КАСТОМНАЯ ТЕМА (CSS + переменные + картинки + подписи, импорт/экспорт JSON) ---
const MT_CUSTOM_THEME_KEY = 'moodtube_custom_theme';
const MT_THEME_VARS = [
    { key: 'accent',       css: '--mt-accent',       label: 'Акцент',          def: '#8db7d5' },
    { key: 'accent_hover', css: '--mt-accent-hover', label: 'Акцент (hover)',  def: '#a5d0f0' },
    { key: 'bg_primary',   css: '--mt-bg-primary',   label: 'Фон основной',    def: 'rgba(15,20,25,0.88)' },
    { key: 'bg_secondary', css: '--mt-bg-secondary', label: 'Фон вторичный',   def: 'rgba(22,28,35,0.88)' },
    { key: 'bg_input',     css: '--mt-bg-input',     label: 'Фон полей ввода', def: 'rgba(10,15,20,0.6)' },
    { key: 'border',       css: '--mt-border',       label: 'Рамки',           def: 'rgba(141,183,213,0.3)' },
];
// Картинки попадают в CSS-переменные --mt-img-*, которые по умолчанию рисуют слоты .mt-slot-*
const MT_THEME_IMAGES = [
    { key: 'bg',    css: '--mt-img-bg',    label: 'Фон плеера',           hint: '.mt-slot-bg — под всем содержимым' },
    { key: 'scene', css: '--mt-img-scene', label: 'Сцена',                hint: '.mt-slot-scene — над фоном, под контролами' },
    { key: 'cover_bg', css: '--mt-img-cover-bg', label: 'Под обложкой',   hint: '.mt-slot-cover-bg — сцена только в круге обложки (видна, пока нет трека или если обложка прозрачная)' },
    { key: 'cover', css: '--mt-img-cover', label: 'Поверх обложки',       hint: '.mt-slot-cover — винил/рамка поверх обложки' },
    { key: 'decor', css: '--mt-img-decor', label: 'Декор поверх плеера',  hint: '.mt-slot-decor — бантики, стикеры (клики проходят насквозь)' },
];
const MT_THEME_LABELS = [
    { key: 'header',         label: 'Заголовок плеера',     def: '',            target: '#moodtube-label-header',   hint: 'пусто — скрыт' },
    { key: 'subtitle',       label: 'Подпись под треком',   def: 'MoodTube DJ', target: '#moodtube-label-subtitle', hint: '' },
    { key: 'status_playing', label: 'Статус: играет',       def: '',            hint: 'например «now playing..»' },
    { key: 'status_paused',  label: 'Статус: пауза',        def: '',            hint: '' },
    { key: 'status_idle',    label: 'Статус: нет трека',    def: '',            hint: '' },
];
const MT_IMAGE_MAX_BYTES = 1.5 * 1024 * 1024;

function getDefaultCustomTheme() {
    const vars = {}, images = {}, labels = {};
    MT_THEME_VARS.forEach(v => vars[v.key] = v.def);
    MT_THEME_IMAGES.forEach(v => images[v.key] = '');
    MT_THEME_LABELS.forEach(v => labels[v.key] = v.def);
    return { name: 'My MoodTube Theme', vars, images, labels, custom_css: '' };
}

function normalizeCustomTheme(raw) {
    const base = getDefaultCustomTheme();
    if (!raw || typeof raw !== 'object') return base;
    const vars = { ...base.vars }, images = { ...base.images }, labels = { ...base.labels };
    if (raw.vars && typeof raw.vars === 'object') {
        MT_THEME_VARS.forEach(v => {
            if (typeof raw.vars[v.key] === 'string' && raw.vars[v.key].trim()) vars[v.key] = raw.vars[v.key].trim();
        });
    }
    if (raw.images && typeof raw.images === 'object') {
        MT_THEME_IMAGES.forEach(v => {
            if (typeof raw.images[v.key] === 'string') images[v.key] = raw.images[v.key].trim();
        });
    }
    if (raw.labels && typeof raw.labels === 'object') {
        MT_THEME_LABELS.forEach(v => {
            if (typeof raw.labels[v.key] === 'string') labels[v.key] = raw.labels[v.key];
        });
    }
    return {
        name: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : base.name,
        vars,
        images,
        labels,
        custom_css: typeof raw.custom_css === 'string' ? raw.custom_css : '',
    };
}

function loadCustomTheme() {
    try { return normalizeCustomTheme(JSON.parse(localStorage.getItem(MT_CUSTOM_THEME_KEY) || 'null')); }
    catch (e) { return getDefaultCustomTheme(); }
}

function saveCustomTheme(theme) {
    try {
        localStorage.setItem(MT_CUSTOM_THEME_KEY, JSON.stringify(normalizeCustomTheme(theme)));
        return true;
    } catch (e) {
        console.error(`${LOG_PREFIX} Custom theme save failed:`, e);
        toastr.error('MoodTube: тема не сохранилась — не хватает места в браузере. Уменьшите картинки или используйте ссылки (URL) вместо загруженных файлов.');
        return false;
    }
}

// Пустые/опасные значения не должны ломать <style>
function sanitizeCssValue(val) {
    return String(val || '').replace(/[;{}<>]/g, '').trim();
}

// Значение для url("..."): http(s), относительный путь или data:image/...
function cssUrlValue(src) {
    src = String(src || '').trim();
    if (!src) return '';
    if (/^\s*(javascript|vbscript):/i.test(src)) return '';
    if (/^data:/i.test(src) && !/^data:image\//i.test(src)) return '';
    return `url("${src.replace(/\\/g, '%5C').replace(/"/g, '%22').replace(/[\r\n]+/g, '')}")`;
}

function applyCustomThemeCss(theme) {
    let $vars = $('#moodtube-custom-theme-css');
    let $user = $('#moodtube-custom-theme-user-css');
    if (!theme) { $vars.remove(); $user.remove(); return; }
    if (!$vars.length) $vars = $('<style id="moodtube-custom-theme-css"></style>');
    if (!$user.length) $user = $('<style id="moodtube-custom-theme-user-css"></style>');
    // Держим оба тега последними в <head>, чтобы тема перекрывала базовые стили и стили таверны
    $vars.appendTo('head');
    $user.appendTo('head');

    const lines = MT_THEME_VARS
        .map(v => {
            const val = sanitizeCssValue(theme.vars[v.key]);
            return val ? `    ${v.css}: ${val};` : '';
        });
    MT_THEME_IMAGES.forEach(v => {
        const val = cssUrlValue(theme.images?.[v.key]);
        if (val) lines.push(`    ${v.css}: ${val};`);
    });
    $vars.text(`[data-mt-theme="custom"] {\n${lines.filter(Boolean).join('\n')}\n}`);
    // Пользовательский CSS — в отдельном теге и без префиксов, чтобы @import оставался первым правилом
    $user.text(String(theme.custom_css || ''));
}

// Текстовые подписи плеера: из кастомной темы или значения по умолчанию
let mtStatusLabels = { playing: '', paused: '', idle: '' };
function applyThemeLabels(theme) {
    const labels = (theme || getDefaultCustomTheme()).labels;
    MT_THEME_LABELS.forEach(v => {
        if (v.target) $(v.target).text(labels[v.key] ?? v.def);
    });
    mtStatusLabels = { playing: labels.status_playing || '', paused: labels.status_paused || '', idle: labels.status_idle || '' };
    syncPlayerState();
}

// Состояние плеера для тем: класс .mt-is-playing и data-mt-state="playing|paused|idle"
function syncPlayerState() {
    const $player = $('#moodtube-mini-player');
    if (!$player.length) return;
    const playing = $('#moodtube-btn-playpause').hasClass('fa-pause');
    const hasTrack = typeof trackQueue !== 'undefined' && trackQueue.length > 0 && currentQueueIndex >= 0;
    const state = playing ? 'playing' : (hasTrack ? 'paused' : 'idle');
    $player.add('#moodtube-fab')
        .attr('data-mt-state', state)
        .toggleClass('mt-is-playing', state === 'playing')
        .toggleClass('mt-is-paused', state === 'paused')
        .toggleClass('mt-is-idle', state === 'idle');
    $('#moodtube-label-status').text(mtStatusLabels[state] || '');
}

function readCustomThemeForm() {
    const vars = {}, images = {}, labels = {};
    MT_THEME_VARS.forEach(v => vars[v.key] = String($(`#mt-custom-var-${v.key}`).val() || '').trim());
    MT_THEME_IMAGES.forEach(v => images[v.key] = String($(`#mt-custom-img-${v.key}`).data('mt-full') ?? $(`#mt-custom-img-${v.key}`).val() ?? '').trim());
    MT_THEME_LABELS.forEach(v => labels[v.key] = String($(`#mt-custom-label-${v.key}`).val() ?? ''));
    return normalizeCustomTheme({
        name: $('#mt-custom-theme-name').val(),
        vars,
        images,
        labels,
        custom_css: $('#mt-custom-theme-css').val(),
    });
}

// data:-картинки длинные — в поле показываем короткую метку, полное значение держим в data()
function setCustomImageField(key, src) {
    const $f = $(`#mt-custom-img-${key}`);
    src = String(src || '');
    if (/^data:/i.test(src)) {
        const kb = Math.round(src.length * 0.75 / 1024);
        $f.data('mt-full', src).val(`[загруженный файл, ~${kb} КБ]`).prop('readonly', true);
    } else {
        $f.removeData('mt-full').val(src).prop('readonly', false);
    }
    $(`#mt-custom-img-preview-${key}`).css('background-image', cssUrlValue(src) || 'none');
}

function fillCustomThemeForm(theme) {
    theme = normalizeCustomTheme(theme);
    $('#mt-custom-theme-name').val(theme.name);
    MT_THEME_VARS.forEach(v => {
        $(`#mt-custom-var-${v.key}`).val(theme.vars[v.key]);
        const hex = /^#[0-9a-f]{6}$/i.test(theme.vars[v.key]) ? theme.vars[v.key] : null;
        if (hex) $(`#mt-custom-pick-${v.key}`).val(hex);
    });
    MT_THEME_IMAGES.forEach(v => setCustomImageField(v.key, theme.images[v.key]));
    MT_THEME_LABELS.forEach(v => $(`#mt-custom-label-${v.key}`).val(theme.labels[v.key]));
    $('#mt-custom-theme-css').val(theme.custom_css);
}

function loadCustomImageFile(key, file, onDone) {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toastr.error('MoodTube: это не картинка'); return; }
    if (file.size > MT_IMAGE_MAX_BYTES) {
        toastr.error(`MoodTube: картинка больше ${Math.round(MT_IMAGE_MAX_BYTES / 1024 / 1024 * 10) / 10} МБ. Сожмите её или вставьте ссылку (URL).`);
        return;
    }
    const reader = new FileReader();
    reader.onload = () => { setCustomImageField(key, String(reader.result)); onDone && onDone(); };
    reader.onerror = () => toastr.error('MoodTube: не удалось прочитать картинку');
    reader.readAsDataURL(file);
}

function toggleCustomThemeBlock() {
    $('#mt-custom-theme-block').toggle($('#moodtube-setting-theme').val() === 'custom');
}

function exportCustomTheme() {
    const theme = readCustomThemeForm();
    const payload = {
        type: 'moodtube_theme',
        version: 2,
        name: theme.name,
        vars: theme.vars,
        images: theme.images,
        labels: theme.labels,
        custom_css: theme.custom_css,
    };
    const blob = new Blob([JSON.stringify(payload, null, 4)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${theme.name.replace(/[\\/:*?"<>|]+/g, '_') || 'moodtube-theme'}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toastr.success(`MoodTube: тема «${theme.name}» экспортирована`);
}

// Принимает как собственный формат MoodTube, так и файл темы SillyTavern (берёт custom_css и цвета)
function importCustomThemeFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        let data;
        try { data = JSON.parse(String(reader.result)); }
        catch (e) { toastr.error('MoodTube: файл не является корректным JSON'); return; }
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            toastr.error('MoodTube: неверный формат файла темы');
            return;
        }

        let theme;
        if (data.type === 'moodtube_theme' || data.vars || data.images || data.labels) {
            theme = normalizeCustomTheme(data);
        } else if (typeof data.custom_css === 'string' || data.blur_tint_color || data.quote_text_color) {
            // Тема SillyTavern
            const vars = {};
            if (data.quote_text_color) { vars.accent = data.quote_text_color; vars.accent_hover = data.quote_text_color; }
            if (data.blur_tint_color) vars.bg_primary = data.blur_tint_color;
            if (data.bot_mes_blur_tint_color) vars.bg_secondary = data.bot_mes_blur_tint_color;
            if (data.border_color) vars.border = data.border_color;
            theme = normalizeCustomTheme({ name: data.name || file.name.replace(/\.json$/i, ''), vars, custom_css: data.custom_css || '' });
        } else {
            toastr.error('MoodTube: в файле нет ни custom_css, ни переменных темы');
            return;
        }

        fillCustomThemeForm(theme);
        applyCustomThemeCss(theme);
        applyThemeLabels(theme);
        toastr.success(`MoodTube: тема «${theme.name}» загружена. Нажмите «Сохранить», чтобы применить навсегда.`);
    };
    reader.onerror = () => toastr.error('MoodTube: не удалось прочитать файл');
    reader.readAsText(file);
}

async function triggerMoodAnalysisAndPlay() {
    if (isAnalysisInProgress) return;
    
    $('#moodtube-btn-ai').addClass('mt-is-busy').find('.mt-btn-icon').addClass('fa-spin'); $('#moodtube-mini-player').addClass('mt-dj-busy');
    isAnalysisInProgress = true;

    try {
        const context = getContext();
        if (!context?.chat?.length) {
            toastr.warning("DJ AI: Чат пуст!");
            return;
        }
        
        const snippet = buildSceneSnippet(context);
        const sceneBackground = buildSceneBackground(context);

        let genre = getMtSetting('genre');
        let scenario = getMtSetting('scenario');
        let banlist = getMtSetting('banlist');
        let bannedSongs = localStorage.getItem('moodtube_global_banned_songs');
        if (bannedSongs === null) bannedSongs = getMtSetting('banned_songs') || '';
        let customPrompt = getMtSetting('custom');
        let hardRule = getMtSetting('hard_rule');
        let favoritesList = getMtSetting('favorites');
        let favoritesContext = getMtSetting('favorites_context') === 'true';

        const bulkCount = parseInt(localStorage.getItem('moodtube_ai_bulk_count') || 10, 10);
        const isBulk = bulkCount > 1;

        // --- Пользовательские ограничения ---
        const constraints = [];
        if (genre.trim()) constraints.push(`Preferred genre/style: ${genre}. Stay inside this style, but still pick the track within it that best matches the moment.`);
        if (scenario.trim()) constraints.push(`Story setting / vibe tags chosen by the user: ${scenario}. Treat them as the backdrop of the story (setting, era, tone).`);
        if (scenario.includes('Русреал') || genre.includes('Русреал')) constraints.push(`"Русреал" is active: pick ONLY Russian-language songs by Russian-speaking artists.`);
        if (favoritesContext && favoritesList.trim()) constraints.push(`User's favorite tracks (use one only if it genuinely fits this exact moment, otherwise use them as a taste reference): ${favoritesList}`);
        if (banlist.trim()) constraints.push(`BANNED artists — never pick them: ${banlist}`);
        if (bannedSongs.trim()) constraints.push(`BANNED songs — never pick them: ${bannedSongs}`);
        if (sessionPlayedTracks.length > 0) constraints.push(`Already played in this session — do NOT repeat them, and avoid repeating the same artists too often: ${sessionPlayedTracks.slice(-25).join(' | ')}`);
        const constraintsStr = constraints.length ? `\nUSER CONSTRAINTS:\n${constraints.map(c => `- ${c}`).join('\n')}\n` : '';

        const hardRuleStr = hardRule.trim()
            ? `\nCRITICAL HARD RULE (overrides everything above, including mood): the user EXPLICITLY requested this artist / song / theme: "${hardRule}". Fulfill it precisely.\n`
            : '';

        const formatStr = isBulk
            ? `{"Scene": "<one short line: setting + emotion + energy>", "Tracks": [{"Title": "Song Name", "Artist": "Artist Name"}, ... exactly ${bulkCount} items]}`
            : `{"Scene": "<one short line: setting + emotion + energy>", "Title": "Song Name", "Artist": "Artist Name"}`;

        const taskStr = isBulk
            ? `Build a playlist of EXACTLY ${bulkCount} tracks that works as the soundtrack for the next stretch of this scene. Track 1 must fit the CURRENT MOMENT best; the following tracks follow the most likely emotional trajectory of the scene (keep the setting and overall tone consistent, let intensity shift naturally). Use a different artist for every track whenever possible.`
            : `Pick ONE track — the best possible soundtrack for the CURRENT MOMENT.`;

        const systemInstruction = `[SYSTEM NOTE: CRITICAL OVERRIDE. You are MoodTube DJ — a professional film/game music supervisor working as a strict JSON API.
DO NOT ROLEPLAY. DO NOT CONTINUE THE STORY. DO NOT SPEAK AS ANY CHARACTER. NO GREETINGS, NO EXPLANATIONS OUTSIDE JSON.

TASK: ${taskStr}

HOW TO ANALYZE THE SCENE (think silently, put only a one-line summary in "Scene"):
1. The music follows the CURRENT MOMENT — the last 1-2 messages. Older messages are only background; never pick by the "average" mood of the whole chat.
2. Setting: place, era, culture/country, time of day, atmosphere (e.g. rainy night city, medieval tavern, school hallway, spaceship, Moscow suburbs in the 2000s).
3. Emotional core: the dominant feeling AND its intensity. Follow the subtext and the characters' inner state, not just surface actions (a calm conversation full of hidden tension = tense music; a fight full of grief = sad music).
4. Energy & tempo: slow / mid / fast, soft / heavy, intimate / epic.
5. Direction: is tension building, peaking, or resolving?

HOW TO CHOOSE THE MUSIC:
- Diegetic music wins: if the latest messages say a specific song/artist is playing, being sung, or requested — pick exactly that.
- Match setting, emotion and energy simultaneously. A great pick fits all three; a pick that fits only one is wrong.
- Lyrics must not contradict the scene (no happy love song at a funeral, no breakup song on a first date, no party anthem in a tense standoff). For tense, dialogue-heavy or atmospheric moments, instrumental tracks, film/game scores, ambient or low-vocal songs are often the best choice.
- Respect era and culture of the setting (medieval → folk/celtic/medieval; cyberpunk → synthwave/industrial/darksynth; noir → jazz/blues; Russian setting → Russian artists, etc.), unless the user's genre says otherwise.
- Think like a music supervisor, not a radio: avoid lazy clichés and the same few mega-hits everyone picks. Prefer precise, tasteful choices that are still easy to find on YouTube.
- ONLY real, officially released songs. Use the exact official song title and the main artist name as they appear on YouTube/Spotify. Never invent songs. No descriptions, years, "(feat. ...)" or "official video" in the fields.
${constraintsStr}${hardRuleStr}
OUTPUT: ONLY one valid JSON object, nothing before or after it:
${formatStr}]`;

        const reminder = `[REMINDER: Do not continue the story. Reply with ONLY the JSON object in this exact format: ${formatStr}]`;

        let defaultPrompt = `${systemInstruction}
${sceneBackground ? `\nSTORY BACKGROUND (for setting/era only):\n${sceneBackground}\n` : ''}
CHAT HISTORY (oldest → newest):
${snippet}

${reminder}`;

        let prompt = defaultPrompt;
        if (customPrompt.trim()) {
            prompt = customPrompt.replace('{{snippet}}', snippet).replace('{{history}}', sessionPlayedTracks.join(', '));
            prompt += `\n\n${systemInstruction}`; // Append strict rules to custom prompt as well
        }
        
        console.log(`${LOG_PREFIX} --- AI Request Prompt ---\n`, prompt);

        const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : getContext();
        const currentProfileName = localStorage.getItem('moodtube_active_profile_name') || '';
        let aiResponse;
        
        if (currentProfileName) {
            console.log(`${LOG_PREFIX} Using Connection Profile: ${currentProfileName}`);
            const profiles = stContext?.extensionSettings?.connectionManager?.profiles || [];
            const profile = profiles.find(p => p.name === currentProfileName);
            
            if (!profile) throw new Error(`Профиль '${currentProfileName}' не найден. Проверьте настройки.`);
            
            const cc_source = profile.api || 'openai';
            let generate_data = {
                'messages': [{ role: 'user', content: prompt }],
                'model': profile.model,
                'temperature': isBulk ? 0.9 : 0.7,
                'stream': false,
                'chat_completion_source': cc_source,
            };
            
            const profileApiValue = profile['api-url'];
            if (cc_source === 'custom' && profileApiValue) {
                let url = profileApiValue.trim().replace(/\/+$/, '');
                generate_data['custom_url'] = url;
                const ccSettings = stContext.chatCompletionSettings || {};
                if (ccSettings.custom_prompt_post_processing) generate_data['custom_prompt_post_processing'] = ccSettings.custom_prompt_post_processing;
                if (ccSettings.custom_include_body) generate_data['custom_include_body'] = ccSettings.custom_include_body;
                if (ccSettings.custom_exclude_body) generate_data['custom_exclude_body'] = ccSettings.custom_exclude_body;
                if (ccSettings.custom_include_headers) generate_data['custom_include_headers'] = ccSettings.custom_include_headers;
            } else if (cc_source === 'vertexai' && profileApiValue) {
                generate_data['vertexai_region'] = profileApiValue;
                const ccSettings = stContext.chatCompletionSettings || {};
                if (ccSettings.vertexai_auth_mode) generate_data['vertexai_auth_mode'] = ccSettings.vertexai_auth_mode;
                if (ccSettings.vertexai_express_project_id) generate_data['vertexai_express_project_id'] = ccSettings.vertexai_express_project_id;
            } else if (cc_source === 'zai' && profileApiValue) {
                generate_data['zai_endpoint'] = profileApiValue;
            }

            const headers = (typeof stContext.getRequestHeaders === 'function') ? stContext.getRequestHeaders() : {'Content-Type': 'application/json'};
            const res = await fetch('/api/backends/chat-completions/generate', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify(generate_data)
            });
            if (!res.ok) {
                const errData = await res.json().catch(() => ({error: {message: res.statusText}}));
                throw new Error(`API Error ${res.status}: ${errData.error?.message || 'Unknown'}`);
            }
            aiResponse = await res.json();
        } else {
            console.log(`${LOG_PREFIX} Using SillyTavern generateRaw (Tavern API)...`);
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
        
        const { scene, tracks } = extractTracksFromAI(aiText);
        if (scene) console.log(`${LOG_PREFIX} DJ scene analysis: ${scene}`);

        if (tracks.length === 0) {
            console.error(`${LOG_PREFIX} Extracted string failed parsing:`, aiText);
            throw new Error(isBulk ? "Could not parse bulk tracks array" : "No valid JSON or song info found in response");
        }

        if (isBulk) {
            toastr.success(`MoodTube: Генерирую очередь из ${tracks.length} треков...`);
            for (const track of tracks) {
                await searchAndPlay(buildTrackSearchQuery(track));
            }
        } else {
            await searchAndPlay(buildTrackSearchQuery(tracks[0]));
        }

    } catch (e) {
        console.error(`${LOG_PREFIX} DJ AI Error:`, e);
        if (e.message && e.message.includes("API Error")) {
            toastr.error(`DJ AI Ошибка: ${e.message}`);
        } else if (e.message && (e.message.includes("No valid JSON") || e.message.includes("Could not parse bulk tracks array"))) {
            toastr.error(`DJ AI: ИИ вернул неверный формат (возможно, продолжил пост вместо выдачи JSON).`);
        } else {
            toastr.error(`DJ AI Ошибка: ${e.message || "Неизвестная ошибка"}`);
        }
    } finally {
        isAnalysisInProgress = false;
        $('#moodtube-btn-ai').removeClass('mt-is-busy').find('.mt-btn-icon').removeClass('fa-spin'); $('#moodtube-mini-player').removeClass('mt-dj-busy');
    }
}

// --- ПОДГОТОВКА КОНТЕКСТА СЦЕНЫ ДЛЯ DJ AI ---
function cleanMessageForDJ(text) {
    return String(text || '')
        .replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, ' ')
        .replace(/<(style|script)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .replace(/\n{2,}/g, '\n')
        .trim();
}

// Для старых сообщений важнее конец (там, где сцена закончилась)
function truncateForDJ(text, limit) {
    if (text.length <= limit) return text;
    return '…' + text.slice(text.length - limit);
}

function buildSceneSnippet(context) {
    const userName = context.name1 || 'User';
    const charName = context.name2 || 'Character';
    const messages = context.chat
        .filter(m => m && !m.is_system && typeof m.mes === 'string')
        .slice(-15)
        .map(m => ({ name: m.name || (m.is_user ? userName : charName), text: cleanMessageForDJ(m.mes) }))
        .filter(m => m.text);

    const lastIdx = messages.length - 1;
    return messages.map((m, i) => {
        const fromEnd = lastIdx - i;
        const limit = fromEnd === 0 ? 3000 : fromEnd <= 2 ? 1500 : 500;
        const text = truncateForDJ(m.text, limit);
        if (fromEnd === 0) return `\n=== CURRENT MOMENT (latest message — the music must fit THIS) ===\n${m.name}: ${text}`;
        return `${m.name}: ${text}`;
    }).join('\n\n');
}

// Короткая выжимка карточки персонажа: помогает понять сеттинг и эпоху
function buildSceneBackground(context) {
    try {
        const char = context.characters?.[context.characterId];
        if (!char) return '';
        const parts = [];
        const scenario = cleanMessageForDJ(char.scenario || char.data?.scenario || '');
        const description = cleanMessageForDJ(char.description || char.data?.description || '');
        if (scenario) parts.push(`Scenario: ${scenario.slice(0, 600)}`);
        if (description) parts.push(`${char.name || 'Character'}: ${description.slice(0, 600)}`);
        const text = parts.join('\n');
        return typeof context.substituteParams === 'function' ? context.substituteParams(text) : text;
    } catch (e) {
        return '';
    }
}

function buildTrackSearchQuery(track) {
    const title = String(track.Title || track.title || '').trim();
    const artist = String(track.Artist || track.artist || '').trim();
    return artist ? `${artist} - ${title}` : title;
}

// Ищет в тексте все сбалансированные JSON-объекты/массивы (с учётом строк)
function findJSONCandidates(text) {
    const results = [];
    for (let start = 0; start < text.length; start++) {
        const open = text[start];
        if (open !== '{' && open !== '[') continue;
        const close = open === '{' ? '}' : ']';
        let depth = 0, inStr = false, esc = false;
        for (let i = start; i < text.length; i++) {
            const ch = text[i];
            if (inStr) {
                if (esc) esc = false;
                else if (ch === '\\') esc = true;
                else if (ch === '"') inStr = false;
                continue;
            }
            if (ch === '"') inStr = true;
            else if (ch === open) depth++;
            else if (ch === close) {
                depth--;
                if (depth === 0) {
                    try { results.push(JSON.parse(text.substring(start, i + 1))); start = i; } catch (e) {}
                    break;
                }
            }
        }
    }
    return results;
}

function isTrackObject(o) {
    return o && typeof o === 'object' && !Array.isArray(o) && (o.Title || o.title);
}

// Понимает: {"Scene","Title","Artist"}, {"Scene","Tracks":[...]}, [{...}, ...]
function extractTracksFromAI(aiText) {
    const text = cleanThinkBlocks(aiText);
    const candidates = [];
    const blockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (blockMatch) {
        try { candidates.push(JSON.parse(blockMatch[1])); } catch (e) {}
    }
    candidates.push(...findJSONCandidates(text));

    for (const c of candidates) {
        if (Array.isArray(c)) {
            const tracks = c.filter(isTrackObject);
            if (tracks.length) return { scene: '', tracks };
        } else if (c && typeof c === 'object') {
            const list = c.Tracks || c.tracks || c.Playlist || c.playlist;
            if (Array.isArray(list) && list.some(isTrackObject)) {
                return { scene: c.Scene || c.scene || '', tracks: list.filter(isTrackObject) };
            }
            if (isTrackObject(c)) return { scene: c.Scene || c.scene || '', tracks: [c] };
        }
    }

    const single = parseAISongJSON(text);
    return { scene: '', tracks: isTrackObject(single) ? [single] : [] };
}

function cleanThinkBlocks(text) {
    return String(text || '').replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
}


function extractAIText(aiResponse) {
    if (typeof aiResponse === 'string') return aiResponse;
    if (aiResponse.content && typeof aiResponse.content === 'string') return aiResponse.content;
    if (aiResponse.text) return aiResponse.text;
    if (aiResponse.candidates?.[0]?.content?.parts?.[0]?.text) return aiResponse.candidates[0].content.parts[0].text;
    if (aiResponse.choices?.[0]?.message?.content) return aiResponse.choices[0].message.content;
    if (aiResponse.choices?.[0]?.text) return aiResponse.choices[0].text;
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
        if ($(e.target).closest('.moodtube-ctrl, input, button, select, textarea, a').length || $(e.target).closest('#moodtube-resize-handle').length || $(e.target).closest('#moodtube-queue-list').length || $(e.target).closest('#moodtube-playlists-list').length) return;
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
                <div id="moodtube-wand-item" class="list-group-item flex-container flexGap5 interactable" tabindex="0" style="color: var(--mt-accent);">
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

    $(`<style id="moodtube-theme-css">
        :root, [data-mt-theme="blue"] {
            --mt-accent: #8db7d5; --mt-accent-hover: #a5d0f0;
            --mt-bg-primary: rgba(15,20,25,0.88); --mt-bg-secondary: rgba(22,28,35,0.88);
            --mt-bg-input: rgba(10,15,20,0.6); --mt-border: rgba(141,183,213,0.3);
        }
        [data-mt-theme="grey"] {
            --mt-accent: #9CA3AF; --mt-accent-hover: #D1D5DB;
            --mt-bg-primary: rgba(31,31,35,0.88); --mt-bg-secondary: rgba(40,40,46,0.88);
            --mt-bg-input: rgba(25,25,30,0.6); --mt-border: rgba(156,163,175,0.3);
        }
        [data-mt-theme="rose"] {
            --mt-accent: #b87575; --mt-accent-hover: #cc9090;
            --mt-bg-primary: rgba(24,19,26,0.88); --mt-bg-secondary: rgba(32,24,32,0.88);
            --mt-bg-input: rgba(20,15,22,0.6); --mt-border: #3d2d3a;
        }
        [data-mt-theme="emerald"] {
            --mt-accent: #86bfa0; --mt-accent-hover: #9cd5b6;
            --mt-bg-primary: rgba(24,28,26,0.88); --mt-bg-secondary: rgba(34,38,36,0.88);
            --mt-bg-input: rgba(20,24,22,0.6); --mt-border: rgba(134,191,160,0.3);
        }
        [data-mt-theme="auto"] {
            --mt-accent: var(--SmartThemeQuoteColor, var(--mainColor, #8db7d5));
            --mt-accent-hover: var(--SmartThemeQuoteColor, var(--mainColor, #a5d0f0));
            --mt-bg-primary: var(--SmartThemeBlurTintColor, rgba(15,20,25,0.88));
            --mt-bg-secondary: var(--SmartThemeBotMesBlurTintColor, rgba(22,28,35,0.88));
            --mt-bg-input: var(--black50a, rgba(10,15,20,0.6));
            --mt-border: var(--SmartThemeQuoteColor, var(--mainColor, rgba(141,183,213,0.3)));
        }
        
        @keyframes mt-spin { 100% { transform: rotate(360deg); } }
        #moodtube-fab.mt-playing::before {
            content: ''; position: absolute;
            top: -2px; left: -2px; right: -2px; bottom: -2px;
            border-radius: 50%;
            border: 2px solid transparent;
            border-top-color: var(--mt-accent);
            animation: mt-spin 1s linear infinite;
            pointer-events: none;
        }
        
        .moodtube-ctrl:hover { color: var(--mt-accent); transform: scale(1.1); transition: 0.2s; }

        /* ===== Плеер: базовые стили на классах (низкая специфичность — темы перекрывают без !important) ===== */
        .mt-player {
            position: fixed; z-index: 9998; box-sizing: border-box; overflow: hidden;
            padding: 20px; color: #fff; font-family: -apple-system, sans-serif;
            background: var(--mt-bg-primary); border: 1px solid var(--mt-border); border-radius: 20px;
            box-shadow: 0 15px 35px rgba(0,0,0,0.8), inset 0 0 10px rgba(255,255,255,0.05);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
            cursor: grab; user-select: none; transition: opacity 0.3s;
        }

        /* Тени/фильтры текста из тем таверны не протекают в плеер (тема MoodTube может вернуть их своим CSS) */
        .mt-player, .mt-player *, .mt-fab, .mt-fab * { text-shadow: none; }

        /* Слоты под картинки/разметку темы. Картинки задаются переменными --mt-img-* */
        .mt-slot { position: absolute; inset: 0; pointer-events: none; background-repeat: no-repeat; background-position: center; background-size: cover; }
        .mt-slot-bg    { z-index: 0; background-image: var(--mt-img-bg, none); }
        .mt-slot-scene { z-index: 1; background-image: var(--mt-img-scene, none); }
        .mt-slot-decor { z-index: 3; background-image: var(--mt-img-decor, none); background-size: contain; }
        .mt-slot-cover-bg { z-index: 0; border-radius: inherit; background-image: var(--mt-img-cover-bg, none); }
        .mt-slot-cover { z-index: 2; border-radius: inherit; background-image: var(--mt-img-cover, none); }

        .mt-player-header {
            position: absolute; top: 12px; left: 18px; right: 70px; z-index: 2;
            display: flex; align-items: baseline; gap: 8px; pointer-events: none;
            font-size: 12px; white-space: nowrap; overflow: hidden;
        }
        .mt-player-header-title { font-weight: 700; color: var(--mt-accent); overflow: hidden; text-overflow: ellipsis; }
        .mt-player-status { font-size: 11px; opacity: 0.7; overflow: hidden; text-overflow: ellipsis; }
        .mt-player-header-title:empty, .mt-player-status:empty { display: none; }

        .mt-player-body {
            position: relative; z-index: 2;
            display: flex; flex-direction: column; align-items: center; justify-content: center;
            gap: 15px; width: 100%; height: 100%; box-sizing: border-box;
        }

        .mt-cover {
            position: relative; flex-shrink: 0; overflow: hidden;
            width: 140px; height: 140px; border-radius: 50%;
            background: #050505; border: 3px solid var(--mt-accent); box-shadow: 0 5px 15px rgba(0,0,0,0.7);
            display: flex; justify-content: center; align-items: center; transition: 0.3s all;
        }
        .mt-cover-img { position: relative; z-index: 1; width: 100%; height: 100%; border-radius: 50%; object-fit: cover; }
        .mt-cover-hole {
            position: absolute; z-index: 3; width: 14px; height: 14px;
            background: #222; border-radius: 50%; border: 1px solid var(--mt-accent); transition: 0.3s all;
        }

        .mt-track-info {
            position: relative; flex-shrink: 0; box-sizing: border-box;
            display: flex; flex-direction: column; align-items: center;
            width: 100%; padding: 0 22px; text-align: center;
        }
        .mt-track-info > span { max-width: 100%; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-track-title { font-weight: 600; font-size: 15px; width: 100%; margin-bottom: 2px; }
        .mt-track-subtitle { color: var(--mt-accent); font-size: 12px; font-weight: bold; }
        .mt-track-subtitle:empty { display: none; }

        .mt-progress { display: flex; align-items: center; width: 100%; flex-shrink: 0; gap: 5px; margin-top: -5px; font-size: 10px; color: #aaa; }
        .mt-time { flex-shrink: 0; min-width: 28px; font-variant-numeric: tabular-nums; }
        .mt-time-total { text-align: right; }

        .mt-controls { display: flex; gap: 15px; align-items: center; flex-shrink: 0; }
        .mt-btn { cursor: pointer; color: #fff; font-size: 18px; transition: 0.2s; }
        .mt-btn-accent { color: var(--mt-accent); }
        .mt-btn-small { font-size: 12px; }
        .mt-btn-queue { font-size: 16px; }
        .mt-btn-play { font-size: 28px; width: 28px; text-align: center; }
        .mt-btn-favorite { position: absolute; right: 0; top: 0; color: var(--mt-accent); font-size: 16px; }
        .mt-btn-ai { display: inline-flex; align-items: center; justify-content: center; }
        .mt-btn-ai.mt-is-busy { color: #00ff00; }
        .mt-window-btn { position: absolute; top: 12px; z-index: 5; color: #888; font-size: 16px; }
        .mt-btn-settings { right: 40px; }
        .mt-btn-close { right: 15px; }

        .mt-volume { display: flex; align-items: center; width: 90%; flex-shrink: 0; }
        .mt-volume-icon { color: var(--mt-accent); font-size: 12px; }
        .mt-volume-high { font-size: 14px; }

        .mt-panel {
            position: absolute; inset: 0; z-index: 4; box-sizing: border-box;
            flex-direction: column; padding: 15px; background: var(--mt-bg-primary);
        }
        .mt-panel-playlists { z-index: 5; }
        .mt-panel-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; flex-shrink: 0; }
        .mt-panel-header-left { display: flex; align-items: center; gap: 10px; }
        .mt-panel-title { font-weight: bold; font-size: 14px; color: var(--mt-accent); }
        .mt-panel-close { font-size: 14px; }
        .mt-panel-list { flex: 1; overflow-y: auto; padding-right: 5px; }

        /* Строки очереди и плейлистов Spotify */
        .mt-queue-item {
            display: flex; align-items: center; gap: 10px; padding: 8px 10px; margin-bottom: 5px;
            cursor: pointer; border-radius: 10px; transition: 0.2s;
            background: rgba(0,0,0,0.3); border: 1px solid transparent;
        }
        .mt-queue-item:hover { background: rgba(255,255,255,0.1); }
        .mt-queue-item.mt-is-current { background: rgba(255,255,255,0.05); border-color: var(--mt-accent); }
        .mt-queue-thumb { width: 30px; height: 30px; border-radius: 5px; object-fit: cover; flex-shrink: 0; }
        .mt-queue-thumb.mt-is-empty { background: rgba(255,255,255,0.1); }
        .mt-queue-title { flex: 1; min-width: 0; font-size: 12px; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-queue-item.mt-is-current .mt-queue-title { color: #fff; }
        .mt-queue-item.mt-is-blocked .mt-queue-title { color: #ff6b6b; }
        .mt-playlist-title { font-weight: bold; font-size: 13px; color: #fff; }
        .mt-queue-now { color: var(--mt-accent); font-size: 10px; margin-right: 5px; }
        .mt-queue-add { width: 16px; height: 16px; display: flex; justify-content: center; align-items: center; cursor: pointer; color: var(--mt-accent); font-size: 12px; }
        .mt-queue-dislike {
            width: 16px; height: 16px; flex-shrink: 0; cursor: pointer;
            background-color: rgba(235,120,120,0.65);
            -webkit-mask: url(https://img.icons8.com/ios-filled/50/dislike.png) no-repeat center / contain;
            mask: url(https://img.icons8.com/ios-filled/50/dislike.png) no-repeat center / contain;
        }
        .mt-queue-empty { font-size: 12px; color: #888; text-align: center; padding: 10px; }

        /* Плавающая кнопка. Inline у неё только координаты */
        .mt-fab {
            position: fixed; z-index: 9999999; width: 48px; height: 48px; box-sizing: border-box;
            display: flex; justify-content: center; align-items: center;
            background: var(--mt-bg-secondary); border: 2px solid var(--mt-accent); border-radius: 50%;
            box-shadow: 0 4px 15px rgba(0,0,0,0.5); color: var(--mt-accent); font-size: 18px;
            cursor: grab; transition: background 0.2s, border 0.2s;
            touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
        }
        .mt-fab.mt-is-dragging { cursor: grabbing; }
        .mt-fab.mt-fab-docked { position: relative; z-index: auto; background: rgba(20,15,20,0.82); box-shadow: 0 4px 8px rgba(0,0,0,0.3); cursor: pointer; }
        .mt-fab-icon { position: relative; z-index: 2; margin-left: 3px; pointer-events: none; color: inherit; }
        .mt-fab-icon.fa-pause { margin-left: 0; }

        .mt-resize-handle {
            position: absolute; bottom: 0; right: 0; z-index: 10; width: 25px; height: 25px;
            display: flex; justify-content: center; align-items: center; cursor: nwse-resize;
        }
        .mt-resize-handle i { color: rgba(255,255,255,0.2); font-size: 14px; transform: rotate(-45deg); }

        /* Слайдеры изолированы от глобальных стилей input[type=range] из тем таверны.
           Внешний вид настраивается переменными --mt-slider-* без !important. */
        #moodtube-mini-player input[type="range"].moodtube-slider {
            -webkit-appearance: none !important; appearance: none !important;
            flex: 1 1 auto; width: 100%; min-width: 40px; height: var(--mt-slider-thumb-size, 14px) !important;
            margin: 0 8px !important; padding: 0 !important;
            background: transparent !important;
            border: none !important; border-radius: 0 !important; box-shadow: none !important;
            outline: none !important; filter: none !important; opacity: 1 !important;
            cursor: pointer; transform: none !important;
        }
        #moodtube-mini-player input[type="range"].moodtube-slider::-webkit-slider-runnable-track {
            -webkit-appearance: none !important; height: var(--mt-slider-track-height, 4px) !important;
            background: var(--mt-slider-track, rgba(255,255,255,0.12)) !important;
            border: none !important; border-radius: var(--mt-slider-track-radius, 2px) !important; box-shadow: none !important;
        }
        #moodtube-mini-player input[type="range"].moodtube-slider::-moz-range-track {
            height: var(--mt-slider-track-height, 4px) !important;
            background: var(--mt-slider-track, rgba(255,255,255,0.12)) !important;
            border: none !important; border-radius: var(--mt-slider-track-radius, 2px) !important; box-shadow: none !important;
        }
        #moodtube-mini-player input[type="range"].moodtube-slider::-moz-range-progress {
            height: var(--mt-slider-track-height, 4px) !important;
            background: var(--mt-slider-progress, var(--mt-accent)) !important;
            border-radius: var(--mt-slider-track-radius, 2px) !important;
        }
        #moodtube-mini-player input[type="range"].moodtube-slider::-webkit-slider-thumb {
            -webkit-appearance: none !important; appearance: none !important;
            width: var(--mt-slider-thumb-size, 14px) !important; height: var(--mt-slider-thumb-size, 14px) !important;
            margin-top: calc((var(--mt-slider-track-height, 4px) - var(--mt-slider-thumb-size, 14px)) / 2) !important;
            border-radius: var(--mt-slider-thumb-radius, 50%) !important;
            border: var(--mt-slider-thumb-border, 2px solid #fff) !important;
            background: var(--mt-slider-thumb-bg, var(--mt-accent)) !important;
            box-shadow: var(--mt-slider-thumb-shadow, 0 0 5px rgba(0,0,0,0.5)) !important;
            -webkit-mask: none !important; mask: none !important; filter: none !important;
            content: none !important; cursor: pointer; box-sizing: border-box !important;
        }
        #moodtube-mini-player input[type="range"].moodtube-slider::-moz-range-thumb {
            width: var(--mt-slider-thumb-size, 14px) !important; height: var(--mt-slider-thumb-size, 14px) !important;
            border-radius: var(--mt-slider-thumb-radius, 50%) !important;
            border: var(--mt-slider-thumb-border, 2px solid #fff) !important;
            background: var(--mt-slider-thumb-bg, var(--mt-accent)) !important;
            box-shadow: var(--mt-slider-thumb-shadow, 0 0 5px rgba(0,0,0,0.5)) !important;
            mask: none !important; filter: none !important; cursor: pointer; box-sizing: border-box !important;
        }
        #moodtube-mini-player input[type="range"].moodtube-slider:hover::-webkit-slider-thumb { background: var(--mt-slider-thumb-bg-hover, var(--mt-accent-hover)) !important; }
        #moodtube-mini-player input[type="range"].moodtube-slider:hover::-moz-range-thumb { background: var(--mt-slider-thumb-bg-hover, var(--mt-accent-hover)) !important; }

        /* Responsive Row Layout */
        .mt-player.moodtube-row-layout .mt-player-body { flex-direction: row; justify-content: flex-start; gap: 12px; }
        .mt-player.moodtube-row-layout .mt-cover { width: 50px; height: 50px; border-width: 2px; }
        .mt-player.moodtube-row-layout .mt-cover-hole { width: 8px; height: 8px; }
        .mt-player.moodtube-row-layout .mt-track-info { align-items: flex-start; text-align: left; flex: 0 1 180px; width: auto; min-width: 70px; padding: 0 22px 0 0; }
        .mt-player.moodtube-row-layout .mt-progress { flex: 1 1 140px; width: auto; min-width: 90px; margin-top: 0; }
        .mt-player.moodtube-row-layout .mt-controls { gap: 12px; }
        .mt-player.moodtube-row-layout .mt-volume { flex: 0 1 110px; width: auto; min-width: 70px; }

        /* Minimal Layout (Hidden elements) */
        .mt-player.moodtube-no-cover .mt-cover { display: none; }
        .mt-player.moodtube-no-vol .mt-volume { display: none; }
        .mt-player.moodtube-no-vol .mt-progress { display: none; }
        .mt-player.moodtube-no-title .mt-track-info { display: none; }
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
        <div id="moodtube-mini-player" class="mt-player mt-is-idle" data-mt-state="idle" style="top: 150px; left: 50%; transform: translateX(-50%); width: ${savedW}; height: ${savedH}; display: none;">
            <div class="mt-slot mt-slot-bg" aria-hidden="true"></div>
            <div class="mt-slot mt-slot-scene" aria-hidden="true"></div>

            <div class="mt-player-header">
                <span id="moodtube-label-header" class="mt-player-header-title"></span>
                <span id="moodtube-label-status" class="mt-player-status"></span>
            </div>

            <div id="moodtube-inner-content" class="mt-player-body">
                <div id="moodtube-cover-container" class="mt-cover">
                    <div class="mt-slot mt-slot-cover-bg" aria-hidden="true"></div>
                    <img id="moodtube-widget-cover" class="mt-cover-img" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7">
                    <div class="mt-slot mt-slot-cover" aria-hidden="true"></div>
                    <div id="moodtube-cover-hole" class="mt-cover-hole"></div>
                </div>

                <div id="moodtube-title-container" class="mt-track-info">
                    <span id="moodtube-widget-title" class="mt-track-title">No Track Selected</span>
                    <span id="moodtube-label-subtitle" class="mt-track-subtitle">MoodTube DJ</span>
                    <i class="fa-regular fa-heart moodtube-ctrl mt-btn mt-btn-favorite" id="moodtube-btn-favorite" title="В избранное"></i>
                </div>

                <div id="moodtube-progress-container" class="mt-progress">
                    <span id="moodtube-time-current" class="mt-time mt-time-current">0:00</span>
                    <input type="range" id="moodtube-progress-slider" min="0" max="100" value="0" class="moodtube-slider moodtube-ctrl mt-progress-slider">
                    <span id="moodtube-time-total" class="mt-time mt-time-total">0:00</span>
                </div>

                <div id="moodtube-controls-container" class="mt-controls">
                    <i class="fa-solid fa-list-ul moodtube-ctrl mt-btn mt-btn-accent mt-btn-queue" id="moodtube-btn-queue" title="Queue"></i>
                    <i class="fa-solid fa-backward-step moodtube-ctrl mt-btn mt-btn-prev" id="moodtube-btn-prev" title="Previous"></i>
                    <i class="fa-solid fa-play moodtube-ctrl mt-btn mt-btn-play" id="moodtube-btn-playpause"></i>
                    <i class="fa-solid fa-forward-step moodtube-ctrl mt-btn mt-btn-next" id="moodtube-btn-next" title="Next"></i>
                    <span class="moodtube-ctrl mt-btn mt-btn-accent mt-btn-ai" id="moodtube-btn-ai" title="Auto-DJ (AI)"><i class="fa-solid fa-wand-magic-sparkles mt-btn-icon"></i></span>
                </div>

                <div id="moodtube-volume-container" class="mt-volume">
                    <i class="fa-solid fa-volume-low mt-volume-icon mt-volume-low"></i>
                    <input type="range" id="moodtube-vol-slider" min="0" max="100" value="50" class="moodtube-slider moodtube-ctrl mt-volume-slider">
                    <i class="fa-solid fa-volume-high mt-volume-icon mt-volume-high"></i>
                </div>
            </div>

            <div class="mt-slot mt-slot-decor" aria-hidden="true"></div>

            <div id="moodtube-queue-container" class="mt-panel mt-panel-queue" style="display:none;">
                <div class="mt-panel-header">
                    <div class="mt-panel-header-left">
                        <span class="mt-panel-title">Очередь треков</span>
                        <i class="fa-solid fa-trash moodtube-ctrl mt-btn mt-btn-accent mt-btn-small" id="moodtube-btn-clear-queue" title="Очистить очередь"></i>
                        <i class="fa-solid fa-list-check moodtube-ctrl mt-btn mt-btn-accent mt-btn-small" id="moodtube-btn-spotify-playlists" style="display:none;" title="Мои плейлисты Spotify"></i>
                    </div>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl mt-btn mt-panel-close" id="moodtube-btn-close-queue" title="Скрыть"></i>
                </div>
                <div id="moodtube-queue-list" class="mt-panel-list">
                    <div class="mt-queue-empty">Очередь пуста</div>
                </div>
            </div>

            <div id="moodtube-spotify-playlists-container" class="mt-panel mt-panel-playlists" style="display:none;">
                <div class="mt-panel-header">
                    <span class="mt-panel-title">Плейлисты Spotify</span>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl mt-btn mt-panel-close" id="moodtube-btn-close-playlists" title="Скрыть"></i>
                </div>
                <div id="moodtube-playlists-list" class="mt-panel-list"></div>
            </div>

            <audio id="moodtube-audio-fallback" style="display:none;"></audio>

            <i class="fa-solid fa-gear moodtube-ctrl mt-btn mt-window-btn mt-btn-settings" id="moodtube-btn-settings" title="Settings"></i>
            <i class="fa-solid fa-xmark moodtube-ctrl mt-btn mt-window-btn mt-btn-close" id="moodtube-btn-close" title="Close"></i>

            <div id="moodtube-resize-handle" class="mt-resize-handle">
                <i class="fa-solid fa-caret-down"></i>
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
    background-color: var(--mt-bg-primary);
    backdrop-filter: blur(45px);
    border: 1px solid var(--mt-border);
    border-radius: 16px;
    box-shadow: 0 30px 60px rgba(0,0,0,0.9) !important;
    overflow: hidden; box-sizing: border-box;
}
.mt-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 18px 22px;
    background-color: var(--mt-bg-secondary);
    flex-shrink: 0;
    border-bottom: 1px solid var(--mt-border);
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
    background-color: var(--mt-bg-secondary);
    border: 1px solid var(--mt-border);
}
.mt-category:last-child { margin-bottom: 0; }
.mt-cat-title {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 16px; cursor: pointer; user-select: none;
    transition: background-color 0.2s;
}
.mt-cat-title:hover { background-color: rgba(255,255,255,0.04); }
.mt-cat-title i:first-child { font-size: 1em; width: 20px; text-align: center; color: var(--mt-accent) !important; }
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
.mt-genre-tag:hover { border-color: var(--mt-accent); color: #fff; background-color: rgba(255, 255, 255, 0.1); }
.mt-genre-tag.active { background-color: var(--mt-accent); color: #111827; border-color: var(--mt-accent); font-weight: 600; box-shadow: 0 0 10px var(--mt-border); }
/* Mood tags */
.mt-mood-tag:hover { border-color: var(--mt-accent); color: #fff; background-color: rgba(255, 255, 255, 0.1); }
.mt-mood-tag.active { background-color: var(--mt-accent); color: #111827; border-color: var(--mt-accent); font-weight: 600; box-shadow: 0 0 10px var(--mt-border); }
/* Scenario tags */
.mt-scenario-tag:hover { border-color: var(--mt-accent); color: #fff; background-color: rgba(255, 255, 255, 0.1); }
.mt-scenario-tag.active { background-color: var(--mt-accent); color: #111827; border-color: var(--mt-accent); font-weight: 600; box-shadow: 0 0 10px var(--mt-border); }
/* API section */
.mt-input-field {
    background: var(--mt-bg-input); border: 1px solid var(--mt-border);
    border-radius: 8px; color: #E5E7EB; padding: 8px 10px;
    font-size: 0.85em; outline: none; transition: 0.2s;
    width: 100%; box-sizing: border-box; font-family: inherit;
}
.mt-input-field:focus { border-color: var(--mt-accent); background: var(--mt-bg-secondary); }
.mt-input-field::placeholder { color: #6B7280; }
.mt-label { display: block; font-size: 0.82em; color: #9CA3AF; margin-bottom: 4px; margin-top: 8px; }
.mt-label:first-child { margin-top: 0; }
.mt-footer {
    padding: 14px 22px;
    background-color: var(--mt-bg-primary);
    border-top: 1px solid var(--mt-border);
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
.mt-sum-genre { background-color: var(--mt-accent); color: #111827; }
.mt-sum-mood { background-color: var(--mt-accent); color: #111827; }
.mt-sum-scenario { background-color: var(--mt-accent); color: #111827; }
.mt-btn-save {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    background: var(--mt-accent); color: #000; font-weight: 600;
    font-size: 0.95em; cursor: pointer; transition: 0.2s; letter-spacing: 0.5px;
}
.mt-btn-save:hover { filter: brightness(1.15); }
.mt-btn-test {
    width: 100%; padding: 10px; margin-top: 8px;
    background: rgba(255,255,255,0.07); color: #E5E7EB;
    border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
    cursor: pointer; font-weight: 500; font-size: 0.85em; transition: 0.2s;
}
.mt-btn-test:hover { background: rgba(255,255,255,0.12); border-color: var(--mt-accent); }
.mt-checkbox-row {
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    padding: 4px 0; font-size: 0.9em; color: #D1D5DB;
}
.mt-checkbox-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--mt-accent); }
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
                        <h3><i class="fa-solid fa-sliders" style="margin-right:8px; color:var(--mt-accent);"></i>MoodTube</h3>
                        <div style="display:flex; align-items:center; gap:15px;">
                            <span class="mt-close" id="mt-close-settings">&#10006;</span>
                        </div>
                    </div>
                    <div class="mt-content">

                        <!-- ИНТЕРФЕЙС -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="ui">
                                <i class="fa-solid fa-desktop"></i>
                                <h4>Интерфейс</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-ui">
                                <span class="mt-label" style="margin-top:0;">Тема оформления</span>
                                <select id="moodtube-setting-theme" class="mt-input-field">
                                    <option value="blue">Blue (Default)</option>
                                    <option value="grey">Grey</option>
                                    <option value="rose">Rose</option>
                                    <option value="emerald">Emerald</option>
                                    <option value="auto">Tavern Auto</option>
                                    <option value="custom">Custom (свой CSS)</option>
                                </select>
                                <div id="mt-custom-theme-block" style="display:none; padding:10px; background:rgba(0,0,0,0.2); border-radius:8px; margin-top:10px; border:1px solid var(--mt-border);">
                                    <span class="mt-label" style="margin-top:0; color:var(--mt-accent);"><i class="fa-solid fa-palette"></i> Кастомная тема</span>
                                    <span class="mt-label">Название темы</span>
                                    <input type="text" id="mt-custom-theme-name" class="mt-input-field" placeholder="My MoodTube Theme">
                                    <span class="mt-label">Цвета (HEX или rgba)</span>
                                    <div id="mt-custom-vars" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:6px 10px;">
                                        ${MT_THEME_VARS.map(v => `
                                        <div>
                                            <span class="mt-label" style="margin-top:2px; font-size:0.76em;">${v.label} <code style="opacity:0.6;">${v.css}</code></span>
                                            <div style="display:flex; gap:6px; align-items:center;">
                                                <input type="color" id="mt-custom-pick-${v.key}" data-mt-var="${v.key}" class="mt-custom-pick" style="width:34px; height:30px; padding:0; border:none; background:none; cursor:pointer; flex-shrink:0;">
                                                <input type="text" id="mt-custom-var-${v.key}" class="mt-input-field mt-custom-var" placeholder="${v.def}">
                                            </div>
                                        </div>`).join('')}
                                    </div>
                                    <span class="mt-label" style="margin-top:10px;">Картинки (URL или файл до 1.5 МБ)</span>
                                    ${MT_THEME_IMAGES.map(v => `
                                    <div style="margin-top:4px;">
                                        <span class="mt-label" style="margin-top:2px; font-size:0.76em;">${v.label} <code style="opacity:0.6;">${v.css}</code> — ${v.hint}</span>
                                        <div style="display:flex; gap:6px; align-items:center;">
                                            <div id="mt-custom-img-preview-${v.key}" style="width:30px; height:30px; flex-shrink:0; border-radius:6px; border:1px solid var(--mt-border); background:rgba(0,0,0,0.3) center/cover no-repeat;"></div>
                                            <input type="text" id="mt-custom-img-${v.key}" data-mt-img="${v.key}" class="mt-input-field mt-custom-img" placeholder="https://... или загрузите файл">
                                            <button class="mt-btn-test mt-custom-img-upload" data-mt-img="${v.key}" style="margin-top:0; width:auto; padding:8px 10px;" title="Загрузить файл"><i class="fa-solid fa-upload"></i></button>
                                            <button class="mt-btn-test mt-custom-img-clear" data-mt-img="${v.key}" style="margin-top:0; width:auto; padding:8px 10px;" title="Убрать"><i class="fa-solid fa-xmark"></i></button>
                                        </div>
                                    </div>`).join('')}
                                    <input type="file" id="mt-custom-img-file" accept="image/*" style="display:none;">

                                    <span class="mt-label" style="margin-top:10px;">Подписи</span>
                                    <div style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:6px 10px;">
                                        ${MT_THEME_LABELS.map(v => `
                                        <div>
                                            <span class="mt-label" style="margin-top:2px; font-size:0.76em;">${v.label}${v.hint ? ` <span style="opacity:0.6;">(${v.hint})</span>` : ''}</span>
                                            <input type="text" id="mt-custom-label-${v.key}" class="mt-input-field mt-custom-label" placeholder="${v.def}">
                                        </div>`).join('')}
                                    </div>

                                    <span class="mt-label" style="margin-top:10px;">Custom CSS</span>
                                    <span class="mt-label" style="margin-top:2px; font-size:0.76em;">Идёт отдельным &lt;style&gt; — <code>@import</code> работает. Плеер: <code>.mt-player</code> (+ <code>.mt-is-playing</code> / <code>.mt-is-paused</code> / <code>.mt-is-idle</code>, <code>[data-mt-state]</code>, <code>.mt-dj-busy</code>), слоты <code>.mt-slot-bg</code> <code>.mt-slot-scene</code> <code>.mt-slot-cover</code> <code>.mt-slot-decor</code>, <code>.mt-player-header</code>, <code>.mt-cover</code>, <code>.mt-track-title</code>, <code>.mt-track-subtitle</code>, <code>.mt-progress</code>, <code>.mt-controls</code>, <code>.mt-btn-play</code>, <code>.mt-volume</code>, <code>.mt-panel</code>. Слайдеры: переменные <code>--mt-slider-*</code>. Подробно — в README. Применяется сразу (превью).</span>
                                    <textarea id="mt-custom-theme-css" class="mt-input-field" spellcheck="false" style="resize:vertical; min-height:140px; font-family:monospace; font-size:0.85em; margin-top:6px;" placeholder="#moodtube-mini-player { border-radius: 20px; }"></textarea>
                                    <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
                                        <button id="mt-custom-theme-import" class="mt-btn-test" style="margin-top:0; flex:1; min-width:110px;"><i class="fa-solid fa-file-import"></i> Импорт</button>
                                        <button id="mt-custom-theme-export" class="mt-btn-test" style="margin-top:0; flex:1; min-width:110px;"><i class="fa-solid fa-file-export"></i> Экспорт</button>
                                        <button id="mt-custom-theme-reset" class="mt-btn-test" style="margin-top:0; flex:1; min-width:110px;"><i class="fa-solid fa-rotate-left"></i> Сброс</button>
                                    </div>
                                    <input type="file" id="mt-custom-theme-file" accept=".json,application/json" style="display:none;">
                                    <span class="mt-label" style="margin-top:6px; font-size:0.74em;">Импорт принимает JSON MoodTube и JSON-темы SillyTavern (берётся custom_css и основные цвета).</span>
                                </div>
                                <hr style="border:0; border-top:1px solid rgba(255,255,255,0.05); margin:15px 0;">
                                <label class="mt-checkbox-row">
                                    <input type="checkbox" id="moodtube-setting-fab">
                                    <span>Включить плавающую кнопку</span>
                                </label>
                            </div>
                        </div>

                        <!-- API -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="api">
                                <i class="fa-solid fa-plug"></i>
                                <h4>API Настройки</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-api">
                                <span class="mt-label" style="margin-top:0;">Источник воспроизведения</span>
                                <select id="moodtube-playback-source" class="mt-input-field">
                                    <option value="youtube">YouTube (По умолчанию)</option>
                                    <option value="spotify">Spotify (Premium SDK)</option>
                                </select>
                                
                                <div id="moodtube-spotify-settings" style="display:none; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; margin-top: 10px; border: 1px solid var(--mt-border);">
                                    <span class="mt-label" style="margin-top:0; color:var(--mt-accent);"><i class="fa-brands fa-spotify"></i> Spotify Настройки</span>
                                    <span class="mt-label">Client ID</span>
                                    <input type="text" id="moodtube-spotify-client-id" class="mt-input-field" placeholder="Client ID">
                                    <span class="mt-label" style="margin-top:8px;">Точный Redirect URI (скопируйте в Dashboard)</span>
                                    <div style="display:flex; gap: 8px; margin-top:4px;">
                                        <input type="text" id="moodtube-spotify-redirect-show" class="mt-input-field" readonly style="flex:1; background:rgba(0,0,0,0.4); color:#9CA3AF;">
                                        <button id="moodtube-btn-copy-redirect" class="mt-btn-test" style="margin-top:0; width:auto; padding: 8px 12px;" title="Скопировать"><i class="fa-regular fa-copy"></i></button>
                                    </div>
                                    <button id="moodtube-btn-spotify-auth" class="mt-btn-test" style="margin-top: 10px;">Авторизоваться</button>
                                    <div id="moodtube-spotify-status" style="margin-top: 8px; font-size: 0.85em; color: #9CA3AF;"></div>
                                </div>
                                
                                <hr style="border:0; border-top:1px solid rgba(255,255,255,0.05); margin:15px 0;">

                                <span class="mt-label" style="margin-top:0;">Количество треков для генерации за раз</span>
                                <input type="number" id="moodtube-bulk-count" value="10" min="1" max="30" class="mt-input-field" style="width: 100px;">
                                
                                <hr style="border:0; border-top:1px solid rgba(255,255,255,0.05); margin:15px 0;">

                                <span class="mt-label">Профиль подключения</span>
                                <div style="display: flex; gap: 8px;">
                                    <select id="moodtube-api-profile-select" class="mt-input-field" style="flex: 1; padding: 8px;"></select>
                                    <button id="moodtube-btn-sync-profiles" class="mt-btn-test" style="margin-top: 0; width: auto; padding: 8px 12px;" title="Синхронизировать"><i class="fa-solid fa-arrows-rotate"></i></button>
                                </div>
                                <button id="moodtube-btn-test-profile" class="mt-btn-test" style="margin-top: 10px;">Проверить соединение</button>
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

                        <!-- БАН-ЛИСТ -->
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
                        
                        <!-- ИЗБРАННОЕ -->
                        <div class="mt-category">
                            <div class="mt-cat-title" data-mt-cat="favorites">
                                <i class="fa-solid fa-heart"></i>
                                <h4>Избранные треки</h4>
                                <i class="fa-solid fa-chevron-down mt-chevron"></i>
                            </div>
                            <div class="mt-cat-content" id="mt-cat-favorites">
                                <label class="mt-checkbox-row">
                                    <input type="checkbox" id="moodtube-setting-favorites-context">
                                    <span>Отправлять список избранного в контекст ИИ</span>
                                </label>
                                <span class="mt-label" style="margin-top:10px;">Список ваших любимых треков</span>
                                <textarea id="moodtube-setting-favorites-list" class="mt-input-field" style="resize:vertical; min-height:80px;"></textarea>
                            </div>
                        </div>

                        <!-- КАСТОМ / СВОИ ТЕГИ -->
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
                                
                                <span class="mt-label" style="margin-top:0; color:#ccc;">Жесткое правило (Hard Rule) для промпта</span>
                                <span class="mt-label" style="margin-top:4px; font-size:0.78em;">Команда, заставляющая ИИ включить то, что вы написали в чате</span>
                                <input type="text" id="moodtube-setting-hard-rule" class="mt-input-field" placeholder='[OOC: Start the music: {"Title": "_", "Artist": "_"}]'>

                                <hr style="border:0; border-top:1px solid rgba(255,255,255,0.05); margin:15px 0;">

                                <span class="mt-label" style="margin-top:0; color:#ccc;">Кастомный промпт (заменяет стандартный полностью)</span>
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

        // --- FAB (Плавающая кнопка) ---
        function getFabPos() {
            let sPos = { left: window.innerWidth - 80, top: window.innerHeight - 150 };
            try { const st = localStorage.getItem('moodtube_fab_pos'); if (st) sPos = JSON.parse(st); } catch(e){}
            return sPos;
        }

        function restoreFabStandalone($fab) {
            const sPos = getFabPos();
            // Inline остаются только координаты (и display от show/hide), остальное — в классах .mt-fab
            const display = $fab[0].style.display;
            $fab.removeClass('mt-fab-docked').attr('style', '').css({
                left: Math.max(0, Math.min(sPos.left, window.innerWidth - 60)) + 'px',
                top: Math.max(0, Math.min(sPos.top, window.innerHeight - 60)) + 'px',
            });
            if (display) $fab[0].style.display = display;
        }

        function createFab() {
            if ($('#moodtube-fab').length === 0) {
                $(`
                <div id="moodtube-fab" class="moodtube-ctrl mt-fab mt-is-idle" data-mt-state="idle">
                    <i class="fa-solid fa-play mt-fab-icon" id="moodtube-fab-icon"></i>
                </div>
                `).appendTo('body');
                
                restoreFabStandalone($('#moodtube-fab'));

                const el = document.getElementById('moodtube-fab');
                let isDragging = false;
                let startX, startY, initialLeft, initialTop;
                let currentDx = 0, currentDy = 0;
                let rafId = null;
                let fabPressTimer = null;
                let fabLongPressed = false;
                let wasDragged = false;

                const dragStart = (e) => {
                    if (e.type === 'mousedown' && e.button !== 0) return;
                    if (el.closest('.DA-floating-window')) return; // Не таскаем кнопку отдельно, если она в DreamAlbum
                    isDragging = false;
                    wasDragged = false;
                    const event = e.type.startsWith('touch') ? e.touches[0] : e;
                    startX = event.clientX; startY = event.clientY;
                    initialLeft = el.offsetLeft; initialTop = el.offsetTop;
                    currentDx = 0; currentDy = 0;
                    el.classList.add('mt-is-dragging');
                };

                const dragMove = (e) => {
                    if (startX === undefined) return;
                    const event = e.type.startsWith('touch') ? e.touches[0] : e;
                    const dx = event.clientX - startX;
                    const dy = event.clientY - startY;
                    
                    if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
                        isDragging = true;
                        wasDragged = true;
                        clearTimeout(fabPressTimer);
                    }
                    
                    if (isDragging) {
                        if (e.cancelable) e.preventDefault();
                        let newLeft = Math.max(0, Math.min(initialLeft + dx, window.innerWidth - el.offsetWidth));
                        let newTop = Math.max(0, Math.min(initialTop + dy, window.innerHeight - el.offsetHeight));
                        currentDx = newLeft - initialLeft;
                        currentDy = newTop - initialTop;
                        
                        if (rafId) cancelAnimationFrame(rafId);
                        rafId = requestAnimationFrame(() => {
                            el.style.transform = `translate3d(${currentDx}px, ${currentDy}px, 0)`;
                            document.body.classList.add('moodtube-no-select');
                        });
                    }
                };

                const dragEnd = (e) => {
                    if (startX === undefined) return;
                    startX = undefined;
                    if (rafId) cancelAnimationFrame(rafId);
                    el.classList.remove('mt-is-dragging');
                    document.body.classList.remove('moodtube-no-select');
                    
                    if (isDragging) {
                        el.style.transform = 'none';
                        el.style.left = (initialLeft + currentDx) + 'px';
                        el.style.top = (initialTop + currentDy) + 'px';
                        localStorage.setItem('moodtube_fab_pos', JSON.stringify({ left: initialLeft + currentDx, top: initialTop + currentDy }));
                        isDragging = false;
                        setTimeout(() => { wasDragged = false; }, 300);
                    }
                };

                el.addEventListener('mousedown', dragStart, { passive: false });
                el.addEventListener('touchstart', dragStart, { passive: false });
                document.addEventListener('mousemove', dragMove, { passive: false });
                document.addEventListener('touchmove', dragMove, { passive: false });
                document.addEventListener('mouseup', dragEnd);
                document.addEventListener('touchend', dragEnd);
                document.addEventListener('touchcancel', dragEnd);
                el.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                });
                
                el.addEventListener('pointerdown', (e) => {
                    fabLongPressed = false;
                    fabPressTimer = setTimeout(() => {
                        if (!isDragging && !wasDragged) {
                            fabLongPressed = true;
                            isPlayerFolded = !isPlayerFolded;
                            updatePlayerVisibility();
                        }
                    }, 750);
                });
                el.addEventListener('pointerup', () => clearTimeout(fabPressTimer));
                el.addEventListener('pointerleave', () => clearTimeout(fabPressTimer));
                
                el.addEventListener('click', (e) => {
                    clearTimeout(fabPressTimer);
                    if (isDragging || wasDragged || fabLongPressed) { 
                        e.preventDefault(); e.stopPropagation(); 
                        fabLongPressed = false;
                        wasDragged = false;
                    }
                    else { $('#moodtube-btn-playpause').trigger('click'); }
                }, true);

                const isPaused = $('#moodtube-btn-playpause').hasClass('fa-pause');
                $('#moodtube-fab-icon').attr('class', isPaused ? 'fa-solid fa-pause mt-fab-icon' : 'fa-solid fa-play mt-fab-icon');
            }
            return $('#moodtube-fab');
        }

        // Авто-стыковка с DreamAlbum и авто-восстановление
        setInterval(() => {
            const fabEnabled = localStorage.getItem('moodtube_fab_enable') !== 'false';
            const $fab = createFab(); // Гарантируем, что элемент существует в DOM
            const $daContainer = $('#DA-floating-container');
            
            let isDaLinked = false;
            try {
                const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : (typeof getContext !== 'undefined' ? getContext() : null);
                isDaLinked = stContext?.extensionSettings?.DreamAlbum?.moodtube_link === true;
            } catch (e) {}
            
            if ($daContainer.length > 0 && isDaLinked) {
                if (!$fab.parent().hasClass('DA-floating-window')) {
                    $('#DA-moodtube-placeholder').hide();
                    const display = $fab[0].style.display;
                    $fab.addClass('mt-fab-docked').attr('style', '');
                    if (display) $fab[0].style.display = display;
                    $daContainer.find('.DA-floating-window').append($fab);
                }
            } else {
                if (!$fab.parent().is('body')) {
                    restoreFabStandalone($fab);
                    $('body').append($fab);
                }
            }

            if (fabEnabled) $fab.show(); else $fab.hide();
        }, 200);
        
        // --- Spotify Init ---
        handleSpotifyCallback();
        window.addEventListener('storage', (e) => {
            if (e.key === 'moodtube_spotify_token' && e.newValue) {
                toastr.success("Spotify успешно подключен!");
                $('#moodtube-spotify-status').html('<span style="color:#1DB954;">Авторизован ✓</span>');
                $('#moodtube-btn-spotify-auth').text('Переавторизоваться');
                if ($('#moodtube-playback-source').val() === 'spotify') initSpotifyPlayer();
            }
        });
        const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
        if (source === 'spotify') initSpotifyPlayer();
        
        $('#moodtube-playback-source').on('change', function() {
            if ($(this).val() === 'spotify') $('#moodtube-spotify-settings').slideDown();
            else $('#moodtube-spotify-settings').slideUp();
        });
        
        $('#moodtube-btn-spotify-auth').off('click').on('click', () => {
            $('#moodtube-btn-spotify-auth').prop('disabled', true);
            authSpotify();
            setTimeout(() => $('#moodtube-btn-spotify-auth').prop('disabled', false), 2000);
        });
        
        $('#moodtube-spotify-redirect-show').val(window.location.origin + '/');
        $('#moodtube-btn-copy-redirect').off('click').on('click', () => {
            const uri = window.location.origin + '/';
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(uri).then(() => toastr.success("Redirect URI скопирован!"));
            } else {
                const textArea = document.createElement("textarea");
                textArea.value = uri;
                textArea.style.position = "fixed";
                textArea.style.left = "-9999px";
                document.body.appendChild(textArea);
                textArea.select();
                try {
                    document.execCommand('copy');
                    toastr.success("Redirect URI скопирован (Fallback)!");
                } catch (err) {
                    toastr.error("Копирование заблокировано браузером (нужен HTTPS). Скопируйте вручную из поля.");
                }
                document.body.removeChild(textArea);
            }
        });
        
        $('<style>.moodtube-no-select { user-select: none !important; }</style>').appendTo('head');

        // Синхронизация иконки FAB с главной кнопкой
        const observerBtn = new MutationObserver((mutations) => {
            for(let mutation of mutations) {
                if(mutation.attributeName === 'class') {
                    const isPaused = $('#moodtube-btn-playpause').hasClass('fa-pause');
                    $('#moodtube-fab-icon').attr('class', isPaused ? 'fa-solid fa-pause mt-fab-icon' : 'fa-solid fa-play mt-fab-icon');
                    if (isPaused) $('#moodtube-fab').addClass('mt-playing'); else $('#moodtube-fab').removeClass('mt-playing');
                }
            }
        });
        observerBtn.observe($('#moodtube-btn-playpause')[0], { attributes: true });


        $('#moodtube-btn-playpause').on('click', async () => {
            const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
            if (source === 'spotify') {
                const wasPlaying = isCurrentlyPlaying;
                
                const track = trackQueue[currentQueueIndex];
                if (!wasPlaying && track && track.videoId && track.videoId.startsWith('spotify:') && (!currentSpotifyTrackId || !track.videoId.includes(currentSpotifyTrackId))) {
                    playTrack(track);
                    return;
                }

                if (spotifyPlayer && isSpotifyReady) {
                    if (wasPlaying) spotifyPlayer.pause();
                    else spotifyPlayer.resume();
                }
                const token = await refreshSpotifyToken();
                if (token) {
                    const deviceParam = spotifyDeviceId ? `?device_id=${spotifyDeviceId}` : '';
                    if (wasPlaying) {
                        fetch('https://api.spotify.com/v1/me/player/pause' + deviceParam, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
                            .then(res => { if (!res.ok) res.json().then(data => toastr.error("Spotify: " + (data.error?.message || "Ошибка паузы"))); })
                            .catch(()=>{});
                        isCurrentlyPlaying = false;
                        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
                    } else {
                        fetch('https://api.spotify.com/v1/me/player/play' + deviceParam, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
                            .then(res => { if (!res.ok) res.json().then(data => toastr.error("Spotify: " + (data.error?.message || "Ошибка воспроизведения"))); })
                            .catch(()=>{});
                        isCurrentlyPlaying = true;
                        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
                    }
                }
            } else if (isUsingAudioFallback && audioFallback) {
                if (isCurrentlyPlaying) audioFallback.pause();
                else audioFallback.play();
            } else if (ytPlayer) {
                if (isCurrentlyPlaying) ytPlayer.pauseVideo();
                else ytPlayer.playVideo();
            }
        });

        $('#moodtube-btn-next').on('click', async () => {
            const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
            if (source === 'spotify' && window.isSpotifyPlaylistActive) {
                const token = await refreshSpotifyToken();
                if (token) fetch('https://api.spotify.com/v1/me/player/next', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(()=>{});
                return;
            }
            playNextInQueue();
        });

        $('#moodtube-btn-prev').on('click', async () => {
            const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
            if (source === 'spotify' && window.isSpotifyPlaylistActive) {
                const token = await refreshSpotifyToken();
                if (token) fetch('https://api.spotify.com/v1/me/player/previous', { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(()=>{});
                return;
            }
            playPrevInQueue();
        });
        
        $('#moodtube-btn-favorite').on('click', async () => {
            if (currentQueueIndex >= 0 && currentQueueIndex < trackQueue.length) {
                const track = trackQueue[currentQueueIndex];
                const trackName = `${track.title} ${track.artist || track.Artist || ''}`.trim();
                let favList = getMtSetting('favorites');
                
                if (!favList.includes(trackName)) {
                    favList = favList ? favList + ', ' + trackName : trackName;
                    saveMtSetting('favorites', favList);
                    $('#moodtube-setting-favorites-list').val(favList);
                    
                    $('#moodtube-btn-favorite').removeClass('fa-regular').addClass('fa-solid');
                    toastr.success(`Трек добавлен в Избранное (ИИ)`);
                } else {
                    toastr.info(`Трек уже в Избранном (ИИ)`);
                }
                
                const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
                if (source === 'spotify' && track.videoId && track.videoId.startsWith('spotify:track:')) {
                    const spotifyId = track.videoId.split(':')[2];
                    const token = await refreshSpotifyToken();
                    if (token) {
                        try {
                            const uriParam = encodeURIComponent(`spotify:track:${spotifyId}`);
                            const res = await fetch(`https://api.spotify.com/v1/me/library?uris=${uriParam}`, {
                                method: 'PUT',
                                headers: { Authorization: `Bearer ${token}` }
                            });
                            if (res.ok) {
                                toastr.success("Трек сохранен в любимые Spotify");
                            } else {
                                const err = await res.json().catch(()=>({}));
                                toastr.error("Spotify: " + (err.error?.message || "Ошибка сохранения в любимые"));
                            }
                        } catch(e) { console.error(e); }
                    }
                }
            } else {
                toastr.warning(`Нет активного трека`);
            }
        });

        // Функция форматирования времени
        const formatTime = (time) => {
            if (isNaN(time)) return "0:00";
            const min = Math.floor(time / 60);
            const sec = Math.floor(time % 60);
            return `${min}:${sec < 10 ? '0' : ''}${sec}`;
        };

        // Обновление прогресс-бара
        setInterval(() => {
            let current = 0;
            let total = 0;
            
            if (localStorage.getItem('moodtube_playback_source') === 'spotify' && typeof spotifyPlayer !== 'undefined' && spotifyPlayer) {
                spotifyPlayer.getCurrentState().then(state => {
                    if (state) {
                        const current = state.position / 1000;
                        const total = state.duration / 1000;
                        if (total > 0) {
                            $('#moodtube-time-current').text(formatTime(current));
                            $('#moodtube-time-total').text(formatTime(total));
                            if (!$('#moodtube-progress-slider').is(':active')) {
                                $('#moodtube-progress-slider').val((current / total) * 100);
                            }
                            if (!window.isSpotifyPlaylistActive && !window.mtSkipTimeout && current > 0 && total - current <= 1.5 && !state.paused) {
                                window.mtSkipTimeout = true;
                                setTimeout(() => window.mtSkipTimeout = false, 5000);
                                isCurrentlyPlaying = false;
                                try { spotifyPlayer.pause(); } catch(e){}
                                setTimeout(playNextInQueue, 300);
                            }
                        }
                    }
                });
                return;
            }
            
            if (!isCurrentlyPlaying) return;

            if (isUsingAudioFallback && audioFallback) {
                current = audioFallback.currentTime || 0;
                total = audioFallback.duration || 0;
            } else if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function' && typeof ytPlayer.getDuration === 'function') {
                current = ytPlayer.getCurrentTime() || 0;
                total = ytPlayer.getDuration() || 0;
            }
            
            if (total > 0) {
                $('#moodtube-time-current').text(formatTime(current));
                $('#moodtube-time-total').text(formatTime(total));
                if (!$('#moodtube-progress-slider').is(':active')) {
                    $('#moodtube-progress-slider').val((current / total) * 100);
                }
            }
        }, 1000);

        $('#moodtube-progress-slider').on('input change', function() {
            const val = $(this).val();
            let total = 0;
            const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
            
            if (source === 'spotify' && typeof spotifyPlayer !== 'undefined' && spotifyPlayer) {
                spotifyPlayer.getCurrentState().then(state => {
                    if (state) {
                        total = state.duration;
                        if (total > 0) spotifyPlayer.seek((val / 100) * total);
                    }
                });
            } else if (isUsingAudioFallback && audioFallback) {
                total = audioFallback.duration || 0;
                if (total > 0) audioFallback.currentTime = (val / 100) * total;
            } else if (ytPlayer && typeof ytPlayer.getDuration === 'function' && typeof ytPlayer.seekTo === 'function') {
                total = ytPlayer.getDuration() || 0;
                if (total > 0) ytPlayer.seekTo((val / 100) * total, true);
            }
        });
        
        $('#moodtube-btn-queue').on('click', () => {
            $('#moodtube-inner-content').hide();
            $('#moodtube-btn-close').hide();
            $('#moodtube-queue-container').css('display', 'flex');
            const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
            if (source === 'spotify') $('#moodtube-btn-spotify-playlists').show();
            else $('#moodtube-btn-spotify-playlists').hide();
            updateQueueUI();
        });

        $('#moodtube-btn-close-queue').on('click', () => {
            $('#moodtube-queue-container').hide();
            $('#moodtube-inner-content').css('display', '');
            $('#moodtube-btn-close').show();
        });

        $('#moodtube-btn-spotify-playlists').on('click', () => {
            showSpotifyPlaylists();
        });

        $('#moodtube-btn-close-playlists').on('click', () => {
            $('#moodtube-spotify-playlists-container').hide();
            $('#moodtube-queue-container').css('display', 'flex');
        });

        $('#moodtube-btn-clear-queue').on('click', () => {
            trackQueue = [];
            currentQueueIndex = -1;
            if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
            if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
            isCurrentlyPlaying = false;
            $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
            $('#moodtube-widget-title').text('Очередь пуста');
            $('#moodtube-widget-cover').attr('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
            updateQueueUI();
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

        // --- API Profiles ---
        let activeProfileName = '';
        
        function loadProfiles() {
            const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : getContext();
            const profiles = stContext?.extensionSettings?.connectionManager?.profiles || [];
            
            activeProfileName = localStorage.getItem('moodtube_active_profile_name') || '';
            
            const $sel = $('#moodtube-api-profile-select');
            $sel.empty();
            
            // Default option: use SillyTavern's main API via generateRaw
            $sel.append($('<option>', { value: '', text: 'Главный API Таверны' }));
            
            profiles.forEach(p => {
                $sel.append($('<option>', { value: p.name, text: p.name }));
            });
            
            if (activeProfileName && profiles.find(p => p.name === activeProfileName)) {
                $sel.val(activeProfileName);
            } else if (!activeProfileName) {
                $sel.val('');
            } else {
                // Saved profile no longer exists, reset to tavern default
                activeProfileName = '';
                $sel.val('');
            }
        }

        $('#moodtube-api-profile-select').on('change', function() {
            activeProfileName = $(this).val();
            localStorage.setItem('moodtube_active_profile_name', activeProfileName);
        });

        $('#moodtube-btn-sync-profiles').on('click', () => {
            loadProfiles();
            toastr.success('Профили API синхронизированы!');
        });

        $('#moodtube-btn-test-profile').on('click', async () => {
            const stContext = typeof SillyTavern !== 'undefined' ? SillyTavern.getContext() : getContext();
            
            const oldText = $('#moodtube-btn-test-profile').text();
            $('#moodtube-btn-test-profile').text('⏳').prop('disabled', true);
            
            try {
                if (!activeProfileName) {
                    // Test tavern's main API via generateRaw
                    console.log(`${LOG_PREFIX} Testing Tavern main API via generateRaw...`);
                    const result = await generateRaw({ prompt: 'respond with "ok"', systemPrompt: '' });
                    if (result) {
                        toastr.success("Соединение с главным API Таверны успешно!");
                    } else {
                        toastr.error("Главный API Таверны не ответил.");
                    }
                } else {
                    const profiles = stContext?.extensionSettings?.connectionManager?.profiles || [];
                    const profile = profiles.find(p => p.name === activeProfileName);
                    if (!profile) return toastr.warning(`Профиль '${activeProfileName}' не найден.`);

                    const cc_source = profile.api || 'openai';
                    let generate_data = {
                        'messages': [{ role: 'user', content: 'respond with "ok"' }],
                        'model': profile.model,
                        'temperature': 0.3,
                        'stream': false,
                        'chat_completion_source': cc_source,
                    };
                    
                    const profileApiValue = profile['api-url'];
                    if (cc_source === 'custom' && profileApiValue) {
                        generate_data['custom_url'] = profileApiValue.trim().replace(/\/+$/, '');
                        const ccSettings = stContext.chatCompletionSettings || {};
                        if (ccSettings.custom_prompt_post_processing) generate_data['custom_prompt_post_processing'] = ccSettings.custom_prompt_post_processing;
                        if (ccSettings.custom_include_body) generate_data['custom_include_body'] = ccSettings.custom_include_body;
                        if (ccSettings.custom_exclude_body) generate_data['custom_exclude_body'] = ccSettings.custom_exclude_body;
                        if (ccSettings.custom_include_headers) generate_data['custom_include_headers'] = ccSettings.custom_include_headers;
                    } else if (cc_source === 'vertexai' && profileApiValue) {
                        generate_data['vertexai_region'] = profileApiValue;
                        const ccSettings = stContext.chatCompletionSettings || {};
                        if (ccSettings.vertexai_auth_mode) generate_data['vertexai_auth_mode'] = ccSettings.vertexai_auth_mode;
                        if (ccSettings.vertexai_express_project_id) generate_data['vertexai_express_project_id'] = ccSettings.vertexai_express_project_id;
                    } else if (cc_source === 'zai' && profileApiValue) {
                        generate_data['zai_endpoint'] = profileApiValue;
                    }

                    const headers = (typeof stContext.getRequestHeaders === 'function') ? stContext.getRequestHeaders() : {'Content-Type': 'application/json'};
                    const res = await fetch('/api/backends/chat-completions/generate', {
                        method: 'POST',
                        headers: headers,
                        body: JSON.stringify(generate_data)
                    });
                    
                    if (res.ok) {
                        toastr.success(`Соединение с профилем '${activeProfileName}' успешно!`);
                    } else {
                        const err = await res.json().catch(() => ({error: {message: "Unknown error"}}));
                        toastr.error(`Ошибка: ${res.status} - ${err.error?.message || 'Check console'}`);
                    }
                }
            } catch (e) {
                console.error(e);
                toastr.error(`Ошибка сети: ${e.message}`);
            } finally {
                $('#moodtube-btn-test-profile').text(oldText).prop('disabled', false);
            }
        });

        // --- Open settings ---
        $('#moodtube-btn-settings').on('click', () => {
            $('#mt-settings-modal').css('display', 'block');
            
            loadProfiles();

            // Load plain inputs
            $('#moodtube-setting-theme').val(localStorage.getItem('moodtube_theme') || 'blue');
            fillCustomThemeForm(loadCustomTheme());
            toggleCustomThemeBlock();
            $('#moodtube-playback-source').val(localStorage.getItem('moodtube_playback_source') || 'youtube').trigger('change');
            $('#moodtube-spotify-client-id').val(localStorage.getItem('moodtube_spotify_client_id') || '');
            const spotToken = localStorage.getItem('moodtube_spotify_token');
            if (spotToken) {
                $('#moodtube-spotify-status').html('<span style="color:#1DB954;">Авторизован ✓</span>');
                $('#moodtube-btn-spotify-auth').text('Переавторизоваться');
            } else {
                $('#moodtube-spotify-status').html('Не авторизован');
                $('#moodtube-btn-spotify-auth').text('Авторизоваться в Spotify');
            }
            $('#moodtube-bulk-count').val(localStorage.getItem('moodtube_ai_bulk_count') || '10');
            $('#moodtube-setting-fab').prop('checked', localStorage.getItem('moodtube_fab_enable') !== 'false');
            
            let bs = localStorage.getItem('moodtube_global_banned_songs');
            if (bs === null) bs = getMtSetting('banned_songs') || '';
            $('#moodtube-setting-banned-songs').val(bs);
            $('#moodtube-setting-banlist').val(getMtSetting('banlist'));
            $('#moodtube-setting-favorites-list').val(getMtSetting('favorites'));
            $('#moodtube-setting-favorites-context').prop('checked', getMtSetting('favorites_context') === 'true');
            $('#moodtube-setting-hard-rule').val(getMtSetting('hard_rule'));
            $('#moodtube-setting-custom').val(getMtSetting('custom'));

            // Restore active tags from localStorage
            const savedGenres = getMtSetting('genre').split(',').map(s => s.trim()).filter(Boolean);
            const savedScenario = getMtSetting('scenario').split(',').map(s => s.trim()).filter(Boolean);

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
            // Откат несохранённого превью темы
            applyTheme(localStorage.getItem('moodtube_theme') || 'blue');
        });

        // --- Custom theme ---
        const previewCustomTheme = () => {
            if ($('#moodtube-setting-theme').val() !== 'custom') return;
            const draft = readCustomThemeForm();
            applyCustomThemeCss(draft);
            applyThemeLabels(draft);
        };
        $('#moodtube-setting-theme').on('change', () => {
            const theme = $('#moodtube-setting-theme').val();
            toggleCustomThemeBlock();
            document.documentElement.setAttribute('data-mt-theme', theme);
            $('#mt-settings-modal, #moodtube-mini-player').attr('data-mt-theme', theme);
            const draft = theme === 'custom' ? readCustomThemeForm() : null;
            applyCustomThemeCss(draft);
            applyThemeLabels(draft);
        });
        // Картинки темы: URL вручную, загрузка файла или очистка
        let pendingImageKey = null;
        $(document).on('input', '.mt-custom-img', function() {
            if ($(this).prop('readonly')) return;
            setCustomImageField($(this).data('mt-img'), $(this).val());
            previewCustomTheme();
        });
        $(document).on('click', '.mt-custom-img-upload', function(e) {
            e.preventDefault();
            pendingImageKey = $(this).data('mt-img');
            $('#mt-custom-img-file').val('').trigger('click');
        });
        $('#mt-custom-img-file').on('change', function() {
            if (pendingImageKey) loadCustomImageFile(pendingImageKey, this.files && this.files[0], previewCustomTheme);
        });
        $(document).on('click', '.mt-custom-img-clear', function(e) {
            e.preventDefault();
            setCustomImageField($(this).data('mt-img'), '');
            previewCustomTheme();
        });
        $(document).on('input', '.mt-custom-label', previewCustomTheme);
        $(document).on('input', '#mt-custom-theme-name, #mt-custom-theme-css, .mt-custom-var', function() {
            if ($(this).hasClass('mt-custom-var')) {
                const key = this.id.replace('mt-custom-var-', '');
                const val = String($(this).val()).trim();
                if (/^#[0-9a-f]{6}$/i.test(val)) $(`#mt-custom-pick-${key}`).val(val);
            }
            previewCustomTheme();
        });
        $(document).on('input', '.mt-custom-pick', function() {
            $(`#mt-custom-var-${$(this).data('mt-var')}`).val($(this).val());
            previewCustomTheme();
        });
        // Tab в редакторе CSS вставляет отступ, а не уводит фокус
        $('#mt-custom-theme-css').on('keydown', function(e) {
            if (e.key !== 'Tab') return;
            e.preventDefault();
            const el = this, start = el.selectionStart, end = el.selectionEnd;
            el.value = el.value.substring(0, start) + '    ' + el.value.substring(end);
            el.selectionStart = el.selectionEnd = start + 4;
            previewCustomTheme();
        });
        $('#mt-custom-theme-import').on('click', () => $('#mt-custom-theme-file').val('').trigger('click'));
        $('#mt-custom-theme-file').on('change', function() {
            importCustomThemeFile(this.files && this.files[0]);
        });
        $('#mt-custom-theme-export').on('click', exportCustomTheme);
        $('#mt-custom-theme-reset').on('click', () => {
            if (!confirm('Сбросить кастомную тему к значениям по умолчанию?')) return;
            fillCustomThemeForm(getDefaultCustomTheme());
            previewCustomTheme();
        });

        // --- Save settings ---
        $('#moodtube-btn-save-settings').on('click', () => {
            activeProfileName = $('#moodtube-api-profile-select').val();
            localStorage.setItem('moodtube_active_profile_name', activeProfileName);
            
            const theme = $('#moodtube-setting-theme').val();
            localStorage.setItem('moodtube_theme', theme);
            saveCustomTheme(readCustomThemeForm());
            applyTheme(theme);
            
            const source = $('#moodtube-playback-source').val();
            localStorage.setItem('moodtube_playback_source', source);
            localStorage.setItem('moodtube_spotify_client_id', $('#moodtube-spotify-client-id').val().trim());
            if (source === 'spotify') initSpotifyPlayer();
            
            const fabEnabled = $('#moodtube-setting-fab').is(':checked');
            localStorage.setItem('moodtube_fab_enable', fabEnabled ? 'true' : 'false');
            if (fabEnabled) $('#moodtube-fab').show(); else $('#moodtube-fab').hide();
            
            localStorage.setItem('moodtube_ai_bulk_count', $('#moodtube-bulk-count').val());

            // Collect genres: active tags + custom input
            const genreTags = [];
            $('#mt-cat-genre .mt-genre-tag.active').each(function() { genreTags.push($(this).text()); });
            const genreCustom = $('#mt-genre-custom').val().trim();
            if (genreCustom) genreTags.push(...genreCustom.split(',').map(s => s.trim()).filter(Boolean));
            saveMtSetting('genre', genreTags.join(', '));

            // Collect scenario: mood tags + scenario tags + custom input
            const scenarioTags = [];
            $('#mt-cat-mood .mt-mood-tag.active').each(function() { scenarioTags.push($(this).text()); });
            $('#mt-cat-scenario .mt-scenario-tag.active').each(function() { scenarioTags.push($(this).text()); });
            const scenarioCustom = $('#mt-scenario-custom').val().trim();
            if (scenarioCustom) scenarioTags.push(...scenarioCustom.split(',').map(s => s.trim()).filter(Boolean));
            saveMtSetting('scenario', scenarioTags.join(', '));

            saveMtSetting('banlist', $('#moodtube-setting-banlist').val().trim());
            localStorage.setItem('moodtube_global_banned_songs', $('#moodtube-setting-banned-songs').val().trim());
            saveMtSetting('favorites', $('#moodtube-setting-favorites-list').val().trim());
            saveMtSetting('favorites_context', $('#moodtube-setting-favorites-context').is(':checked') ? 'true' : 'false');
            saveMtSetting('hard_rule', $('#moodtube-setting-hard-rule').val().trim());
            saveMtSetting('custom', $('#moodtube-setting-custom').val().trim());

            toastr.success("Настройки MoodTube сохранены");
            $('#mt-settings-modal').hide();
        });

        $('#moodtube-btn-close').on('click', () => {
            isPlayerFolded = true;
            updatePlayerVisibility();
        });

        if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined') {
            eventSource.on(event_types.CHAT_CHANGED, () => {
                setTimeout(() => {
                    restoreQueueCache();
                    if ($('#mt-settings-modal').is(':visible')) {
                        $('#moodtube-btn-settings').trigger('click');
                    }
                }, 200);
            });
            eventSource.on(event_types.CHAT_CLOSED, () => {
                currentLoadedChatId = null;
                clearQueueState(true);
                const $fab = $('#moodtube-fab');
                if ($fab.length && !$fab.parent().is('body')) {
                    restoreFabStandalone($fab);
                    $('body').append($fab);
                }
            });
        }
        
        $('#moodtube-btn-ai').on('click', async () => { await triggerMoodAnalysisAndPlay(); });

        $('#moodtube-vol-slider').on('input', function() {
            currentVolume = $(this).val();
            if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
                ytPlayer.setVolume(currentVolume);
            }
            if (audioFallback) {
                audioFallback.volume = currentVolume / 100;
                if (typeof spotifyPlayer !== 'undefined' && spotifyPlayer) spotifyPlayer.setVolume(currentVolume / 100);
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

        // Состояние «играет/пауза/нет трека» для тем. Код плеера перезаписывает class у кнопки play,
        // поэтому возвращаем её классы и пересчитываем состояние при каждом изменении.
        const playBtn = document.getElementById('moodtube-btn-playpause');
        const stateObserver = new MutationObserver(() => {
            if (!playBtn.classList.contains('mt-btn-play')) playBtn.classList.add('mt-btn', 'mt-btn-play');
            syncPlayerState();
        });
        stateObserver.observe(playBtn, { attributes: true, attributeFilter: ['class'] });
        stateObserver.observe(document.getElementById('moodtube-widget-title'), { childList: true, characterData: true, subtree: true });
    }
    applyTheme(localStorage.getItem('moodtube_theme') || 'blue');
    updatePlayerVisibility();
    restoreQueueCache();
    startBackgroundPrefetch();
}

$(document).ready(() => { setTimeout(initializeExtension, 1500); });

// ============================================================
//  Публичный API для сторонних расширений (NOVA / Link).
//  Только новые функции — существующий код не изменяется.
// ============================================================

function enqueueMany(queries) {
    if (!Array.isArray(queries)) queries = [queries];
    queries
        .filter(q => typeof q === 'string' && q.trim())
        .forEach(q => enqueueQuery(q.trim()));
}

function getCurrentTrack() {
    return trackQueue[currentQueueIndex] || null;
}

function isPlaying() {
    return isCurrentlyPlaying;
}

// Кнопки дёргаем через их собственные обработчики — своей копии логики нет,
// поэтому расходиться с UI тут нечему.
function togglePlayPause() { $('#moodtube-btn-playpause').trigger('click'); }
function skipNext()        { $('#moodtube-btn-next').trigger('click'); }
function skipPrev()        { $('#moodtube-btn-prev').trigger('click'); }

function seekTo(seconds) {
    seconds = Number(seconds);
    if (!isFinite(seconds) || seconds < 0) return false;

    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
    if (source === 'spotify' && typeof spotifyPlayer !== 'undefined' && spotifyPlayer) {
        spotifyPlayer.seek(seconds * 1000);
    } else if (isUsingAudioFallback && audioFallback) {
        audioFallback.currentTime = seconds;
    } else if (ytPlayer && typeof ytPlayer.seekTo === 'function') {
        ytPlayer.seekTo(seconds, true);
    } else {
        return false;
    }
    return true;
}

// Играет немедленно, в обход очереди: трек встаёт сразу после текущего.
async function playQuery(query) {
    if (typeof query !== 'string' || !query.trim()) return false;
    query = query.trim();

    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
    let videoInfo = source === 'spotify'
        ? (await searchSpotify(query) || await searchYouTube(query))
        : await searchYouTube(query);

    if (!videoInfo || !videoInfo.videoId) return false;

    const trackObj = {
        title: videoInfo.title,
        originalQuery: query,
        videoId: videoInfo.videoId,
        videoThumbnails: videoInfo.videoThumbnails,
        isValidated: true
    };
    if (videoInfo.streamUrl) {
        trackObj.streamUrl = videoInfo.streamUrl;
        trackObj.isFallback = true;
    }

    const insertAt = Math.max(currentQueueIndex, -1) + 1;
    trackQueue.splice(insertAt, 0, trackObj);
    currentQueueIndex = insertAt;
    updateQueueUI();
    playTrack(trackObj);
    return true;
}

$(document).ready(() => {
    setTimeout(() => {
        window.MoodTubeAPI = {
            version: 4,
            enqueueQuery,
            enqueueMany,
            playTrack,
            playQuery,
            getCurrentTrack,
            togglePlayPause,
            skipNext,
            skipPrev,
            isPlaying,
            seekTo,
        };
        window.dispatchEvent(new CustomEvent('moodtube:ready', { detail: window.MoodTubeAPI }));
        console.log(`${LOG_PREFIX} MoodTubeAPI v4 готов`);
    }, 1600);
});
