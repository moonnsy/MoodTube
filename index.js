

import { getContext, extension_settings } from '../../../extensions.js';
import { generateRaw, eventSource, event_types, saveSettingsDebounced } from '../../../../script.js';

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

// ============================================================
//  ПЛЕЙЛИСТЫ MOODTUBE
//  Хранятся в extension_settings (settings.json на сервере таверны),
//  поэтому общие для всех устройств, а не в браузере.
// ============================================================
const MT_FAV_ID = 'favorites';

function mtPlStore() {
    if (!extension_settings.moodtube || typeof extension_settings.moodtube !== 'object') extension_settings.moodtube = {};
    const st = extension_settings.moodtube;
    if (!Array.isArray(st.playlists)) st.playlists = [];
    if (!st.playlists.some(p => p && p.id === MT_FAV_ID)) {
        st.playlists.unshift({ id: MT_FAV_ID, name: 'Любимые', tracks: [], createdAt: Date.now() });
    }
    st.playlists = st.playlists.filter(p => p && p.id && Array.isArray(p.tracks));
    return st.playlists;
}

function mtPlSave() {
    try { saveSettingsDebounced(); } catch (e) { console.error(`${LOG_PREFIX} Playlist save failed`, e); }
}

function mtPlGet(id) {
    return mtPlStore().find(p => p.id === id) || null;
}

function mtPlCreate(name) {
    const pl = { id: 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: String(name).trim() || 'Плейлист', tracks: [], createdAt: Date.now() };
    mtPlStore().push(pl);
    mtPlSave();
    return pl;
}

function mtPlRename(id, name) {
    const pl = mtPlGet(id);
    if (!pl || id === MT_FAV_ID || !String(name).trim()) return false;
    pl.name = String(name).trim();
    mtPlSave();
    return true;
}

function mtPlDelete(id) {
    if (id === MT_FAV_ID) return false;
    const st = mtPlStore();
    const i = st.findIndex(p => p.id === id);
    if (i < 0) return false;
    st.splice(i, 1);
    mtPlSave();
    return true;
}

// Трек из очереди → запись плейлиста. YouTube хранит videoId, Spotify — uri; query нужен,
// чтобы найти трек заново, если плейлист слушают в другом режиме.
function mtToPlaylistTrack(track) {
    if (!track) return null;
    const title = String(track.title || track.originalQuery || '').replace(/^(Ищем: |❌ Не найдено: |❌ Заблокировано: )/, '').trim();
    if (!title && !track.videoId) return null;
    const query = String(track.originalQuery || title).trim();
    const thumbnail = track.videoThumbnails?.[0]?.url || '';
    const id = String(track.videoId || '');
    if (id.startsWith('spotify:track:')) return { spotifyUri: id, title, query: title || query, thumbnail, addedAt: Date.now() };
    if (id && !id.startsWith('spotify:')) return { videoId: id, title, query, thumbnail: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, addedAt: Date.now() };
    return { title, query, thumbnail, addedAt: Date.now() };
}

function mtTrackKey(t) {
    if (!t) return '';
    if (t.videoId && !String(t.videoId).startsWith('spotify:')) return 'yt:' + t.videoId;
    if (t.spotifyUri) return 'sp:' + t.spotifyUri;
    if (t.videoId) return 'sp:' + t.videoId;
    return 'q:' + String(t.title || t.query || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function mtPlHas(pl, key) {
    return !!pl && pl.tracks.some(t => mtTrackKey(t) === key);
}

function mtPlAdd(id, plTrack) {
    const pl = mtPlGet(id);
    if (!pl || !plTrack) return false;
    if (mtPlHas(pl, mtTrackKey(plTrack))) return false;
    pl.tracks.push(plTrack);
    mtPlSave();
    return true;
}

function mtPlRemove(id, key) {
    const pl = mtPlGet(id);
    if (!pl) return false;
    const before = pl.tracks.length;
    pl.tracks = pl.tracks.filter(t => mtTrackKey(t) !== key);
    if (pl.tracks.length === before) return false;
    mtPlSave();
    return true;
}

function mtCurrentTrack() {
    return (currentQueueIndex >= 0 && currentQueueIndex < trackQueue.length) ? trackQueue[currentQueueIndex] : null;
}

// Сердечко закрашено, если текущий трек есть в «Любимых» MoodTube
function updateFavoriteButton() {
    const t = mtCurrentTrack();
    const fav = mtPlGet(MT_FAV_ID);
    const on = !!t && mtPlHas(fav, mtTrackKey(mtToPlaylistTrack(t)));
    $('#moodtube-btn-favorite').toggleClass('fa-solid', on).toggleClass('fa-regular', !on).toggleClass('mt-is-active', on);
}

// Куда сохраняют ❤ и «+» в режиме Spotify: 'both' | 'spotify' | 'moodtube'
function mtSpotifyTarget(kind) {
    const v = localStorage.getItem(kind === 'fav' ? 'moodtube_fav_target' : 'moodtube_plus_target');
    return ['both', 'spotify', 'moodtube'].includes(v) ? v : 'both';
}

async function spotifySaveToLibrary(uri) {
    const token = await refreshSpotifyToken();
    if (!token) return false;
    try {
        const res = await fetch(`https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(uri)}`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toastr.error('Spotify: ' + (err.error?.message || 'Ошибка сохранения в любимые'));
        }
        return res.ok;
    } catch (e) { console.error(e); return false; }
}

async function spotifyAddToPlaylist(playlistId, uri) {
    const token = await refreshSpotifyToken();
    if (!token) return false;
    try {
        const res = await fetch(`https://api.spotify.com/v1/playlists/${playlistId}/items?uris=${encodeURIComponent(uri)}`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toastr.error('Spotify: ' + (err.error?.message || 'Не удалось добавить'));
        }
        return res.ok;
    } catch (e) { console.error(e); return false; }
}

async function spotifyCreatePlaylist(name) {
    const userId = await fetchSpotifyUser();
    const token = await refreshSpotifyToken();
    if (!userId || !token) { toastr.error('Spotify: не удалось получить аккаунт'); return null; }
    try {
        const res = await fetch(`https://api.spotify.com/v1/me/playlists`, {
            method: 'POST',
            body: JSON.stringify({ name, public: false }),
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
            const err = await res.json().catch(() => ({}));
            toastr.error('Spotify: ' + (err.error?.message || 'Ошибка создания плейлиста'));
            return null;
        }
        const newPl = await res.json();
        let localPls = [];
        try { localPls = JSON.parse(localStorage.getItem('moodtube_local_playlists') || '[]'); } catch (e) {}
        localPls.push({ id: newPl.id, name: newPl.name });
        localStorage.setItem('moodtube_local_playlists', JSON.stringify(localPls));
        return newPl;
    } catch (e) { console.error(e); toastr.error('Сетевая ошибка при создании плейлиста'); return null; }
}

async function toggleFavoriteCurrent() {
    const track = mtCurrentTrack();
    if (!track) { toastr.warning('Нет активного трека'); return; }
    const plTrack = mtToPlaylistTrack(track);
    if (!plTrack) { toastr.warning('Трек ещё не найден'); return; }

    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
    const isSpotifyTrack = source === 'spotify' && String(track.videoId || '').startsWith('spotify:track:');
    const target = isSpotifyTrack ? mtSpotifyTarget('fav') : 'moodtube';
    const key = mtTrackKey(plTrack);
    const aiName = `${track.title} ${track.artist || track.Artist || ''}`.trim();

    // Повторное нажатие убирает из «Любимых» MoodTube (в Spotify ничего не удаляем)
    if (target !== 'spotify' && mtPlHas(mtPlGet(MT_FAV_ID), key)) {
        mtPlRemove(MT_FAV_ID, key);
        const fav = getMtSetting('favorites');
        if (fav.includes(aiName)) {
            const rest = fav.split(',').map(s => s.trim()).filter(s => s && s !== aiName).join(', ');
            saveMtSetting('favorites', rest);
            $('#moodtube-setting-favorites-list').val(rest);
        }
        updateFavoriteButton();
        toastr.info('Убрано из «Любимых» MoodTube');
        return;
    }

    const done = [];
    if (target !== 'spotify') {
        mtPlAdd(MT_FAV_ID, plTrack);
        done.push('Любимые MoodTube');
    }
    // Избранное для подсказок ИИ (как раньше)
    let favList = getMtSetting('favorites');
    if (aiName && !favList.includes(aiName)) {
        favList = favList ? favList + ', ' + aiName : aiName;
        saveMtSetting('favorites', favList);
        $('#moodtube-setting-favorites-list').val(favList);
    }
    if (target !== 'moodtube' && isSpotifyTrack) {
        if (await spotifySaveToLibrary(track.videoId)) done.push('любимые Spotify');
    }
    updateFavoriteButton();
    if (target === 'spotify' && done.length) $('#moodtube-btn-favorite').removeClass('fa-regular').addClass('fa-solid');
    if (done.length) toastr.success(`❤ Сохранено: ${done.join(' и ')}`);
}

// Слушать плейлист MoodTube: заменяет очередь его треками
function playMoodTubePlaylist(id, startIndex = 0, shuffle = false) {
    const pl = mtPlGet(id);
    if (!pl || !pl.tracks.length) { toastr.info('Плейлист пуст'); return; }
    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
    let tracks = pl.tracks.slice();
    if (shuffle) {
        for (let i = tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [tracks[i], tracks[j]] = [tracks[j], tracks[i]];
        }
        startIndex = 0;
    }
    const objs = tracks.map(t => {
        const thumbs = t.thumbnail ? [{ url: t.thumbnail }] : [];
        const query = t.query || t.title;
        if (source === 'spotify' && t.spotifyUri) return { title: t.title, originalQuery: query, videoId: t.spotifyUri, videoThumbnails: thumbs, isValidated: true };
        if (source !== 'spotify' && t.videoId) return { title: t.title, originalQuery: query, videoId: t.videoId, videoThumbnails: thumbs, isValidated: true };
        return { title: 'Ищем: ' + query, originalQuery: query, videoId: null, isSearching: true };
    });

    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') ytPlayer.stopVideo();
    if (audioFallback) { audioFallback.pause(); isUsingAudioFallback = false; }
    isCurrentlyPlaying = false;
    window.isSpotifyPlaylistActive = false;

    trackQueue = objs;
    currentQueueIndex = Math.min(Math.max(startIndex, 0), objs.length - 1);
    updateQueueUI();
    const first = objs[currentQueueIndex];
    if (first.videoId) playTrack(first);
    else $('#moodtube-widget-title').text(first.title);
    resolveQueueBackground();

    // Возвращаемся к плееру
    $('#moodtube-spotify-playlists-container').hide();
    $('#moodtube-queue-container').hide();
    $('#moodtube-inner-content').css('display', '');
    $('#moodtube-btn-close').show();
    toastr.success(`Плейлист «${pl.name}»: ${objs.length} ${shuffle ? 'треков вперемешку' : 'треков'}`);
}

// Поле ввода прямо в списке (создать / переименовать) — без системных prompt()
function mtInlineInput($anchor, { placeholder = '', value = '', okText = 'OK', onOk }) {
    $anchor.siblings('.mt-pl-inline').remove();
    const $row = $(`
        <div class="mt-pl-inline">
            <input type="text" class="mt-pl-inline-input moodtube-ctrl" autocomplete="off">
            <button class="mt-pl-inline-ok moodtube-ctrl"></button>
            <button class="mt-pl-inline-cancel moodtube-ctrl" title="Отмена"><i class="fa-solid fa-xmark"></i></button>
        </div>`);
    $row.find('input').attr('placeholder', placeholder).val(value);
    $row.find('.mt-pl-inline-ok').text(okText);
    const submit = async () => {
        const v = String($row.find('input').val() || '').trim();
        if (!v) return;
        $row.find('button').prop('disabled', true);
        const keep = await onOk(v);
        if (!keep) $row.remove();
        else $row.find('button').prop('disabled', false);
    };
    $row.find('.mt-pl-inline-ok').on('click', submit);
    $row.find('.mt-pl-inline-cancel').on('click', () => $row.remove());
    $row.find('input').on('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
        if (e.key === 'Escape') { e.preventDefault(); $row.remove(); }
    });
    $row.insertAfter($anchor);
    setTimeout(() => $row.find('input').trigger('focus'), 30);
    return $row;
}

function mtPlaylistCover(pl) {
    if (pl.id === MT_FAV_ID) return '<span class="mt-pl-cover mt-pl-cover-fav"><i class="fa-solid fa-heart"></i></span>';
    const t = pl.tracks[0];
    if (!t) return '<span class="mt-pl-cover mt-pl-cover-empty"><i class="fa-solid fa-music"></i></span>';
    return '<img class="mt-queue-thumb mt-pl-cover" alt="">';
}

function mtTracksWord(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} трек`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} трека`;
    return `${n} треков`;
}

// Режим Spotify: разделы Spotify / MoodTube превращаются во вкладки (Spotify слева, MoodTube справа)
function mtTabify($container, storageKey) {
    const $secs = $container.children('.mt-pl-section');
    if ($secs.length < 2) return;
    $container.addClass('mt-pl-tabbed');
    const $bar = $('<div class="mt-pl-tabs" role="tablist"></div>');
    $secs.each((i, sec) => {
        const $sec = $(sec);
        const kind = $sec.hasClass('mt-pl-section-spotify') ? 'spotify' : 'moodtube';
        $sec.attr('data-mt-tab', kind);
        // Заголовок раздела без кнопки «Создать» во вкладках не нужен
        const $title = $sec.children('.mt-pl-section-title');
        if (!$title.find('.mt-pl-section-add').length) $title.addClass('mt-pl-section-title-empty');
        $('<button type="button" class="mt-pl-tab moodtube-ctrl" role="tab"></button>')
            .attr('data-mt-tab', kind)
            .html($title.find('.mt-pl-section-label').html())
            .appendTo($bar);
    });
    $container.prepend($bar);
    const select = (kind) => {
        $bar.children('.mt-pl-tab').each((i, b) => $(b).toggleClass('mt-is-active', $(b).attr('data-mt-tab') === kind).attr('aria-selected', $(b).attr('data-mt-tab') === kind));
        $secs.each((i, sec) => $(sec).toggle($(sec).attr('data-mt-tab') === kind));
        try { localStorage.setItem(storageKey, kind); } catch (e) {}
    };
    $bar.on('click', '.mt-pl-tab', function() { select($(this).attr('data-mt-tab')); });
    let saved = null;
    try { saved = localStorage.getItem(storageKey); } catch (e) {}
    select(saved === 'moodtube' ? 'moodtube' : 'spotify');
}

function mtSetPlaylistsHeader(title, showBack) {
    $('#moodtube-playlists-title').text(title);
    $('#moodtube-btn-playlists-back').toggle(!!showBack);
}

// --- Панель «Плейлисты»: список ---
async function showSpotifyPlaylists() { return showPlaylistsPanel(); }

async function showPlaylistsPanel() {
    $('#moodtube-inner-content').hide();
    $('#moodtube-queue-container').hide();
    $('#moodtube-btn-close').hide();
    $('#moodtube-spotify-playlists-container').css('display', 'flex');
    await renderPlaylistsList();
}

async function renderPlaylistsList() {
    mtSetPlaylistsHeader('Плейлисты', false);
    const $list = $('#moodtube-playlists-list').empty();
    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';

    // Spotify — первая вкладка, только в режиме Spotify
    if (source === 'spotify') {
        const $sec = $('<div class="mt-pl-section mt-pl-section-spotify"><div class="mt-pl-section-title"><span class="mt-pl-section-label"><i class="fa-brands fa-spotify"></i> Spotify</span></div><div class="mt-pl-section-body"><div class="mt-queue-empty"><i class="fa-solid fa-spinner fa-spin"></i> Загрузка...</div></div></div>').appendTo($list);
        fetchSpotifyPlaylists().then(playlists => {
            const $body = $sec.find('.mt-pl-section-body').empty();
            if (!playlists || !playlists.length) { $body.append('<div class="mt-queue-empty">Плейлистов Spotify нет</div>'); return; }
            playlists.forEach(pl => {
                if (!pl || !pl.id) return;
                const $item = $(`
                    <div class="mt-queue-item mt-playlist-item mt-playlist-spotify">
                        <img class="mt-queue-thumb" alt="">
                        <span class="mt-queue-title mt-playlist-title"></span>
                    </div>`);
                $item.find('.mt-playlist-title').text(pl.name || 'Без названия');
                setImgWithFallback($item.find('img')[0], pl.images?.[0]?.url ? [pl.images[0].url] : []);
                $item.on('click', () => playSpotifyPlaylist(`spotify:playlist:${pl.id}`, pl.name || 'Без названия'));
                $body.append($item);
            });
        }).catch(err => {
            console.error(err);
            $sec.find('.mt-pl-section-body').html('<div class="mt-queue-empty">Ошибка загрузки плейлистов Spotify</div>');
        });
    }

    // MoodTube
    const $sec = $(`
        <div class="mt-pl-section mt-pl-section-moodtube">
            <div class="mt-pl-section-title"><span class="mt-pl-section-label"><i class="fa-solid fa-compact-disc"></i> MoodTube</span>
                <span class="mt-pl-section-add moodtube-ctrl" title="Создать плейлист"><i class="fa-solid fa-plus"></i> Создать</span>
            </div>
            <div class="mt-pl-section-body"></div>
        </div>`).appendTo($list);
    const $body = $sec.find('.mt-pl-section-body');
    mtPlStore().forEach(pl => {
        const $item = $(`
            <div class="mt-queue-item mt-playlist-item mt-playlist-moodtube${pl.id === MT_FAV_ID ? ' mt-playlist-fav' : ''}">
                ${mtPlaylistCover(pl)}
                <span class="mt-queue-title mt-playlist-title"></span>
                <span class="mt-pl-count"></span>
                <i class="fa-solid fa-chevron-right mt-pl-open"></i>
            </div>`);
        $item.find('.mt-playlist-title').text(pl.name);
        $item.find('.mt-pl-count').text(mtTracksWord(pl.tracks.length));
        const $img = $item.find('img.mt-pl-cover');
        if ($img.length) setImgWithFallback($img[0], getTrackThumbCandidates({ videoId: pl.tracks[0].videoId, videoThumbnails: pl.tracks[0].thumbnail ? [{ url: pl.tracks[0].thumbnail }] : [] }, 'default'));
        $item.on('click', () => renderPlaylistDetail(pl.id));
        $body.append($item);
    });
    $sec.find('.mt-pl-section-add').on('click', function() {
        mtInlineInput($sec.find('.mt-pl-section-title'), {
            placeholder: 'Название плейлиста', okText: 'Создать',
            onOk: name => { const pl = mtPlCreate(name); toastr.success(`Плейлист «${pl.name}» создан`); renderPlaylistsList(); return false; },
        });
    });
    mtTabify($list, 'moodtube_pl_tab');
}

// --- Панель «Плейлисты»: внутри плейлиста ---
function renderPlaylistDetail(id) {
    const pl = mtPlGet(id);
    if (!pl) { renderPlaylistsList(); return; }
    mtSetPlaylistsHeader(pl.name, true);
    const $list = $('#moodtube-playlists-list').empty();
    const isFav = id === MT_FAV_ID;

    const $toolbar = $(`
        <div class="mt-pl-toolbar">
            <button class="mt-pl-tool mt-pl-play moodtube-ctrl"><i class="fa-solid fa-play"></i> Слушать</button>
            <button class="mt-pl-tool mt-pl-shuffle moodtube-ctrl" title="Перемешать"><i class="fa-solid fa-shuffle"></i></button>
            ${isFav ? '' : '<button class="mt-pl-tool mt-pl-rename moodtube-ctrl" title="Переименовать"><i class="fa-solid fa-pen"></i></button><button class="mt-pl-tool mt-pl-delete moodtube-ctrl" title="Удалить плейлист"><i class="fa-solid fa-trash"></i></button>'}
        </div>`).appendTo($list);
    $toolbar.find('.mt-pl-play').prop('disabled', !pl.tracks.length).on('click', () => playMoodTubePlaylist(id, 0));
    $toolbar.find('.mt-pl-shuffle').prop('disabled', pl.tracks.length < 2).on('click', () => playMoodTubePlaylist(id, 0, true));
    $toolbar.find('.mt-pl-rename').on('click', () => {
        mtInlineInput($toolbar, {
            placeholder: 'Новое название', value: pl.name, okText: 'Сохранить',
            onOk: name => { mtPlRename(id, name); renderPlaylistDetail(id); return false; },
        });
    });
    $toolbar.find('.mt-pl-delete').on('click', () => {
        if (!confirm(`Удалить плейлист «${pl.name}»? Треки из очереди не пропадут.`)) return;
        mtPlDelete(id);
        toastr.info(`Плейлист «${pl.name}» удалён`);
        renderPlaylistsList();
    });

    if (!pl.tracks.length) {
        $list.append(`<div class="mt-queue-empty">${isFav ? 'Пусто. Нажмите ❤ на играющем треке.' : 'Пусто. Добавляйте треки кнопкой «+» в очереди.'}</div>`);
        return;
    }
    pl.tracks.forEach((t, index) => {
        const $item = $(`
            <div class="mt-queue-item mt-pl-track">
                <img class="mt-queue-thumb" alt="">
                <span class="mt-queue-title"></span>
                ${t.spotifyUri ? '<i class="fa-brands fa-spotify mt-pl-track-source" title="Трек из Spotify"></i>' : ''}
                <i class="fa-solid fa-xmark moodtube-ctrl mt-pl-track-remove" title="Убрать из плейлиста"></i>
            </div>`);
        $item.find('.mt-queue-title').text(t.title || t.query);
        setImgWithFallback($item.find('img')[0], getTrackThumbCandidates({ videoId: t.videoId, videoThumbnails: t.thumbnail ? [{ url: t.thumbnail }] : [] }, 'default'));
        $item.on('click', e => {
            if ($(e.target).closest('.mt-pl-track-remove').length) return;
            playMoodTubePlaylist(id, index);
        });
        $item.find('.mt-pl-track-remove').on('click', e => {
            e.stopPropagation();
            mtPlRemove(id, mtTrackKey(t));
            if (isFav) updateFavoriteButton();
            renderPlaylistDetail(id);
        });
        $list.append($item);
    });
}

// --- «+» в очереди: добавить трек в плейлист ---
function showSpotifyAddToPlaylistMenu(track) { return showAddToPlaylistMenu(track); }

function showAddToPlaylistMenu(track) {
    const plTrack = mtToPlaylistTrack(track);
    if (!plTrack) { toastr.warning('Трек ещё не найден'); return; }

    if ($('#moodtube-add-playlist-modal').length === 0) {
        $(`
        <div id="moodtube-add-playlist-modal" class="mt-pl-modal" style="display:none;">
            <div class="mt-pl-modal-box">
                <div class="mt-pl-modal-header">
                    <span class="mt-pl-modal-title">Добавить в плейлист</span>
                    <i class="fa-solid fa-xmark moodtube-ctrl mt-pl-modal-close" id="moodtube-close-add-modal"></i>
                </div>
                <div class="mt-pl-modal-track"></div>
                <div id="moodtube-add-playlists-list" class="mt-pl-modal-body"></div>
            </div>
        </div>
        `).appendTo('body');
        $('#moodtube-close-add-modal').on('click', () => $('#moodtube-add-playlist-modal').hide());
        $('#moodtube-add-playlist-modal').on('click', e => { if (e.target.id === 'moodtube-add-playlist-modal') $('#moodtube-add-playlist-modal').hide(); });
    }

    const $modal = $('#moodtube-add-playlist-modal');
    $modal.find('.mt-pl-modal-track').text(plTrack.title || plTrack.query);
    const $body = $('#moodtube-add-playlists-list').empty();
    $modal.css('display', 'flex');

    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
    const isSpotifyTrack = source === 'spotify' && !!plTrack.spotifyUri;
    const target = isSpotifyTrack ? mtSpotifyTarget('plus') : 'moodtube';

    // Spotify — первая вкладка
    if (target !== 'moodtube') {
        const $sec = $(`
            <div class="mt-pl-section mt-pl-section-spotify">
                <div class="mt-pl-section-title"><span class="mt-pl-section-label"><i class="fa-brands fa-spotify"></i> Spotify</span>
                    <span class="mt-pl-section-add moodtube-ctrl"><i class="fa-solid fa-plus"></i> Новый</span>
                </div>
                <div class="mt-pl-section-body"><div class="mt-queue-empty"><i class="fa-solid fa-spinner fa-spin"></i></div></div>
            </div>`).appendTo($body);
        const renderSpotify = () => fetchSpotifyPlaylists().then(playlists => {
            const $b = $sec.find('.mt-pl-section-body').empty();
            if (!playlists || !playlists.length) { $b.append('<div class="mt-queue-empty">Плейлистов Spotify нет</div>'); return; }
            playlists.forEach(pl => {
                if (!pl || !pl.id) return;
                const $opt = $('<div class="mt-pl-option moodtube-ctrl"><i class="fa-solid fa-plus mt-pl-option-icon"></i><span class="mt-pl-option-name"></span></div>');
                $opt.find('.mt-pl-option-name').text(pl.name || 'Без названия');
                $opt.on('click', async () => {
                    if ($opt.hasClass('mt-is-busy')) return;
                    $opt.addClass('mt-is-busy');
                    if (await spotifyAddToPlaylist(pl.id, plTrack.spotifyUri)) {
                        $opt.addClass('mt-is-added').find('.mt-pl-option-icon').attr('class', 'fa-solid fa-check mt-pl-option-icon');
                        toastr.success(`Добавлено в Spotify «${pl.name}»`);
                    }
                    $opt.removeClass('mt-is-busy');
                });
                $b.append($opt);
            });
        });
        renderSpotify();
        $sec.find('.mt-pl-section-add').on('click', () => {
            mtInlineInput($sec.find('.mt-pl-section-title'), {
                placeholder: 'Новый плейлист Spotify', okText: 'Создать',
                onOk: async name => {
                    const newPl = await spotifyCreatePlaylist(name);
                    if (!newPl) return true;
                    if (await spotifyAddToPlaylist(newPl.id, plTrack.spotifyUri)) toastr.success(`Плейлист Spotify «${name}» создан, трек добавлен`);
                    renderSpotify();
                    return false;
                },
            });
        });
    }

    // MoodTube — вторая вкладка; чекбоксы: повторный клик убирает трек
    if (target !== 'spotify') {
        const key = mtTrackKey(plTrack);
        const $sec = $(`
            <div class="mt-pl-section mt-pl-section-moodtube">
                <div class="mt-pl-section-title"><span class="mt-pl-section-label"><i class="fa-solid fa-compact-disc"></i> MoodTube</span>
                    <span class="mt-pl-section-add moodtube-ctrl"><i class="fa-solid fa-plus"></i> Новый</span>
                </div>
                <div class="mt-pl-section-body"></div>
            </div>`).appendTo($body);
        const renderMoodTube = () => {
            const $b = $sec.find('.mt-pl-section-body').empty();
            mtPlStore().forEach(pl => {
                const has = mtPlHas(pl, key);
                const $opt = $(`<div class="mt-pl-option moodtube-ctrl${has ? ' mt-is-added' : ''}">
                    <i class="${has ? 'fa-solid fa-square-check' : 'fa-regular fa-square'} mt-pl-option-icon"></i>
                    <span class="mt-pl-option-name"></span><span class="mt-pl-count"></span></div>`);
                $opt.find('.mt-pl-option-name').text(pl.name);
                $opt.find('.mt-pl-count').text(pl.tracks.length);
                $opt.on('click', () => {
                    if (mtPlHas(pl, key)) { mtPlRemove(pl.id, key); toastr.info(`Убрано из «${pl.name}»`); }
                    else { mtPlAdd(pl.id, plTrack); toastr.success(`Добавлено в «${pl.name}»`); }
                    if (pl.id === MT_FAV_ID) updateFavoriteButton();
                    renderMoodTube();
                });
                $b.append($opt);
            });
        };
        renderMoodTube();
        $sec.find('.mt-pl-section-add').on('click', () => {
            mtInlineInput($sec.find('.mt-pl-section-title'), {
                placeholder: 'Новый плейлист MoodTube', okText: 'Создать',
                onOk: name => {
                    const pl = mtPlCreate(name);
                    mtPlAdd(pl.id, plTrack);
                    toastr.success(`Плейлист «${pl.name}» создан, трек добавлен`);
                    renderMoodTube();
                    return false;
                },
            });
        });
    }
    mtTabify($body, 'moodtube_pl_add_tab');
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
        const showSpotifyAdd = !!track.videoId && !track.isSearching && !track.searchFailed && !track.isExhausted;
        const itemClasses = ['moodtube-queue-item', 'mt-queue-item'];
        if (isCurrent) itemClasses.push('mt-is-current');
        if (track.isExhausted) itemClasses.push('mt-is-blocked');
        if (track.isSearching) itemClasses.push('mt-is-searching');
        const $item = $(`
            <div class="${itemClasses.join(' ')}">
                <img class="mt-queue-thumb${!track.videoId ? ' mt-is-empty' : ''}" alt="">
                <span class="mt-queue-title">${track.isExhausted ? '❌ Заблокировано: ' : ''}${mtEscapeHtml(track.title)}</span>
                ${isCurrent ? '<i class="fa-solid fa-volume-high mt-queue-now"></i>' : ''}
                ${showSpotifyAdd ? '<div class="moodtube-btn-add-playlist moodtube-ctrl mt-queue-add" title="Добавить в плейлист"><i class="fa-solid fa-plus"></i></div>' : ''}
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

// ============================================================
//  АЛЬТЕРНАТИВНЫЙ ВИД: полоса под шапкой таверны
//  Встаёт первым элементом в #sheld (флекс-колонка), поэтому чат сдвигается вниз, а не перекрывается.
//  Кнопки полосы нажимают кнопки основного плеера — логика одна.
// ============================================================
const MT_LAYOUT_KEY = 'moodtube_player_layout';
let mtDockTimer = null;
let mtDockObserved = false;

function getPlayerLayout() {
    try { return localStorage.getItem(MT_LAYOUT_KEY) === 'dock' ? 'dock' : 'floating'; } catch (e) { return 'floating'; }
}

function ensureDockBar() {
    let $bar = $('#moodtube-dock');
    if ($bar.length) return $bar;
    $bar = $(`
        <div id="moodtube-dock" class="mt-dock mt-is-idle" data-mt-state="idle">
            <div class="mt-slot mt-dock-slot-bg" aria-hidden="true"></div>
            <div class="mt-dock-bar">
            <div class="mt-dock-inner">
                <div class="mt-dock-cover"><img class="mt-dock-cover-img" alt=""></div>
                <div class="mt-dock-info">
                    <span class="mt-dock-title">No Track Selected</span>
                    <span class="mt-dock-subtitle"></span>
                </div>
                <div class="mt-dock-controls">
                    <i class="fa-regular fa-heart mt-dock-btn mt-dock-fav" data-mt-proxy="#moodtube-btn-favorite" title="В любимые"></i>
                    <i class="fa-solid fa-backward-step mt-dock-btn mt-dock-prev" data-mt-proxy="#moodtube-btn-prev" title="Предыдущий"></i>
                    <i class="fa-solid fa-play mt-dock-btn mt-dock-play" data-mt-proxy="#moodtube-btn-playpause" title="Play / Pause"></i>
                    <i class="fa-solid fa-forward-step mt-dock-btn mt-dock-next" data-mt-proxy="#moodtube-btn-next" title="Следующий"></i>
                    <span class="mt-dock-btn mt-dock-ai" data-mt-proxy="#moodtube-btn-ai" title="Auto-DJ (AI)"><i class="fa-solid fa-wand-magic-sparkles mt-btn-icon"></i></span>
                    <i class="fa-solid fa-list-ul mt-dock-btn mt-dock-queue" title="Очередь треков"></i>
                    <i class="fa-solid fa-chevron-down mt-dock-btn mt-dock-expand" title="Раскрыть плеер: очередь, плейлисты, поиск, громкость"></i>
                    <i class="fa-solid fa-xmark mt-dock-btn mt-dock-close" title="Скрыть полосу (вернуть — долгое нажатие на плавающую кнопку)"></i>
                </div>
            </div>
            <div class="mt-dock-progress" title="Перемотка"><div class="mt-dock-progress-fill"></div></div>
            </div>
            <div class="mt-dock-panel"></div>
        </div>`);
    $bar.on('click', '[data-mt-proxy]', function(e) {
        e.stopPropagation();
        $($(this).attr('data-mt-proxy')).trigger('click');
    });
    $bar.on('click', '.mt-dock-expand', function(e) {
        e.stopPropagation();
        isPlayerFolded = !isPlayerFolded;
        updatePlayerVisibility();
        syncDock();
    });
    $bar.on('click', '.mt-dock-close', function(e) {
        e.stopPropagation();
        setDockHidden(true);
    });
    // Очередь: открываем плеер сразу на ней; повторное нажатие прячет плеер
    $bar.on('click', '.mt-dock-queue', function(e) {
        e.stopPropagation();
        const queueOpen = $('#moodtube-mini-player').is(':visible') && $('#moodtube-queue-container').is(':visible');
        if (queueOpen) {
            $('#moodtube-btn-close-queue').trigger('click');
            isPlayerFolded = true;
        } else {
            isPlayerFolded = false;
            updatePlayerVisibility();
            $('#moodtube-spotify-playlists-container, #moodtube-search-container').hide();
            $('#moodtube-btn-queue').trigger('click');
        }
        updatePlayerVisibility();
        syncDock();
    });
    // Перемотка: передаём долю основному слайдеру — у него уже есть обработчик seek
    $bar.on('click', '.mt-dock-progress', function(e) {
        const rect = this.getBoundingClientRect();
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        $('#moodtube-progress-slider').val(Math.round(ratio * 100)).trigger('input').trigger('change');
        syncDockProgress();
    });
    return $bar;
}

const MT_DOCK_HIDDEN_KEY = 'moodtube_dock_hidden';
function isDockHidden() {
    try { return localStorage.getItem(MT_DOCK_HIDDEN_KEY) === 'true'; } catch (e) { return false; }
}
function setDockHidden(hidden) {
    try { localStorage.setItem(MT_DOCK_HIDDEN_KEY, hidden ? 'true' : 'false'); } catch (e) {}
    if (hidden) { isPlayerFolded = true; updatePlayerVisibility(); }
    $('#moodtube-dock').toggleClass('mt-dock-hidden', !!hidden);
    if (!hidden) syncDock();
}

// Плеер целиком переезжает в панель под полосой (и обратно в body для плавающего вида).
// Всё работает по id, поэтому очередь, плейлисты, поиск, громкость и перемотка остаются те же.
function dockPlayer(docked) {
    const $p = $('#moodtube-mini-player');
    if (!$p.length) return;
    if (docked) {
        const $panel = $('#moodtube-dock .mt-dock-panel');
        if ($panel.length && !$p.parent().is($panel)) $p.appendTo($panel);
        $p.addClass('mt-player-docked');
    } else {
        if (!$p.parent().is('body')) $p.appendTo('body');
        $p.removeClass('mt-player-docked');
    }
}

// Долгое нажатие на плавающую кнопку и пункт меню расширений
function togglePlayerUI() {
    if (getPlayerLayout() === 'dock') {
        applyPlayerLayout();
        setDockHidden(!isDockHidden());
        return;
    }
    isPlayerFolded = !isPlayerFolded;
    updatePlayerVisibility();
}

function mountDockBar() {
    const $sheld = $('#sheld');
    if (!$sheld.length) return false;
    const $bar = ensureDockBar();
    // Прямо перед #chat: так полоса оказывается под любыми шапками (таверны и других расширений)
    const $chat = $sheld.children('#chat');
    if ($chat.length) { if (!$bar.next().is($chat)) $bar.insertBefore($chat); }
    else if (!$bar.parent().is($sheld)) $bar.prependTo($sheld);
    return true;
}

function syncDockProgress() {
    const v = Number($('#moodtube-progress-slider').val()) || 0;
    $('#moodtube-dock .mt-dock-progress-fill').css('width', `${Math.min(100, Math.max(0, v))}%`);
}

function syncDock() {
    const $d = $('#moodtube-dock');
    if (!$d.length) return;
    const $p = $('#moodtube-mini-player');
    $d.find('.mt-dock-title').text($('#moodtube-widget-title').text());
    $d.find('.mt-dock-subtitle').text($('#moodtube-label-subtitle').text());
    const src = $('#moodtube-widget-cover').attr('src') || '';
    const $img = $d.find('.mt-dock-cover-img');
    if ($img.attr('src') !== src) $img.attr('src', src);
    const playing = $('#moodtube-btn-playpause').hasClass('fa-pause');
    $d.find('.mt-dock-play').toggleClass('fa-pause', playing).toggleClass('fa-play', !playing);
    const fav = $('#moodtube-btn-favorite').hasClass('fa-solid');
    $d.find('.mt-dock-fav').toggleClass('fa-solid', fav).toggleClass('fa-regular', !fav).toggleClass('mt-is-active', fav);
    const busy = $('#moodtube-btn-ai').hasClass('mt-is-busy');
    $d.find('.mt-dock-ai').toggleClass('mt-is-busy', busy).find('.mt-btn-icon').toggleClass('fa-spin', busy);
    const state = $p.attr('data-mt-state') || 'idle';
    $d.attr('data-mt-state', state)
        .toggleClass('mt-is-playing', state === 'playing')
        .toggleClass('mt-is-paused', state === 'paused')
        .toggleClass('mt-is-idle', state === 'idle')
        .toggleClass('mt-dj-busy', busy)
        .attr('data-mt-theme', $p.attr('data-mt-theme') || '');
    const open = $p.is(':visible');
    $d.find('.mt-dock-expand').toggleClass('mt-is-open', open)
        .toggleClass('fa-chevron-down', !open).toggleClass('fa-chevron-up', open)
        .attr('title', open ? 'Свернуть плеер' : 'Раскрыть плеер: очередь, плейлисты, поиск, громкость');
    $d.toggleClass('mt-dock-expanded', open).toggleClass('mt-dock-hidden', isDockHidden());
    $d.find('.mt-dock-queue').toggleClass('mt-is-open', $p.is(':visible') && $('#moodtube-queue-container').is(':visible'));
    syncDockProgress();
}

function observeForDock() {
    if (mtDockObserved) return;
    const els = ['moodtube-widget-title', 'moodtube-label-subtitle', 'moodtube-widget-cover', 'moodtube-btn-playpause', 'moodtube-btn-favorite', 'moodtube-btn-ai', 'moodtube-mini-player', 'moodtube-queue-container']
        .map(id => document.getElementById(id)).filter(Boolean);
    if (!els.length) return;
    mtDockObserved = true;
    const obs = new MutationObserver(() => { if (getPlayerLayout() === 'dock') syncDock(); });
    els.forEach(el => obs.observe(el, (el.id === 'moodtube-mini-player' || el.id === 'moodtube-queue-container')
        ? { attributes: true, attributeFilter: ['data-mt-state', 'data-mt-theme', 'style'] }
        : { attributes: true, attributeFilter: ['class', 'src'], childList: true, characterData: true, subtree: true }));
}

function applyPlayerLayout() {
    const dock = getPlayerLayout() === 'dock';
    $('body').toggleClass('mt-layout-dock', dock);
    if (dock) {
        if (!mountDockBar()) return;
        dockPlayer(true);
        observeForDock();
        syncDock();
        if (!mtDockTimer) mtDockTimer = setInterval(() => { if ($('#moodtube-dock').length) syncDockProgress(); }, 500);
    } else {
        dockPlayer(false);
        $('#moodtube-dock').remove();
        if (mtDockTimer) { clearInterval(mtDockTimer); mtDockTimer = null; }
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
    // Необязательные: пусто — остаются стандартные цвета текста
    { key: 'text',           css: '--mt-text',           label: 'Текст',               def: '', hint: '#E5E7EB' },
    { key: 'text_dim',       css: '--mt-text-dim',       label: 'Текст приглушённый',  def: '', hint: '#9CA3AF' },
    { key: 'text_on_accent', css: '--mt-text-on-accent', label: 'Текст на акценте',    def: '', hint: '#111827' },
];
// Картинки попадают в CSS-переменные --mt-img-*, которые по умолчанию рисуют слоты .mt-slot-*
const MT_THEME_IMAGES = [
    { key: 'bg',    css: '--mt-img-bg',    label: 'Фон плеера',           hint: '.mt-slot-bg — под всем содержимым' },
    { key: 'scene', css: '--mt-img-scene', label: 'Сцена',                hint: '.mt-slot-scene — над фоном, под контролами' },
    { key: 'cover_bg', css: '--mt-img-cover-bg', label: 'Под обложкой',   hint: '.mt-slot-cover-bg — сцена только в круге обложки (видна, пока нет трека или если обложка прозрачная)' },
    { key: 'cover', css: '--mt-img-cover', label: 'Поверх обложки',       hint: '.mt-slot-cover — винил/рамка поверх обложки' },
    { key: 'decor', css: '--mt-img-decor', label: 'Декор поверх плеера',  hint: '.mt-slot-decor — бантики, стикеры (клики проходят насквозь)' },
    { key: 'dock',  css: '--mt-img-dock',  label: 'Фон полосы под шапкой', hint: '.mt-dock-slot-bg — фон вида «Полоса под шапкой таверны»' },
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
    try { updateFavoriteButton(); } catch (e) {}
    if (state !== lastBroadcastState) {
        lastBroadcastState = state;
        window.dispatchEvent(new CustomEvent('moodtube:state', { detail: { state } }));
    }
}
let lastBroadcastState = '';

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

// Разбор файла темы: собственный формат MoodTube или тема SillyTavern (берёт custom_css и цвета)
function parseThemeData(data, fallbackName) {
    if (data.type === 'moodtube_theme' || data.vars || data.images || data.labels) return normalizeCustomTheme(data);
    if (typeof data.custom_css === 'string' || data.blur_tint_color || data.quote_text_color) {
        const vars = {};
        if (data.quote_text_color) { vars.accent = data.quote_text_color; vars.accent_hover = data.quote_text_color; }
        if (data.blur_tint_color) vars.bg_primary = data.blur_tint_color;
        if (data.bot_mes_blur_tint_color) vars.bg_secondary = data.bot_mes_blur_tint_color;
        if (data.border_color) vars.border = data.border_color;
        return normalizeCustomTheme({ name: data.name || fallbackName, vars, custom_css: data.custom_css || '' });
    }
    return null;
}

// Подставить тему в редактор и показать превью. «Сохранить» — за пользователем.
function loadThemeDataIntoEditor(data, fallbackName) {
    const theme = parseThemeData(data, fallbackName);
    if (!theme) { toastr.error('MoodTube: в файле нет ни custom_css, ни переменных темы'); return null; }
    if ($('#moodtube-setting-theme').val() !== 'custom') {
        $('#moodtube-setting-theme').val('custom').trigger('change');
    }
    fillCustomThemeForm(theme);
    applyCustomThemeCss(theme);
    applyThemeLabels(theme);
    toastr.success(`MoodTube: тема «${theme.name}» загружена. Нажмите «Сохранить», чтобы применить навсегда.`);
    return theme;
}

// --- КАТАЛОГ ТЕМ (index.json на GitHub / jsDelivr) ---
const MT_CATALOG_URL_KEY = 'moodtube_theme_catalog_url';
const MT_CATALOG_MAX_INDEX = 512 * 1024;
const MT_CATALOG_MAX_THEME = 2 * 1024 * 1024;
// Только https и только хостинги статики с CORS: так тема не придёт с произвольного сервера
function isAllowedCatalogUrl(url) {
    let u;
    try { u = new URL(url); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'raw.githubusercontent.com' || h === 'cdn.jsdelivr.net' || h === 'gist.githubusercontent.com' || h.endsWith('.github.io');
}

function resolveCatalogUrl(ref, baseUrl) {
    if (typeof ref !== 'string' || !ref.trim()) return null;
    try {
        const url = new URL(ref.trim(), baseUrl).href;
        return isAllowedCatalogUrl(url) ? url : null;
    } catch (e) { return null; }
}

async function fetchCatalogText(url, maxBytes) {
    if (!isAllowedCatalogUrl(url)) throw new Error('Разрешены только https-ссылки с raw.githubusercontent.com, cdn.jsdelivr.net, gist.githubusercontent.com или *.github.io');
    const res = await fetchWithTimeout(url, { cache: 'no-cache', credentials: 'omit', referrerPolicy: 'no-referrer' }, 15000);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get('content-length') || 0);
    if (len && len > maxBytes) throw new Error(`файл больше ${Math.round(maxBytes / 1024)} КБ`);
    const text = await res.text();
    if (text.length > maxBytes) throw new Error(`файл больше ${Math.round(maxBytes / 1024)} КБ`);
    return text;
}

async function loadThemeCatalog(url) {
    const $out = $('#mt-catalog-list');
    url = String(url || '').trim();
    if (!url) return;
    try { localStorage.setItem(MT_CATALOG_URL_KEY, url); } catch (e) {}
    $out.show().html('<div class="mt-catalog-status"><i class="fa-solid fa-spinner fa-spin"></i> Загружаю каталог…</div>');
    let data;
    try {
        data = JSON.parse(await fetchCatalogText(url, MT_CATALOG_MAX_INDEX));
    } catch (e) {
        $out.empty().append($('<div class="mt-catalog-status mt-catalog-error">').text(`Не удалось загрузить каталог: ${e.message || e}`));
        return;
    }
    const themes = (data && data.type === 'moodtube_catalog' && Array.isArray(data.themes)) ? data.themes.filter(t => t && typeof t === 'object' && t.file) : null;
    if (!themes) {
        $out.empty().append('<div class="mt-catalog-status mt-catalog-error">Это не каталог MoodTube (нужен index.json с "type": "moodtube_catalog").</div>');
        return;
    }
    renderThemeCatalog($out, data, themes, url);
}

// Группировка перекрасов: явное поле "group" или общий кусок названия ("… Vinyl", "Clear Case …").
// Для каждой темы берём префикс/суффикс названия, который встречается у наибольшего числа тем.
function groupCatalogThemes(themes) {
    const words = t => String(t.name || t.id || '').trim().split(/\s+/).filter(Boolean);
    const counts = new Map();
    const cands = themes.map(t => {
        if (typeof t.group === 'string' && t.group.trim()) return null;
        const w = words(t);
        const list = [];
        for (let n = 1; n <= w.length; n++) list.push({ key: 'p:' + w.slice(0, n).join(' ').toLowerCase(), side: 'p', n });
        for (let n = 1; n < w.length; n++) list.push({ key: 's:' + w.slice(w.length - n).join(' ').toLowerCase(), side: 's', n });
        list.forEach(c => counts.set(c.key, (counts.get(c.key) || 0) + 1));
        return list;
    });
    const picks = themes.map((t, i) => {
        if (!cands[i]) return { key: 'g:' + t.group.trim().toLowerCase(), explicit: true };
        let best = null, bestCount = 1;
        for (const c of cands[i]) {
            const cnt = counts.get(c.key);
            if (cnt > bestCount || (cnt === bestCount && best && cnt > 1 && c.key.length > best.key.length)) { best = c; bestCount = cnt; }
        }
        return best ? { ...best } : { key: 'single:' + i };
    });
    const groups = [];
    const byKey = new Map();
    themes.forEach((t, i) => {
        const pick = picks[i];
        let g = byKey.get(pick.key);
        if (!g) { g = { key: pick.key, pick, items: [] }; byKey.set(pick.key, g); groups.push(g); }
        g.items.push(t);
    });
    // Группа из одной темы — обычная карточка
    return groups.map(g => {
        if (g.items.length < 2) return { name: String(g.items[0].name || g.items[0].id || 'Без названия'), items: g.items.map(t => ({ theme: t, label: '' })) };
        let name;
        if (g.pick.explicit) name = g.items[0].group.trim();
        else {
            const w = words(g.items[0]);
            name = g.pick.side === 'p' ? w.slice(0, g.pick.n).join(' ') : w.slice(w.length - g.pick.n).join(' ');
        }
        const items = g.items.map(t => {
            let label = typeof t.variant === 'string' && t.variant.trim() ? t.variant.trim() : '';
            if (!label) {
                const w = words(t);
                if (!g.pick.explicit) label = (g.pick.side === 'p' ? w.slice(g.pick.n) : w.slice(0, w.length - g.pick.n)).join(' ');
                else label = String(t.name || t.id || '');
            }
            return { theme: t, label: label || 'Оригинал' };
        });
        return { name, items };
    });
}

async function installCatalogTheme(t, fileUrl, $btn) {
    const name = String(t.name || t.id || 'тема');
    const host = (() => { try { return new URL(fileUrl).hostname; } catch (e) { return ''; } })();
    if (!confirm(`Тема из внешнего источника\n\n«${name}»${t.author ? ` от ${t.author}` : ''}\nИсточник: ${host}\n\nТема содержит только CSS и картинки, но может загружать картинки с внешних сайтов (они увидят ваш IP) и менять или скрывать части интерфейса MoodTube.\n\nПодставить тему в редактор?`)) return;
    const html = $btn.html();
    $btn.prop('disabled', true).html('<i class="fa-solid fa-spinner fa-spin"></i>');
    try {
        const themeData = JSON.parse(await fetchCatalogText(fileUrl, MT_CATALOG_MAX_THEME));
        if (!themeData || typeof themeData !== 'object' || Array.isArray(themeData)) throw new Error('неверный формат файла темы');
        loadThemeDataIntoEditor(themeData, name);
    } catch (e) {
        toastr.error(`MoodTube: не удалось установить тему — ${e.message || e}`);
    } finally {
        $btn.prop('disabled', false).html(html);
    }
}

function mtVariantsWord(n) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return `${n} вариант`;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return `${n} варианта`;
    return `${n} вариантов`;
}

// Галерея каталога: сетка карточек, перекрасы одной темы — одна карточка с выбором варианта
function renderThemeCatalog($out, data, themes, url) {
    const groups = groupCatalogThemes(themes);
    const tagCounts = new Map();
    themes.forEach(t => (Array.isArray(t.tags) ? t.tags : []).forEach(tag => {
        tag = String(tag).toLowerCase();
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
    }));
    const topTags = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(e => e[0]);

    $out.empty();
    const $head = $('<div class="mt-catalog-head"></div>').appendTo($out);
    $('<div class="mt-catalog-title">').text(`${data.name || 'Каталог'} · ${themes.length} тем`).appendTo($head);
    const $filters = $(`
        <div class="mt-catalog-filters">
            <input type="text" class="mt-input-field mt-catalog-search" placeholder="Поиск темы…" autocomplete="off" spellcheck="false">
            <div class="mt-catalog-tagbar"></div>
        </div>`).appendTo($head);
    const $tagbar = $filters.find('.mt-catalog-tagbar');
    if (topTags.length > 1) {
        ['', ...topTags].forEach(tag => $('<button type="button" class="mt-catalog-filter">').attr('data-tag', tag).text(tag || 'Все').toggleClass('mt-is-active', !tag).appendTo($tagbar));
    } else $tagbar.remove();

    const $grid = $('<div class="mt-catalog-grid"></div>').appendTo($out);
    const $empty = $('<div class="mt-catalog-status" style="display:none;">Ничего не найдено</div>').appendTo($out);

    const cards = groups.map(g => {
        const isGroup = g.items.length > 1;
        const swatches = isGroup && g.items.every(it => /^#[0-9a-f]{3,8}$/i.test(String(it.theme.swatch || '')));
        const $card = $(`
            <div class="mt-catalog-card${isGroup ? ' mt-catalog-group' : ''}">
                <div class="mt-catalog-preview"><i class="fa-solid fa-palette"></i><img alt="" loading="lazy" referrerpolicy="no-referrer"></div>
                <div class="mt-catalog-body">
                    <div class="mt-catalog-name"></div>
                    <div class="mt-catalog-meta"></div>
                    <div class="mt-catalog-variants"></div>
                    <div class="mt-catalog-desc"></div>
                    <button class="mt-btn-test mt-catalog-install"><i class="fa-solid fa-download"></i> Установить</button>
                </div>
            </div>`);
        const $img = $card.find('img');
        $img.on('load', () => $card.find('.mt-catalog-preview').addClass('mt-has-img'));
        $img.on('error', () => $card.find('.mt-catalog-preview').removeClass('mt-has-img'));
        $card.find('.mt-catalog-name').text(g.name);

        let current = 0;
        const select = (i) => {
            current = i;
            const t = g.items[i].theme;
            const authors = [...new Set(g.items.map(it => it.theme.author).filter(Boolean))];
            const meta = [isGroup ? (authors.length === 1 ? `от ${authors[0]}` : '') : (t.author ? `от ${t.author}` : ''), isGroup ? mtVariantsWord(g.items.length) : ''].filter(Boolean).join(' · ');
            $card.find('.mt-catalog-meta').text(meta);
            $card.find('.mt-catalog-desc').text(String(t.description || '')).attr('title', String(t.description || ''));
            const previewUrl = resolveCatalogUrl(t.preview, url);
            $card.find('.mt-catalog-preview').removeClass('mt-has-img');
            if (previewUrl) $img.attr('src', previewUrl); else $img.removeAttr('src');
            const fileUrl = resolveCatalogUrl(t.file, url);
            $card.find('.mt-catalog-install').prop('disabled', !fileUrl)
                .attr('title', fileUrl ? `Установить «${t.name || t.id}»` : 'Ссылка на файл темы не https или с неразрешённого сайта');
            $card.find('.mt-catalog-swatch').each((j, b) => $(b).toggleClass('mt-is-active', j === i));
        };

        if (isGroup) {
            const $v = $card.find('.mt-catalog-variants');
            if (swatches) {
                g.items.forEach((it, i) => $('<button type="button" class="mt-catalog-swatch">')
                    .css('background', it.theme.swatch).attr('title', it.label).attr('aria-label', it.label)
                    .on('click', () => select(i)).appendTo($v));
            } else {
                const $sel = $('<select class="mt-input-field mt-catalog-variant"></select>').appendTo($v);
                g.items.forEach((it, i) => $('<option>').val(i).text(it.label).appendTo($sel));
                $sel.on('change', () => select(Number($sel.val())));
            }
        } else $card.find('.mt-catalog-variants').remove();

        $card.find('.mt-catalog-install').on('click', function() {
            const t = g.items[current].theme;
            const fileUrl = resolveCatalogUrl(t.file, url);
            if (fileUrl) installCatalogTheme(t, fileUrl, $(this));
        });
        select(0);
        $grid.append($card);

        const haystack = g.items.map(it => [g.name, it.label, it.theme.name, it.theme.author, it.theme.description, ...(it.theme.tags || [])].join(' ')).join(' ').toLowerCase();
        const tags = new Set(g.items.flatMap(it => (it.theme.tags || []).map(x => String(x).toLowerCase())));
        const itemTexts = g.items.map(it => [it.label, it.theme.name, it.theme.description, ...(it.theme.tags || [])].join(' ').toLowerCase());
        const selectVariant = (i) => { if (i === current) return; if ($card.find('select').length) $card.find('select').val(String(i)); select(i); };
        return { $card, haystack, tags, itemTexts, selectVariant, isGroup };
    });

    let activeTag = '';
    const applyFilters = () => {
        const q = String($filters.find('.mt-catalog-search').val() || '').trim().toLowerCase();
        let shown = 0;
        cards.forEach(c => {
            const ok = (!q || c.haystack.includes(q)) && (!activeTag || c.tags.has(activeTag));
            c.$card.toggle(ok);
            if (ok) shown++;
            // Поиск попал в конкретный перекрас — сразу показываем его
            if (ok && q && c.isGroup) {
                const i = c.itemTexts.findIndex(t => t.includes(q));
                if (i >= 0) c.selectVariant(i);
            }
        });
        $empty.toggle(shown === 0);
    };
    $filters.find('.mt-catalog-search').on('input', applyFilters);
    $tagbar.on('click', '.mt-catalog-filter', function() {
        activeTag = $(this).attr('data-tag') || '';
        $tagbar.children().each((i, b) => $(b).toggleClass('mt-is-active', ($(b).attr('data-tag') || '') === activeTag));
        applyFilters();
    });
}

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

        loadThemeDataIntoEditor(data, file.name.replace(/\.json$/i, ''));
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
        
        const snippet = censorText(buildSceneSnippet(context));
        const sceneBackground = censorText(buildSceneBackground(context));

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

// «Цензура»: обычные пробелы в контексте чата для ИИ заменяются невидимым аналогом
const MT_CENSOR_KEY = 'moodtube_censor';
const MT_CENSOR_CHAR_KEY = 'moodtube_censor_char';
const MT_CENSOR_CHARS = {
    '2005': 'Пробел ¼ em (U+2005)',
    '00a0': 'Неразрывный пробел (U+00A0)',
    '2002': 'Пробел en (U+2002)',
    '2009': 'Тонкий пробел (U+2009)',
    '3000': 'Широкий пробел (U+3000)',
};
function isCensorOn() {
    try { return localStorage.getItem(MT_CENSOR_KEY) === 'true'; } catch (e) { return false; }
}
function getCensorCode() {
    let c = '';
    try { c = localStorage.getItem(MT_CENSOR_CHAR_KEY) || ''; } catch (e) {}
    return MT_CENSOR_CHARS[c] ? c : '2005';
}
function censorText(text) {
    if (!isCensorOn()) return text;
    return String(text || '').replace(/ /g, String.fromCodePoint(parseInt(getCensorCode(), 16)));
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
        if (el.classList.contains('mt-player-docked')) return;
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
        $('#moodtube-wand-item').on('click', () => togglePlayerUI());
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
            padding: 20px; color: var(--mt-text, #fff); font-family: -apple-system, sans-serif;
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

        .mt-progress { display: flex; align-items: center; width: 100%; flex-shrink: 0; gap: 5px; margin-top: -5px; font-size: 10px; color: var(--mt-text-dim, #aaa); }
        .mt-time { flex-shrink: 0; min-width: 28px; font-variant-numeric: tabular-nums; }
        .mt-time-total { text-align: right; }

        .mt-controls { display: flex; gap: 15px; align-items: center; flex-shrink: 0; }
        .mt-btn { cursor: pointer; color: var(--mt-text, #fff); font-size: 18px; transition: 0.2s; }
        .mt-btn-accent { color: var(--mt-accent); }
        .mt-btn-small { font-size: 12px; }
        .mt-btn-queue { font-size: 16px; }
        .mt-btn-play { font-size: 28px; width: 28px; text-align: center; }
        .mt-btn-favorite { position: absolute; right: 0; top: 0; color: var(--mt-accent); font-size: 16px; }
        .mt-btn-ai { display: inline-flex; align-items: center; justify-content: center; }
        .mt-btn-ai.mt-is-busy { color: #00ff00; }
        .mt-window-btn { position: absolute; top: 12px; z-index: 5; color: var(--mt-text-dim, #888); font-size: 16px; }
        .mt-btn-settings { right: 40px; }
        .mt-btn-search { right: 65px; }
        /* Панель поиска непрозрачная (у некоторых тем фон полупрозрачный), шапка не залезает под кнопки окна. */
        .mt-panel-search { background: linear-gradient(var(--mt-bg-primary), var(--mt-bg-primary)), var(--mt-bg-solid, #10151c) !important; backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px); }
        .mt-panel-search .mt-panel-header { padding-right: 88px; min-height: 22px; }
        .mt-btn-search.mt-is-open { color: var(--mt-accent) !important; }
        /* Поле и кнопка строго внутри панели. Селекторы по id и !important: свои темы (в т.ч. CSS из темы Таверны)
           и общие стили Таверны для input не могут растянуть поле. Сетка: поле занимает остаток, кнопка — 44px. */
        #moodtube-search-container .mt-search-row { display: grid !important; grid-template-columns: minmax(0, 1fr) 44px !important; gap: 8px !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; margin: 4px 0 0 !important; padding: 0 !important; }
        #moodtube-search-container #moodtube-search-input { display: block !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important; height: 40px !important; margin: 0 !important; box-sizing: border-box !important; padding: 0 12px !important; border-radius: 8px !important; border: 1px solid var(--mt-border, rgba(255,255,255,.15)) !important; background: var(--mt-bg-secondary, rgba(255,255,255,.06)) !important; color: var(--mt-text, #fff) !important; font-size: 15px !important; line-height: 38px !important; outline: none !important; box-shadow: none !important; flex: none !important; }
        /* При фокусе поле не растёт (темы любят увеличивать поле, рамку или отступы) — меняется только цвет рамки. */
        #moodtube-search-container #moodtube-search-input:focus,
        #moodtube-search-container #moodtube-search-input:focus-visible,
        #moodtube-search-container #moodtube-search-input:active { border: 1px solid var(--mt-accent) !important; outline: none !important; box-shadow: none !important; transform: none !important; scale: none !important; zoom: 1 !important; width: 100% !important; height: 40px !important; margin: 0 !important; padding: 0 12px !important; font-size: 15px !important; animation: none !important; }
        #moodtube-search-container #moodtube-search-input { transform: none !important; scale: none !important; transition: border-color .15s ease !important; }
        #moodtube-search-container #moodtube-search-go { width: 44px !important; min-width: 0 !important; height: 40px !important; margin: 0 !important; padding: 0 !important; box-sizing: border-box !important; border: none !important; border-radius: 8px !important; background: var(--mt-accent) !important; color: var(--mt-text-on-accent, #000) !important; font-size: 15px !important; cursor: pointer; display: flex !important; align-items: center; justify-content: center; }
        .mt-panel-search .mt-search-hint { margin-top: 8px; font-size: 12px; color: var(--mt-text-dim, #888); }
        .mt-btn-close { right: 15px; }

        .mt-volume { display: flex; align-items: center; width: 90%; flex-shrink: 0; }
        .mt-volume-icon { color: var(--mt-accent); font-size: 12px; }
        .mt-volume-high { font-size: 14px; }

        .mt-panel {
            position: absolute; inset: 0; z-index: 4; box-sizing: border-box;
            flex-direction: column; padding: 15px; background: var(--mt-bg-primary);
        }
        .mt-panel-playlists { z-index: 5; }
        .mt-panel-header { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-height: 22px; margin-bottom: 10px; flex-shrink: 0; }
        /* Справа поверх шапки висят кнопки окна (поиск, настройки) — оставляем под них место, название не переносится */
        .mt-panel-header-left { display: flex; align-items: center; gap: 10px; flex: 1 1 auto; min-width: 0; margin-right: 60px; }
        .mt-panel-header-left > i { flex-shrink: 0; }
        .mt-panel-title { font-weight: bold; font-size: 14px; color: var(--mt-accent); min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-panel-header > .mt-panel-close { flex-shrink: 0; }
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
        .mt-queue-title { flex: 1; min-width: 0; font-size: 12px; color: var(--mt-text-dim, #aaa); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-queue-item.mt-is-current .mt-queue-title { color: var(--mt-text, #fff); }
        .mt-queue-item.mt-is-blocked .mt-queue-title { color: #ff6b6b; }
        .mt-playlist-title { font-weight: bold; font-size: 13px; color: var(--mt-text, #fff); }
        .mt-queue-now { color: var(--mt-accent); font-size: 10px; margin-right: 5px; }
        .mt-queue-add { width: 16px; height: 16px; display: flex; justify-content: center; align-items: center; cursor: pointer; color: var(--mt-accent); font-size: 12px; }
        .mt-queue-dislike {
            width: 16px; height: 16px; flex-shrink: 0; cursor: pointer;
            background-color: rgba(235,120,120,0.65);
            -webkit-mask: url(https://img.icons8.com/ios-filled/50/dislike.png) no-repeat center / contain;
            mask: url(https://img.icons8.com/ios-filled/50/dislike.png) no-repeat center / contain;
        }
        /* Плейлисты */
        .mt-pl-section { margin-bottom: 12px; }
        .mt-pl-section-title {
            display: flex; align-items: center; gap: 6px; margin: 2px 2px 6px;
            font-size: 11px; font-weight: bold; text-transform: uppercase; letter-spacing: 0.5px; color: var(--mt-text-dim, #888);
        }
        .mt-pl-section-add { margin-left: auto; cursor: pointer; text-transform: none; letter-spacing: 0; font-weight: 600; color: var(--mt-accent); }
        .mt-pl-cover { width: 30px; height: 30px; border-radius: 5px; flex-shrink: 0; display: flex; align-items: center; justify-content: center; }
        .mt-pl-cover-fav { background: var(--mt-accent); color: var(--mt-text-on-accent, #111827); font-size: 13px; }
        .mt-pl-cover-empty { background: rgba(255,255,255,0.08); color: var(--mt-text-dim, #888); font-size: 12px; }
        .mt-pl-count { flex-shrink: 0; font-size: 11px; color: var(--mt-text-dim, #888); }
        .mt-pl-open { flex-shrink: 0; font-size: 10px; color: var(--mt-text-dim, #888); }
        .mt-pl-back { margin-right: 2px; }
        .mt-pl-toolbar { display: flex; gap: 6px; margin-bottom: 10px; }
        .mt-pl-tool {
            display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            height: 32px; min-width: 36px; padding: 0 10px; box-sizing: border-box;
            border: 1px solid var(--mt-border); border-radius: 8px; cursor: pointer;
            background: rgba(255,255,255,0.06); color: var(--mt-text, #fff); font-size: 12px; font-family: inherit;
        }
        .mt-pl-tool.mt-pl-play { flex: 1; background: var(--mt-accent); border-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); font-weight: 600; }
        .mt-pl-tool:disabled { opacity: 0.4; cursor: default; }
        .mt-pl-track-source { flex-shrink: 0; font-size: 11px; color: #1DB954; }
        .mt-pl-track-remove { flex-shrink: 0; font-size: 12px; color: var(--mt-text-dim, #888); cursor: pointer; padding: 2px 4px; }
        /* Поле «Создать/Переименовать». Темы таверны любят раздувать input и button (особенно при фокусе на телефоне),
           поэтому размеры зафиксированы по id и !important. Цвета — через переменные, их тема меняет без !important. */
        #moodtube-mini-player .mt-pl-inline, #moodtube-add-playlist-modal .mt-pl-inline {
            display: grid !important; grid-template-columns: minmax(0, 1fr) auto 34px !important; align-items: center !important;
            gap: 6px !important; width: 100% !important; max-width: 100% !important; box-sizing: border-box !important; margin: 0 0 8px !important; padding: 0 !important;
        }
        #moodtube-mini-player .mt-pl-inline .mt-pl-inline-input,
        #moodtube-add-playlist-modal .mt-pl-inline .mt-pl-inline-input,
        #moodtube-mini-player .mt-pl-inline .mt-pl-inline-input:focus,
        #moodtube-add-playlist-modal .mt-pl-inline .mt-pl-inline-input:focus,
        #moodtube-mini-player .mt-pl-inline .mt-pl-inline-input:focus-visible,
        #moodtube-add-playlist-modal .mt-pl-inline .mt-pl-inline-input:focus-visible {
            display: block !important; flex: none !important; width: 100% !important; min-width: 0 !important; max-width: 100% !important;
            height: 34px !important; margin: 0 !important; padding: 0 10px !important; box-sizing: border-box !important;
            border: 1px solid var(--mt-pl-input-border, var(--mt-border)) !important; border-radius: 8px !important;
            outline: none !important; box-shadow: none !important; transform: none !important; scale: none !important; zoom: 1 !important; animation: none !important;
            background: var(--mt-pl-input-bg, var(--mt-bg-input, rgba(0,0,0,0.3))) !important; color: var(--mt-text, #fff) !important;
            font-size: 14px !important; line-height: 32px !important; font-family: inherit; transition: border-color .15s ease !important;
        }
        #moodtube-mini-player .mt-pl-inline .mt-pl-inline-input:focus,
        #moodtube-add-playlist-modal .mt-pl-inline .mt-pl-inline-input:focus,
        #moodtube-mini-player .mt-pl-inline .mt-pl-inline-input:focus-visible,
        #moodtube-add-playlist-modal .mt-pl-inline .mt-pl-inline-input:focus-visible { border-color: var(--mt-accent) !important; }
        #moodtube-mini-player .mt-pl-inline button, #moodtube-add-playlist-modal .mt-pl-inline button {
            display: flex !important; align-items: center !important; justify-content: center !important; flex: none !important;
            height: 34px !important; min-width: 0 !important; width: auto !important; margin: 0 !important; padding: 0 12px !important; box-sizing: border-box !important;
            border: none !important; border-radius: 8px !important; box-shadow: none !important; transform: none !important;
            font-size: 13px !important; line-height: 1 !important; white-space: nowrap !important; cursor: pointer; font-family: inherit;
        }
        #moodtube-mini-player .mt-pl-inline .mt-pl-inline-cancel, #moodtube-add-playlist-modal .mt-pl-inline .mt-pl-inline-cancel { width: 34px !important; padding: 0 !important; }
        .mt-pl-inline-ok { background: var(--mt-accent); color: var(--mt-text-on-accent, #111827); font-weight: 600; }
        .mt-pl-inline-cancel { background: rgba(255,255,255,0.08); color: var(--mt-text, #fff); }
        .mt-pl-inline button:disabled { opacity: 0.6; }

        /* Вкладки Spotify | MoodTube */
        .mt-pl-tabs { display: flex; gap: 4px; padding: 3px; margin-bottom: 10px; border-radius: 10px; background: rgba(0,0,0,0.25); }
        .mt-pl-tab {
            flex: 1 1 0; min-width: 0; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
            height: 30px; margin: 0; padding: 0 8px; box-sizing: border-box; border: none; border-radius: 8px; cursor: pointer;
            background: transparent; color: var(--mt-text-dim, #888); font-size: 12px; font-weight: 600; font-family: inherit;
            white-space: nowrap; overflow: hidden; text-overflow: ellipsis; transition: background 0.2s, color 0.2s;
        }
        .mt-pl-tab.mt-is-active { background: var(--mt-accent); color: var(--mt-text-on-accent, #111827); }
        .mt-pl-tab[data-mt-tab="spotify"].mt-is-active { background: var(--mt-pl-spotify-tab, #1DB954); color: var(--mt-pl-spotify-tab-text, #000); }
        .mt-pl-tabbed .mt-pl-section-label { display: none; }
        .mt-pl-tabbed .mt-pl-section-title-empty { display: none; }
        .mt-pl-tabbed .mt-pl-section-add { margin-left: auto; }
        .mt-btn-favorite.mt-is-active { color: var(--mt-accent); }

        /* Окно «Добавить в плейлист» */
        .mt-pl-modal {
            position: fixed; inset: 0; z-index: 9999999; display: flex; justify-content: center; align-items: center;
            background: var(--mt-overlay, rgba(0,0,0,0.6)); backdrop-filter: blur(5px); -webkit-backdrop-filter: blur(5px);
            font-family: -apple-system, sans-serif; text-shadow: none;
        }
        .mt-pl-modal * { text-shadow: none; }
        .mt-pl-modal-box {
            width: min(320px, calc(100vw - 32px)); max-height: 80vh; display: flex; flex-direction: column; box-sizing: border-box;
            background: var(--mt-bg-primary); background: linear-gradient(var(--mt-bg-primary), var(--mt-bg-primary)), var(--mt-bg-solid, #10151c);
            border: 1px solid var(--mt-border); border-radius: 12px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); color: var(--mt-text, #fff);
        }
        .mt-pl-modal-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 15px 6px; }
        .mt-pl-modal-title { font-weight: bold; }
        .mt-pl-modal-close { cursor: pointer; color: var(--mt-text-dim, #888); }
        .mt-pl-modal-track { padding: 0 15px 10px; font-size: 12px; color: var(--mt-text-dim, #888); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; border-bottom: 1px solid var(--mt-border); }
        .mt-pl-modal-body { flex: 1; overflow-y: auto; padding: 10px 12px; }
        .mt-pl-option {
            display: flex; align-items: center; gap: 10px; padding: 9px 10px; margin-bottom: 4px; border-radius: 8px; cursor: pointer;
            background: rgba(255,255,255,0.05); font-size: 13px; transition: background 0.2s;
        }
        .mt-pl-option:hover { background: rgba(255,255,255,0.1); transform: none; }
        .mt-pl-option-icon { flex-shrink: 0; width: 14px; text-align: center; color: var(--mt-text-dim, #888); }
        .mt-pl-option.mt-is-added .mt-pl-option-icon { color: var(--mt-accent); }
        .mt-pl-option.mt-is-busy { opacity: 0.6; }
        .mt-pl-option-name { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-queue-empty { font-size: 12px; color: var(--mt-text-dim, #888); text-align: center; padding: 10px; }

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

        /* ===== Вид «Полоса под шапкой таверны» (#moodtube-dock внутри #sheld) ===== */
        .mt-dock {
            position: relative; z-index: 31; flex-shrink: 0; box-sizing: border-box; overflow: hidden;
            color: var(--mt-text, #fff); font-family: -apple-system, sans-serif; user-select: none;
            background: var(--mt-dock-bg, var(--mt-bg-primary)); border-bottom: 1px solid var(--mt-border);
            backdrop-filter: blur(20px); -webkit-backdrop-filter: blur(20px);
        }
        .mt-dock, .mt-dock * { text-shadow: none; }
        .mt-dock.mt-dock-hidden { display: none; }
        .mt-dock-slot-bg { z-index: 0; background-image: var(--mt-img-dock, none); }
        .mt-dock-bar { position: relative; z-index: 1; }
        .mt-dock-panel { position: relative; z-index: 1; }
        .mt-dock-panel:empty { display: none; }
        /* Плеер внутри полосы: обычный блок на всю ширину, без перетаскивания и ресайза */
        .mt-player.mt-player-docked {
            position: relative !important; left: auto !important; top: auto !important; right: auto !important; bottom: auto !important;
            transform: none !important; width: 100% !important; height: var(--mt-dock-panel-height, min(340px, 50vh)) !important;
            z-index: auto; border-radius: 0; border: none; border-top: 1px solid var(--mt-border);
            box-shadow: none; backdrop-filter: none; -webkit-backdrop-filter: none; background: transparent; cursor: default;
        }
        .mt-player.mt-player-docked .mt-resize-handle { display: none; }
        .mt-player.mt-player-docked .mt-player-body { max-width: var(--mt-dock-panel-max-width, 520px); margin: 0 auto; }
        .mt-dock-close { font-size: 15px; color: var(--mt-text-dim, #888); }
        .mt-dock-inner {
            position: relative; z-index: 1; display: flex; align-items: center; gap: 10px; box-sizing: border-box;
            min-height: var(--mt-dock-height, 48px); padding: 6px 12px 8px;
        }
        .mt-dock-cover {
            width: var(--mt-dock-cover-size, 36px); height: var(--mt-dock-cover-size, 36px); flex-shrink: 0; overflow: hidden;
            border-radius: var(--mt-dock-cover-radius, 50%); border: 2px solid var(--mt-accent); background: #050505; box-sizing: border-box;
        }
        .mt-dock-cover-img { width: 100%; height: 100%; object-fit: cover; display: block; }
        .mt-dock-info { flex: 1; min-width: 0; display: flex; flex-direction: column; line-height: 1.25; }
        .mt-dock-title { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-dock-subtitle { font-size: 11px; font-weight: bold; color: var(--mt-accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .mt-dock-subtitle:empty { display: none; }
        .mt-dock-controls { display: flex; align-items: center; gap: 14px; flex-shrink: 0; }
        .mt-dock-btn { cursor: pointer; color: var(--mt-text, #fff); font-size: 16px; transition: color 0.2s, transform 0.2s; }
        .mt-dock-btn:hover { color: var(--mt-accent); transform: scale(1.1); }
        .mt-dock-play { font-size: 20px; width: 20px; text-align: center; }
        .mt-dock-fav, .mt-dock-ai { color: var(--mt-accent); }
        .mt-dock-ai { display: inline-flex; align-items: center; justify-content: center; }
        .mt-dock-ai.mt-is-busy { color: #00ff00; }
        .mt-dock-queue { font-size: 15px; color: var(--mt-accent); }
        .mt-dock-queue.mt-is-open { color: var(--mt-accent-hover, var(--mt-accent)); text-shadow: 0 0 6px var(--mt-accent); }
        .mt-dock-expand { font-size: 13px; color: var(--mt-text-dim, #888); }
        .mt-dock-expand.mt-is-open { color: var(--mt-accent); }
        .mt-dock-progress { position: absolute; left: 0; right: 0; bottom: 0; z-index: 2; height: 3px; cursor: pointer; background: var(--mt-dock-track, rgba(255,255,255,0.08)); }
        .mt-dock-progress::before { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 12px; }
        .mt-dock-progress-fill { height: 100%; width: 0; background: var(--mt-dock-progress, var(--mt-accent)); transition: width 0.5s linear; }
        .mt-dock.mt-is-idle .mt-dock-progress-fill { width: 0 !important; }
        @media (max-width: 420px) {
            .mt-dock-controls { gap: 12px; }
        }
        @media (max-width: 340px) {
            .mt-dock-controls { gap: 10px; }
            .mt-dock-fav { display: none; }
        }

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
                        <i class="fa-solid fa-list-check moodtube-ctrl mt-btn mt-btn-accent mt-btn-small mt-btn-playlists" id="moodtube-btn-spotify-playlists" title="Плейлисты"></i>
                    </div>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl mt-btn mt-panel-close" id="moodtube-btn-close-queue" title="Скрыть"></i>
                </div>
                <div id="moodtube-queue-list" class="mt-panel-list">
                    <div class="mt-queue-empty">Очередь пуста</div>
                </div>
            </div>

            <div id="moodtube-spotify-playlists-container" class="mt-panel mt-panel-playlists" style="display:none;">
                <div class="mt-panel-header">
                    <div class="mt-panel-header-left">
                        <i class="fa-solid fa-chevron-left moodtube-ctrl mt-btn mt-btn-small mt-pl-back" id="moodtube-btn-playlists-back" style="display:none;" title="Назад к плейлистам"></i>
                        <span class="mt-panel-title" id="moodtube-playlists-title">Плейлисты</span>
                    </div>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl mt-btn mt-panel-close" id="moodtube-btn-close-playlists" title="Скрыть"></i>
                </div>
                <div id="moodtube-playlists-list" class="mt-panel-list"></div>
            </div>

            <audio id="moodtube-audio-fallback" style="display:none;"></audio>

            <div id="moodtube-search-container" class="mt-panel mt-panel-search" style="display:none;">
                <div class="mt-panel-header">
                    <span class="mt-panel-title">Найти трек</span>
                </div>
                <div class="mt-search-row">
                    <input type="text" id="moodtube-search-input" class="moodtube-ctrl" placeholder="Название или ссылка YouTube" autocomplete="off">
                    <button id="moodtube-search-go" class="moodtube-ctrl"><i class="fa-solid fa-play"></i></button>
                </div>
                <div class="mt-search-hint">Трек включится сразу. Ссылка на плейлист YouTube — весь плейлист встанет в очередь.</div>
            </div>

            <i class="fa-solid fa-magnifying-glass moodtube-ctrl mt-btn mt-window-btn mt-btn-search" id="moodtube-btn-search" title="Найти трек"></i>
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
    background-color: var(--mt-overlay, rgba(10, 15, 20, 0.55));
    z-index: 999999 !important;
    backdrop-filter: blur(35px);
    font-family: 'Inter', 'Segoe UI', sans-serif;
}
.mt-flex-center {
    display: flex; align-items: center; justify-content: center;
    width: 100%; height: 100%; padding: 15px; box-sizing: border-box;
}
#mt-settings-modal .mt-flex-container {
    display: flex; flex-direction: column;
    width: 100%; max-width: 480px; max-height: 92dvh;
    background-color: var(--mt-bg-primary);
    backdrop-filter: blur(45px);
    border: 1px solid var(--mt-border);
    border-radius: 16px;
    box-shadow: var(--mt-modal-shadow, 0 30px 60px rgba(0,0,0,0.9));
    overflow: hidden; box-sizing: border-box; color: var(--mt-text, #E5E7EB);
}
.mt-header {
    display: flex; justify-content: space-between; align-items: center;
    padding: 18px 22px;
    background-color: var(--mt-bg-secondary);
    flex-shrink: 0;
    border-bottom: 1px solid var(--mt-border);
}
.mt-header h3 { margin: 0; font-size: 1.15em; font-weight: 600; color: var(--mt-text, #E5E7EB); letter-spacing: 0.5px; }
.mt-header-icon { margin-right: 8px; color: var(--mt-accent); }
.mt-close { cursor: pointer; font-size: 1.2em; color: var(--mt-text-dim, #9CA3AF); transition: color 0.2s; }
.mt-close:hover { color: var(--mt-text-strong, var(--mt-text, #fff)); }
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
#mt-settings-modal .mt-cat-title i:first-child { font-size: 1em; width: 20px; text-align: center; color: var(--mt-accent); }
.mt-cat-title h4 {
    margin: 0; font-size: 0.88em; font-weight: 500;
    text-transform: uppercase; letter-spacing: 1px; flex-grow: 1; color: var(--mt-text-soft, var(--mt-text, #D1D5DB));
}
.mt-chevron { color: var(--mt-text-dim, #8c93a1); font-size: 0.75em; transition: transform 0.3s ease; }
.mt-chevron.open { transform: rotate(180deg); }
.mt-cat-content { display: none; padding: 10px 14px 14px 14px; box-sizing: border-box; }
.mt-cat-content.open { display: block; }
.mt-tag {
    display: inline-block; padding: 7px 13px; margin: 0 5px 7px 0;
    background-color: rgba(45,45,50,0.8);
    border: 1px solid rgba(255,255,255,0.1); border-radius: 8px;
    cursor: pointer; user-select: none;
    font-size: 0.82em; font-weight: 500; color: var(--mt-text-soft, var(--mt-text, #D1D5DB));
    transition: all 0.2s ease;
    box-shadow: 0 2px 5px rgba(0,0,0,0.2);
}

.mt-tag:active { transform: scale(0.96); }
/* Genre tags */
.mt-genre-tag:hover { border-color: var(--mt-accent); color: var(--mt-text-strong, var(--mt-text, #fff)); background-color: rgba(255, 255, 255, 0.1); }
.mt-genre-tag.active { background-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); border-color: var(--mt-accent); font-weight: 600; box-shadow: 0 0 10px var(--mt-border); }
/* Mood tags */
.mt-mood-tag:hover { border-color: var(--mt-accent); color: var(--mt-text-strong, var(--mt-text, #fff)); background-color: rgba(255, 255, 255, 0.1); }
.mt-mood-tag.active { background-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); border-color: var(--mt-accent); font-weight: 600; box-shadow: 0 0 10px var(--mt-border); }
/* Scenario tags */
.mt-scenario-tag:hover { border-color: var(--mt-accent); color: var(--mt-text-strong, var(--mt-text, #fff)); background-color: rgba(255, 255, 255, 0.1); }
.mt-scenario-tag.active { background-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); border-color: var(--mt-accent); font-weight: 600; box-shadow: 0 0 10px var(--mt-border); }
/* API section */
.mt-input-field {
    background: var(--mt-bg-input); border: 1px solid var(--mt-border);
    border-radius: 8px; color: var(--mt-text, #E5E7EB); padding: 8px 10px;
    font-size: 0.85em; outline: none; transition: 0.2s;
    width: 100%; box-sizing: border-box; font-family: inherit;
}
.mt-input-field:focus { border-color: var(--mt-accent); background: var(--mt-bg-secondary); }
.mt-input-field::placeholder { color: var(--mt-text-placeholder, var(--mt-text-dim, #6B7280)); }
.mt-label { display: block; font-size: 0.82em; color: var(--mt-text-dim, #9CA3AF); margin-bottom: 4px; margin-top: 8px; }
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
.mt-sum-genre { background-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); }
.mt-sum-mood { background-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); }
.mt-sum-scenario { background-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); }
.mt-btn-save {
    width: 100%; padding: 12px; border: none; border-radius: 8px;
    background: var(--mt-accent); color: var(--mt-text-on-accent, #000); font-weight: 600;
    font-size: 0.95em; cursor: pointer; transition: 0.2s; letter-spacing: 0.5px;
}
.mt-btn-save:hover { filter: brightness(1.15); }
.mt-btn-test {
    width: 100%; padding: 10px; margin-top: 8px;
    background: rgba(255,255,255,0.07); color: var(--mt-text, #E5E7EB);
    border: 1px solid rgba(255,255,255,0.15); border-radius: 8px;
    cursor: pointer; font-weight: 500; font-size: 0.85em; transition: 0.2s;
}
.mt-btn-test:hover { background: rgba(255,255,255,0.12); border-color: var(--mt-accent); }
.mt-checkbox-row {
    display: flex; align-items: center; gap: 8px; cursor: pointer;
    padding: 4px 0; font-size: 0.9em; color: var(--mt-text-soft, var(--mt-text, #D1D5DB));
}
.mt-checkbox-row input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; accent-color: var(--mt-accent); }
/* Подпанели: редактор темы, настройки Spotify */
.mt-subpanel { padding: 10px; margin-top: 10px; background: rgba(0,0,0,0.2); border: 1px solid var(--mt-border); border-radius: 8px; }
.mt-label-strong { color: var(--mt-text-soft, var(--mt-text, #D1D5DB)); }
.mt-label-accent { color: var(--mt-accent); }
.mt-input-field.mt-input-readonly { background: rgba(0,0,0,0.4); color: var(--mt-text-dim, #9CA3AF); }
.mt-status-text { margin-top: 8px; font-size: 0.85em; color: var(--mt-text-dim, #9CA3AF); }
.mt-censor { margin-top: 14px; padding: 12px 16px; border-radius: 12px; background-color: var(--mt-bg-secondary); border: 1px solid var(--mt-border); }
.mt-censor .mt-checkbox-row { font-weight: 600; }
.mt-censor-char { margin-top: 8px; }
.mt-catalog-row { display: flex; gap: 6px; align-items: center; }
.mt-catalog-row .mt-input-field { flex: 1; min-width: 0; }
.mt-catalog-row .mt-btn-test { width: auto; margin-top: 0; padding: 8px 12px; white-space: nowrap; flex-shrink: 0; }
.mt-catalog-list { margin-top: 10px; }
.mt-catalog-head { display: flex; flex-direction: column; gap: 6px; margin-bottom: 8px; }
.mt-catalog-title { font-size: 0.8em; font-weight: 600; color: var(--mt-text-dim, #9CA3AF); }
.mt-catalog-status { font-size: 0.82em; color: var(--mt-text-dim, #9CA3AF); padding: 6px 2px; }
.mt-catalog-error { color: #f87171; }
.mt-catalog-filters { display: flex; flex-direction: column; gap: 6px; }
.mt-catalog-tagbar { display: flex; flex-wrap: wrap; gap: 4px; }
.mt-catalog-filter {
    padding: 3px 9px; border-radius: 999px; border: 1px solid var(--mt-border); cursor: pointer;
    background: transparent; color: var(--mt-text-dim, #9CA3AF); font-size: 0.72em; font-family: inherit;
}
.mt-catalog-filter.mt-is-active { background: var(--mt-accent); border-color: var(--mt-accent); color: var(--mt-text-on-accent, #111827); font-weight: 600; }
/* Сетка: 2 колонки в окне настроек и на телефоне, больше — если окно шире */
.mt-catalog-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(120px, 100%), 1fr)); gap: 8px; }
.mt-catalog-card {
    display: flex; flex-direction: column; min-width: 0; overflow: hidden;
    border-radius: 10px; background: var(--mt-bg-input); border: 1px solid var(--mt-border);
}
.mt-catalog-preview {
    position: relative; aspect-ratio: 4 / 3; overflow: hidden;
    display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.25); color: var(--mt-text-dim, #9CA3AF);
}
.mt-catalog-preview img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; opacity: 0; transition: opacity .2s; }
.mt-catalog-preview.mt-has-img img { opacity: 1; }
.mt-catalog-preview.mt-has-img > i { display: none; }
.mt-catalog-body { display: flex; flex-direction: column; gap: 4px; padding: 7px 8px 8px; flex: 1; min-width: 0; }
.mt-catalog-name { font-weight: 600; font-size: 0.86em; color: var(--mt-text, #E5E7EB); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mt-catalog-meta { font-size: 0.72em; color: var(--mt-text-dim, #9CA3AF); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.mt-catalog-meta:empty { display: none; }
.mt-catalog-desc {
    font-size: 0.74em; color: var(--mt-text-soft, var(--mt-text, #D1D5DB));
    display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
}
.mt-catalog-desc:empty { display: none; }
.mt-catalog-variant { padding: 5px 8px; font-size: 0.78em; }
.mt-catalog-variants { display: flex; flex-wrap: wrap; gap: 5px; }
.mt-catalog-swatch {
    width: 18px; height: 18px; padding: 0; border-radius: 50%; cursor: pointer;
    border: 2px solid rgba(255,255,255,0.25); box-sizing: border-box;
}
.mt-catalog-swatch.mt-is-active { border-color: var(--mt-text, #fff); box-shadow: 0 0 0 2px var(--mt-accent); }
.mt-catalog-install { margin-top: auto; width: 100%; padding: 6px 8px; }
.mt-catalog-install:disabled { opacity: 0.5; cursor: not-allowed; }
.mt-divider { border: 0; border-top: 1px solid var(--mt-divider, rgba(255,255,255,0.05)); margin: 15px 0; }
#mt-settings-modal code { background: var(--mt-bg-input); color: inherit; padding: 0 4px; border-radius: 4px; border: none; }
@media (max-width: 600px) {
    /* На телефоне окно на весь экран фиксированной высоты: при раскрытии вкладок не прыгает. */
    #mt-settings-modal .mt-flex-container { max-width: 100%; height: 100vh; height: 100dvh; max-height: 100dvh; border-radius: 0; border: none; }
    #mt-settings-modal .mt-flex-center { padding: 0; }
}
</style>`).appendTo('head');

        $(`
        <div id="mt-settings-modal">
            <div class="mt-flex-center">
                <div class="mt-flex-container">
                    <div class="mt-header">
                        <h3><i class="fa-solid fa-sliders mt-header-icon"></i>MoodTube</h3>
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
                                <label class="mt-checkbox-row">
                                    <input type="checkbox" id="moodtube-setting-fab">
                                    <span>Включить плавающую кнопку</span>
                                </label>
                                <hr class="mt-divider">
                                <span class="mt-label" style="margin-top:0;">Вид плеера</span>
                                <select id="moodtube-setting-layout" class="mt-input-field">
                                    <option value="floating">Плавающая плашка (по умолчанию)</option>
                                    <option value="dock">Шапка сверху (полоса под шапкой таверны)</option>
                                </select>
                                <hr class="mt-divider">
                                <span class="mt-label" style="margin-top:0;">Тема оформления</span>
                                <select id="moodtube-setting-theme" class="mt-input-field">
                                    <option value="blue">Blue (Default)</option>
                                    <option value="grey">Grey</option>
                                    <option value="rose">Rose</option>
                                    <option value="emerald">Emerald</option>
                                    <option value="auto">Tavern Auto</option>
                                    <option value="custom">Custom (свой CSS)</option>
                                </select>
                                <div id="mt-custom-theme-block" class="mt-subpanel mt-theme-editor" style="display:none;">
                                    <span class="mt-label mt-label-accent" style="margin-top:0;"><i class="fa-solid fa-palette"></i> Кастомная тема</span>
                                    <div class="mt-catalog">
                                        <span class="mt-label">Каталог тем (ссылка на index.json)</span>
                                        <div class="mt-catalog-row">
                                            <input type="text" id="mt-catalog-url" class="mt-input-field" placeholder="https://raw.githubusercontent.com/<user>/<repo>/main/index.json" autocomplete="off" spellcheck="false">
                                            <button id="mt-catalog-load" class="mt-btn-test"><i class="fa-solid fa-cloud-arrow-down"></i> Загрузить</button>
                                        </div>
                                        <span class="mt-label" style="margin-top:4px; font-size:0.74em;">Ссылки https с raw.githubusercontent.com, cdn.jsdelivr.net или *.github.io. Тема подставится в редактор, применится она после «Сохранить».</span>
                                        <div id="mt-catalog-list" class="mt-catalog-list" style="display:none;"></div>
                                    </div>
                                    <hr class="mt-divider">
                                    <span class="mt-label">Название темы</span>
                                    <input type="text" id="mt-custom-theme-name" class="mt-input-field" placeholder="My MoodTube Theme">
                                    <span class="mt-label">Цвета (HEX или rgba)</span>
                                    <div id="mt-custom-vars" style="display:grid; grid-template-columns:repeat(auto-fit, minmax(200px, 1fr)); gap:6px 10px;">
                                        ${MT_THEME_VARS.map(v => `
                                        <div>
                                            <span class="mt-label" style="margin-top:2px; font-size:0.76em;">${v.label} <code style="opacity:0.6;">${v.css}</code></span>
                                            <div style="display:flex; gap:6px; align-items:center;">
                                                <input type="color" id="mt-custom-pick-${v.key}" data-mt-var="${v.key}" class="mt-custom-pick" style="width:34px; height:30px; padding:0; border:none; background:none; cursor:pointer; flex-shrink:0;">
                                                <input type="text" id="mt-custom-var-${v.key}" class="mt-input-field mt-custom-var" placeholder="${v.def || (v.hint + ' (по умолчанию)')}">
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
                                
                                <div id="moodtube-spotify-settings" class="mt-subpanel mt-spotify-settings" style="display:none;">
                                    <span class="mt-label mt-label-accent" style="margin-top:0;"><i class="fa-brands fa-spotify"></i> Spotify Настройки</span>
                                    <span class="mt-label">Client ID</span>
                                    <input type="text" id="moodtube-spotify-client-id" class="mt-input-field" placeholder="Client ID">
                                    <span class="mt-label" style="margin-top:8px;">Точный Redirect URI (скопируйте в Dashboard)</span>
                                    <div style="display:flex; gap: 8px; margin-top:4px;">
                                        <input type="text" id="moodtube-spotify-redirect-show" class="mt-input-field mt-input-readonly" readonly style="flex:1;">
                                        <button id="moodtube-btn-copy-redirect" class="mt-btn-test" style="margin-top:0; width:auto; padding: 8px 12px;" title="Скопировать"><i class="fa-regular fa-copy"></i></button>
                                    </div>
                                    <button id="moodtube-btn-spotify-auth" class="mt-btn-test" style="margin-top: 10px;">Авторизоваться</button>
                                    <div id="moodtube-spotify-status" class="mt-status-text"></div>
                                    <span class="mt-label" style="margin-top:12px;">Сердечко ❤ сохраняет в</span>
                                    <select id="moodtube-fav-target" class="mt-input-field">
                                        <option value="both">Любимые Spotify и Любимые MoodTube</option>
                                        <option value="spotify">Только любимые Spotify</option>
                                        <option value="moodtube">Только Любимые MoodTube</option>
                                    </select>
                                    <span class="mt-label">Кнопка «+» в очереди показывает</span>
                                    <select id="moodtube-plus-target" class="mt-input-field">
                                        <option value="both">Плейлисты Spotify и MoodTube</option>
                                        <option value="spotify">Только плейлисты Spotify</option>
                                        <option value="moodtube">Только плейлисты MoodTube</option>
                                    </select>
                                    <span class="mt-label" style="font-size:0.76em;">Плейлисты MoodTube хранятся в настройках таверны — общие для всех устройств.</span>
                                </div>
                                
                                <hr class="mt-divider">

                                <span class="mt-label" style="margin-top:0;">Количество треков для генерации за раз</span>
                                <input type="number" id="moodtube-bulk-count" value="10" min="1" max="30" class="mt-input-field" style="width: 100px;">
                                
                                <hr class="mt-divider">

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
                                
                                <hr class="mt-divider">
                                
                                <span class="mt-label mt-label-strong" style="margin-top:0;">Жесткое правило (Hard Rule) для промпта</span>
                                <span class="mt-label" style="margin-top:4px; font-size:0.78em;">Команда, заставляющая ИИ включить то, что вы написали в чате</span>
                                <input type="text" id="moodtube-setting-hard-rule" class="mt-input-field" placeholder='[OOC: Start the music: {"Title": "_", "Artist": "_"}]'>

                                <hr class="mt-divider">

                                <span class="mt-label mt-label-strong" style="margin-top:0;">Кастомный промпт (заменяет стандартный полностью)</span>
                                <span class="mt-label" style="margin-top:4px; font-size:0.78em;">Макросы: <b>{{snippet}}</b> — история чата, <b>{{history}}</b> — проигранные треки</span>
                                <textarea id="moodtube-setting-custom" class="mt-input-field" style="resize:vertical; min-height:100px; margin-top:8px;"></textarea>
                            </div>
                        </div>

                        <div class="mt-censor">
                            <label class="mt-checkbox-row">
                                <input type="checkbox" id="moodtube-setting-censor">
                                <span>Цензура</span>
                            </label>
                            <select id="moodtube-setting-censor-char" class="mt-input-field mt-censor-char">
                                ${Object.entries(MT_CENSOR_CHARS).map(([code, label]) => `<option value="${code}">${label}</option>`).join('')}
                            </select>
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
                            togglePlayerUI();
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
        
        $('#moodtube-btn-favorite').on('click', () => toggleFavoriteCurrent());

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
            updateQueueUI();
        });

        $('#moodtube-btn-close-queue').on('click', () => {
            $('#moodtube-queue-container').hide();
            $('#moodtube-inner-content').css('display', '');
            $('#moodtube-btn-close').show();
        });

        $('#moodtube-btn-spotify-playlists').on('click', () => {
            showPlaylistsPanel();
        });
        $('#moodtube-btn-playlists-back').on('click', () => renderPlaylistsList());

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

        // --- Поиск по лупе: название или ссылка YouTube (видео / плейлист) ---
        const runSearch = async () => {
            const q = String($('#moodtube-search-input').val() || '').trim();
            if (!q) return;
            const $go = $('#moodtube-search-go').prop('disabled', true);
            try {
                const res = await playAnything(q);
                if (res) {
                    $('#moodtube-search-input').val('');
                    $('#moodtube-search-container').hide();
                    $('#moodtube-btn-search').removeClass('mt-is-open');
                    if (res.count > 1) toastr.success(`Плейлист «${res.title}»: ${res.count} треков в очереди`, 'MoodTube');
                } else {
                    toastr.warning('Ничего не нашлось', 'MoodTube');
                }
            } finally {
                $go.prop('disabled', false);
            }
        };
        const setSearchOpen = (open) => {
            $('#moodtube-search-container').toggle(open);
            $('#moodtube-btn-search').toggleClass('mt-is-open', open).attr('title', open ? 'Закрыть поиск' : 'Найти трек');
            if (open) setTimeout(() => $('#moodtube-search-input').trigger('focus'), 50);
        };
        $('#moodtube-btn-search').on('click', () => setSearchOpen(!$('#moodtube-search-container').is(':visible')));
        $('#moodtube-search-go').on('click', runSearch);
        $('#moodtube-search-input').on('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); runSearch(); }
            if (e.key === 'Escape') { e.preventDefault(); setSearchOpen(false); }
        });

        // --- Open settings ---
        $('#moodtube-btn-settings').on('click', () => {
            $('#mt-settings-modal').css('display', 'block');
            
            loadProfiles();

            // Load plain inputs
            $('#moodtube-setting-theme').val(localStorage.getItem('moodtube_theme') || 'blue');
            fillCustomThemeForm(loadCustomTheme());
            toggleCustomThemeBlock();
            try { if (!$('#mt-catalog-url').val()) $('#mt-catalog-url').val(localStorage.getItem(MT_CATALOG_URL_KEY) || ''); } catch (e) {}
            $('#moodtube-playback-source').val(localStorage.getItem('moodtube_playback_source') || 'youtube').trigger('change');
            $('#moodtube-spotify-client-id').val(localStorage.getItem('moodtube_spotify_client_id') || '');
            $('#moodtube-fav-target').val(mtSpotifyTarget('fav'));
            $('#moodtube-plus-target').val(mtSpotifyTarget('plus'));
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
            $('#moodtube-setting-layout').val(getPlayerLayout());
            
            let bs = localStorage.getItem('moodtube_global_banned_songs');
            if (bs === null) bs = getMtSetting('banned_songs') || '';
            $('#moodtube-setting-banned-songs').val(bs);
            $('#moodtube-setting-banlist').val(getMtSetting('banlist'));
            $('#moodtube-setting-favorites-list').val(getMtSetting('favorites'));
            $('#moodtube-setting-favorites-context').prop('checked', getMtSetting('favorites_context') === 'true');
            $('#moodtube-setting-hard-rule').val(getMtSetting('hard_rule'));
            $('#moodtube-setting-custom').val(getMtSetting('custom'));
            $('#moodtube-setting-censor').prop('checked', isCensorOn());
            $('#moodtube-setting-censor-char').val(getCensorCode()).toggle(isCensorOn());

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
        $('#mt-catalog-load').on('click', () => loadThemeCatalog($('#mt-catalog-url').val()));
        $('#moodtube-setting-censor').on('change', function() { $('#moodtube-setting-censor-char').toggle(this.checked); });
        $('#mt-catalog-url').on('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); loadThemeCatalog($('#mt-catalog-url').val()); } });
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
            localStorage.setItem('moodtube_fav_target', $('#moodtube-fav-target').val());
            localStorage.setItem('moodtube_plus_target', $('#moodtube-plus-target').val());
            if (source === 'spotify') initSpotifyPlayer();
            
            const fabEnabled = $('#moodtube-setting-fab').is(':checked');
            localStorage.setItem('moodtube_fab_enable', fabEnabled ? 'true' : 'false');
            const layout = $('#moodtube-setting-layout').val() === 'dock' ? 'dock' : 'floating';
            const layoutChanged = layout !== getPlayerLayout();
            localStorage.setItem(MT_LAYOUT_KEY, layout);
            applyPlayerLayout();
            // Переключились на полосу — плавающее окно прячем, оно открывается кнопкой на полосе
            if (layoutChanged && layout === 'dock') { isPlayerFolded = true; updatePlayerVisibility(); setDockHidden(false); }
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
            localStorage.setItem(MT_CENSOR_KEY, $('#moodtube-setting-censor').is(':checked') ? 'true' : 'false');
            localStorage.setItem(MT_CENSOR_CHAR_KEY, $('#moodtube-setting-censor-char').val() || '2005');

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
                    if (getPlayerLayout() === 'dock') applyPlayerLayout();
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
                
                // В панели под шапкой — всегда полный вертикальный вид
                const docked = entry.target.classList.contains('mt-player-docked');
                $p.toggleClass('moodtube-row-layout', !docked && w > h * 1.3 && w > 280);
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
    applyPlayerLayout();
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

// Ссылки YouTube: id плейлиста и видео.
function parseYouTubeLink(text) {
    const t = String(text || '').trim();
    if (!/youtu\.?be|youtube\.com/i.test(t) && !/^(PL|OL|RD|UU|LL|FL)[\w-]{10,}$/.test(t)) return null;
    const list = t.match(/[?&]list=([\w-]+)/)?.[1] || (/^(PL|OL|RD|UU|LL|FL)[\w-]{10,}$/.test(t) ? t : null);
    const video = t.match(/[?&]v=([\w-]{11})/)?.[1] || t.match(/youtu\.be\/([\w-]{11})/)?.[1] || t.match(/\/(?:shorts|embed|live)\/([\w-]{11})/)?.[1] || null;
    return list || video ? { list, video } : null;
}

const pipedId = (url) => String(url || '').match(/[?&]v=([\w-]{11})/)?.[1] || String(url || '').split('/').pop();

// Плейлист YouTube через Piped / Invidious: { title, tracks: [{ videoId, title, thumbnail }] }.
async function fetchPlaylist(listId) {
    try {
        return await Promise.any(PIPED_INSTANCES.map(async url => {
            const r = await fetchWithTimeout(`${url}/playlists/${listId}`, {}, 6000);
            if (!r.ok) throw new Error('bad');
            const d = await r.json();
            const tracks = (d.relatedStreams || []).map(x => ({ videoId: pipedId(x.url), title: x.title, thumbnail: x.thumbnail })).filter(x => x.videoId);
            if (!tracks.length) throw new Error('empty');
            return { title: d.name || 'Плейлист', tracks };
        }));
    } catch { /* дальше Invidious */ }
    try {
        // Для плейлистов берём все Invidious с API (у части не стоит отметка cors, хотя он есть), плюс обычный список.
        let all = [];
        try {
            const r = await fetchWithTimeout('https://api.invidious.io/instances.json?sort_by=health', {}, 6000);
            if (r.ok) all = (await r.json()).filter(d => d[1]?.type === 'https' && d[1]?.api === true).map(d => d[1].uri);
        } catch { /* только обычный список */ }
        const inst = [...new Set([...all, ...(await getInvidiousInstances())])].slice(0, 12);
        return await Promise.any(inst.map(async url => {
            const r = await fetchWithTimeout(`${url}/api/v1/playlists/${listId}`, {}, 6000);
            if (!r.ok) throw new Error('bad');
            const d = await r.json();
            const tracks = (d.videos || []).map(x => ({ videoId: x.videoId, title: x.title, thumbnail: x.videoThumbnails?.[0]?.url || `https://i.ytimg.com/vi/${x.videoId}/hqdefault.jpg` })).filter(x => x.videoId);
            if (!tracks.length) throw new Error('empty');
            return { title: d.title || 'Плейлист', tracks };
        }));
    } catch { return null; }
}

// Название видео по id (для ссылки на одно видео).
async function fetchVideoTitle(videoId) {
    try {
        return await Promise.any(PIPED_INSTANCES.map(async url => {
            const r = await fetchWithTimeout(`${url}/streams/${videoId}`, {}, 5000);
            if (!r.ok) throw new Error('bad');
            const d = await r.json();
            if (!d.title) throw new Error('no title');
            return d.title;
        }));
    } catch { return 'YouTube'; }
}

// Включить плейлист: первый трек сразу, остальные следом в очереди.
async function playPlaylist(listId) {
    const pl = await fetchPlaylist(listId);
    if (!pl) return null;
    const objs = pl.tracks.map(t => ({ title: t.title, originalQuery: t.title, videoId: t.videoId, videoThumbnails: t.thumbnail ? [{ url: t.thumbnail }] : [], isValidated: true }));
    const insertAt = Math.max(currentQueueIndex, -1) + 1;
    trackQueue.splice(insertAt, 0, ...objs);
    currentQueueIndex = insertAt;
    updateQueueUI();
    playTrack(objs[0]);
    return { title: pl.title, count: objs.length, tracks: pl.tracks };
}

// Что угодно из поля: ссылка на плейлист, ссылка на видео или название.
async function playAnything(text) {
    const link = parseYouTubeLink(text);
    if (link?.list) {
        const res = await playPlaylist(link.list);
        if (res || !link.video) return res;
    }
    if (link?.video) {
        const title = await fetchVideoTitle(link.video);
        playFound({ videoId: link.video, title, thumbnail: `https://i.ytimg.com/vi/${link.video}/hqdefault.jpg` }, title);
        return { title, count: 1 };
    }
    return (await playQuery(text)) ? { title: text, count: 1 } : null;
}

// Поиск без проигрывания — для карточки трека в других расширениях (Telegram).
async function search(query) {
    if (typeof query !== 'string' || !query.trim()) return null;
    query = query.trim();
    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
    const v = source === 'spotify'
        ? (await searchSpotify(query) || await searchYouTube(query))
        : await searchYouTube(query);
    if (!v || (!v.videoId && !v.streamUrl)) return null;
    return {
        title: v.title,
        videoId: v.videoId || null,
        thumbnail: v.videoThumbnails?.[0]?.url || (v.videoId ? `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg` : ''),
        duration: Number(v.lengthSeconds || v.duration) || 0,
        ...(v.streamUrl ? { streamUrl: v.streamUrl } : {}),
    };
}

// Включить уже найденный трек (из search) — без повторного поиска. Встаёт сразу после текущего.
function playFound(found, originalQuery = '') {
    if (!found || (!found.videoId && !found.streamUrl)) return false;
    const trackObj = {
        title: found.title,
        originalQuery: originalQuery || found.title,
        videoId: found.videoId,
        videoThumbnails: found.thumbnail ? [{ url: found.thumbnail }] : [],
        isValidated: true,
    };
    if (found.streamUrl) {
        trackObj.streamUrl = found.streamUrl;
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
            version: 6,
            search,
            playFound,
            fetchPlaylist,
            playPlaylist,
            playAnything,
            parseYouTubeLink,
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
        console.log(`${LOG_PREFIX} MoodTubeAPI v6 готов`);
    }, 1600);
});
