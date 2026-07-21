

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
            $list.append('<div style="font-size:12px; color:#888; text-align:center; padding:10px;">Плейлисты не найдены. Создайте новый в меню трека.</div>');
            return;
        }
        
        playlists.forEach(pl => {
            if (!pl || !pl.id) return;
            const imgUrl = (pl.images && pl.images.length > 0) ? pl.images[0].url : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
            const $item = $(`
                <div style="display:flex; align-items:center; gap:10px; padding:8px 10px; cursor:pointer; border-radius:10px; margin-bottom:5px; background:rgba(0,0,0,0.3); border:1px solid transparent; transition:0.2s;">
                    <img src="${imgUrl}" style="width:30px; height:30px; border-radius:5px; object-fit:cover; flex-shrink:0;">
                    <div style="flex:1; overflow:hidden;">
                        <div style="font-weight:bold; font-size:13px; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${pl.name || 'Без названия'}</div>
                    </div>
                </div>
            `);
            $item.hover(function(){ $(this).css('background', 'rgba(255,255,255,0.1)'); }, function(){ $(this).css('background', 'rgba(0,0,0,0.3)'); });
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
    $('#moodtube-widget-cover').attr('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    if (track.videoThumbnails && track.videoThumbnails.length > 0) {
        $('#moodtube-widget-cover').attr('src', track.videoThumbnails[0].url);
    } else if (track.videoId) {
        $('#moodtube-widget-cover').attr('src', `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`);
    }
    
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
                }).then(() => {
                    isCurrentlyPlaying = true;
                    $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-pause moodtube-ctrl');
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
        if (copy.streamUrl && copy.streamUrl.startsWith('blob:')) {
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
            if (t.streamUrl && t.streamUrl.startsWith('blob:')) t.streamUrl = null;
        });
        currentQueueIndex = c.currentIndex !== undefined ? c.currentIndex : -1;
        sessionPlayedTracks = c.playedTracks || [];
        updateQueueUI(true);
        if (currentQueueIndex >= 0 && currentQueueIndex < trackQueue.length) {
            const track = trackQueue[currentQueueIndex];
            $('#moodtube-widget-title').text(track.title || 'YouTube Track');
            if (track.videoThumbnails && track.videoThumbnails.length > 0) {
                $('#moodtube-widget-cover').attr('src', track.videoThumbnails[0].url);
            } else if (track.videoId) {
                $('#moodtube-widget-cover').attr('src', `https://i.ytimg.com/vi/${track.videoId}/mqdefault.jpg`);
            } else {
                $('#moodtube-widget-cover').attr('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
            }
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
            } else if (track.videoId && ytPlayer && typeof ytPlayer.cueVideoById === 'function') {
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

function updateQueueUI(skipSave = false) {
    const $qList = $('#moodtube-queue-list');
    if (!$qList.length) return;
    
    $qList.empty();
    if (trackQueue.length === 0) {
        $qList.append('<div style="font-size:12px; color:#888; text-align:center; padding:10px;">Очередь пуста</div>');
        if (!skipSave) saveQueueCache();
        return;
    }

    trackQueue.forEach((track, index) => {
        const isCurrent = index === currentQueueIndex;
        const isSpotifyTrack = track.videoId && track.videoId.startsWith('spotify:');
        const showSpotifyAdd = isSpotifyTrack && (localStorage.getItem('moodtube_playback_source') === 'spotify');
        const $item = $(`
            <div class="moodtube-queue-item" style="
                display:flex; align-items:center; gap:10px; padding:8px 10px; 
                cursor:pointer; border-radius:10px; margin-bottom:5px;
                background: ${isCurrent ? 'rgba(255, 255, 255, 0.05)' : 'rgba(0,0,0,0.3)'};
                border: 1px solid ${isCurrent ? 'var(--mt-accent)' : 'transparent'};
                transition: 0.2s;
            ">
                <img src="${(track.videoThumbnails && track.videoThumbnails.length > 0) ? track.videoThumbnails[0].url : (track.videoId && !track.videoId.startsWith('spotify:') ? `https://i.ytimg.com/vi/${track.videoId}/default.jpg` : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7')}" style="width:30px; height:30px; border-radius:5px; object-fit:cover; flex-shrink:0; ${!track.videoId ? 'background:rgba(255,255,255,0.1);' : ''}">
                <span style="font-size:12px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; flex:1; color:${track.isExhausted ? '#ff6b6b' : (isCurrent ? '#fff' : '#aaa')};">
                    ${track.isExhausted ? '❌ Заблокировано: ' : ''}${track.title}
                </span>
                ${isCurrent ? '<i class="fa-solid fa-volume-high" style="color:var(--mt-accent); font-size:10px; margin-right:5px;"></i>' : ''}
                ${showSpotifyAdd ? '<div class="moodtube-btn-add-playlist moodtube-ctrl" style="width:16px; height:16px; display:flex; justify-content:center; align-items:center; cursor:pointer;" title="Добавить в плейлист Spotify"><i class="fa-solid fa-plus" style="font-size:12px; color:var(--mt-accent);"></i></div>' : ''}
                <div class="moodtube-btn-dislike moodtube-ctrl" style="width:16px; height:16px; background-color:rgba(235, 120, 120, 0.65); -webkit-mask: url(https://img.icons8.com/ios-filled/50/dislike.png) no-repeat center / contain; mask: url(https://img.icons8.com/ios-filled/50/dislike.png) no-repeat center / contain; cursor:pointer;" title="Не нравится (В бан-лист)"></div>
            </div>
        `);
        
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
}

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
        
        let genre = getMtSetting('genre');
        let scenario = getMtSetting('scenario');
        let banlist = getMtSetting('banlist');
        let bannedSongs = localStorage.getItem('moodtube_global_banned_songs');
        if (bannedSongs === null) bannedSongs = getMtSetting('banned_songs') || '';
        let customPrompt = getMtSetting('custom');
        let hardRule = getMtSetting('hard_rule');
        let favoritesList = getMtSetting('favorites');
        let favoritesContext = getMtSetting('favorites_context') === 'true';
        
        let antiRepeatStr = sessionPlayedTracks.length > 0 
            ? `\nDo NOT pick any of these already played songs: ${sessionPlayedTracks.slice(-20).join(', ')}` 
            : '';
            
        let banListStr = '';
        if (banlist.trim()) banListStr += `\nDo NOT pick any songs from these artists: ${banlist}`;
        if (bannedSongs.trim()) banListStr += `\nDo NOT pick any of these specific songs: ${bannedSongs}`;
        let styleStr = '';
        if (genre.trim()) styleStr += `\nPreferred Genre/Style: ${genre}`;
        if (scenario.trim()) styleStr += `\nCurrent Scenario/Vibe: ${scenario}`;
        
        let favStr = '';
        if (favoritesContext && favoritesList.trim()) {
            favStr = `\nPrioritize these favorite tracks if they fit the mood: ${favoritesList}`;
        }

        let rusrealRule = (scenario.includes('Русреал') || genre.includes('Русреал')) ? "\nRule: If the scenario or genre is 'Русреал', select ONLY Russian songs and artists (Russian language lyrics)." : "";

        let hardRuleStr = hardRule.trim() ? `\nCRITICAL HARD RULE: The user has EXPLICITLY requested the following artist, song, or theme: "${hardRule}". You MUST fulfill this request precisely, filling the Title and Artist fields accordingly. IGNORE all other tags, rules, or context.` : '';

        const bulkCount = parseInt(localStorage.getItem('moodtube_ai_bulk_count') || 10, 10);
        const isBulk = bulkCount > 1;

        const systemInstruction = `[SYSTEM NOTE: CRITICAL OVERRIDE. YOU ARE A STRICT METADATA API. 
DO NOT ROLEPLAY. DO NOT SPEAK AS THE CHARACTER. NO GREETINGS. NO CONVERSATION.
Read the chat history and output ONLY a valid JSON ${isBulk ? `array containing exactly ${bulkCount} track objects` : 'object'}.
Rule 1: If a song is mentioned in the text, select it.
Rule 2: Otherwise, choose fitting track(s) based on the mood. ${styleStr} ${antiRepeatStr} ${banListStr} ${favStr} ${rusrealRule} ${hardRuleStr}
Format strictly: ${isBulk ? '[{"Title": "Song Name", "Artist": "Artist Name"}, ...]' : '{"Title": "Song Name", "Artist": "Artist Name"}'}]`;

        let defaultPrompt = `${systemInstruction}

Chat History:
${snippet}

${systemInstruction}`;

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
                'temperature': isBulk ? 0.8 : 0.3,
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
        
        if (isBulk) {
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
        } else {
            let parsed = parseAISongJSON(aiText);

            if (!parsed || (!parsed.Title && !parsed.title)) {
                console.error(`${LOG_PREFIX} Extracted string failed parsing:`, aiText);
                throw new Error("No valid JSON or song info found in response");
            }
            
            const searchQuery = `${parsed.Title || parsed.title} ${parsed.Artist || parsed.artist}`;
            await searchAndPlay(searchQuery);
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
        $('#moodtube-btn-ai').css('color', ACCENT_COLOR).removeClass('fa-spin');
    }
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
        if ($(e.target).hasClass('moodtube-ctrl') || $(e.target).is('input') || $(e.target).closest('#moodtube-resize-handle').length || $(e.target).closest('#moodtube-queue-list').length || $(e.target).closest('#moodtube-playlists-list').length) return;
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
        
        .moodtube-ctrl:hover { color: var(--mt-accent) !important; transform: scale(1.1); transition: 0.2s; }
        .moodtube-slider { -webkit-appearance: none; width: 100%; height: 4px; background: rgba(255,255,255,0.1); border-radius: 2px; outline: none; margin: 0 10px; }
        .moodtube-slider::-webkit-slider-thumb { -webkit-appearance: none; appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--mt-accent); cursor: pointer; border: 2px solid #fff; box-shadow: 0 0 5px rgba(0,0,0,0.5); }
        
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
        .moodtube-no-vol #moodtube-progress-container { display: none !important; }
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
            background: ${BG_COLOR}; border: 1px solid var(--mt-border);
            border-radius: 20px; padding: 20px; color: #fff;
            font-family: -apple-system, sans-serif;
            z-index: 9998; display: none; 
            box-shadow: 0 15px 35px rgba(0,0,0,0.8), inset 0 0 10px rgba(255, 255, 255, 0.05); 
            width: ${savedW}; height: ${savedH}; ${BLUR_CSS} cursor: grab; user-select: none;
            box-sizing: border-box; overflow: hidden;
        ">
            <div id="moodtube-inner-content">
                <div id="moodtube-cover-container" style="width: 140px; height: 140px; border-radius: 50%; background: #050505; border: 3px solid var(--mt-accent); box-shadow: 0 5px 15px rgba(0,0,0,0.7); display: flex; justify-content: center; align-items: center; position: relative; overflow: hidden; flex-shrink: 0; transition: 0.3s all;">
                    <img id="moodtube-widget-cover" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
                    <div id="moodtube-cover-hole" style="position: absolute; width: 14px; height: 14px; background: #222; border-radius: 50%; border: 1px solid var(--mt-accent); transition: 0.3s all;"></div>
                </div>
                
                <div id="moodtube-title-container" style="display: flex; flex-direction: column; align-items: center; width: 100%; text-align: center; flex-shrink: 0; position: relative;">
                    <span id="moodtube-widget-title" style="font-weight: 600; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; width: 100%; margin-bottom: 2px;">No Track Selected</span>
                    <span style="color: var(--mt-accent); font-size: 12px; font-weight: bold;">MoodTube DJ</span>
                    <i class="fa-regular fa-heart moodtube-ctrl" id="moodtube-btn-favorite" style="position: absolute; right: 0; top: 0; cursor: pointer; color: var(--mt-accent); font-size: 16px; transition: 0.3s;" title="В избранное"></i>
                </div>
                
                <div id="moodtube-progress-container" style="display: flex; align-items: center; width: 100%; flex-shrink: 0; gap: 5px; margin-top: -5px; font-size: 10px; color: #aaa;">
                    <span id="moodtube-time-current">0:00</span>
                    <input type="range" id="moodtube-progress-slider" min="0" max="100" value="0" class="moodtube-slider moodtube-ctrl" style="flex: 1; height: 3px;">
                    <span id="moodtube-time-total">0:00</span>
                </div>
                
                <div id="moodtube-controls-container" style="display: flex; gap: 15px; align-items: center; flex-shrink: 0;">
                    <i class="fa-solid fa-list-ul moodtube-ctrl" id="moodtube-btn-queue" style="cursor:pointer; color: var(--mt-accent); font-size: 16px; transition: 0.3s;" title="Queue"></i>
                    <i class="fa-solid fa-backward-step moodtube-ctrl" id="moodtube-btn-prev" style="cursor:pointer; color: #fff; font-size: 18px; transition: 0.2s;" title="Previous"></i>
                    <i class="fa-solid fa-play moodtube-ctrl" id="moodtube-btn-playpause" style="cursor:pointer; font-size: 28px; color: #fff; transition: 0.2s; width: 28px; text-align: center;"></i>
                    <i class="fa-solid fa-forward-step moodtube-ctrl" id="moodtube-btn-next" style="cursor:pointer; color: #fff; font-size: 18px; transition: 0.2s;" title="Next"></i>
                    <i class="fa-solid fa-wand-magic-sparkles moodtube-ctrl" id="moodtube-btn-ai" style="cursor:pointer; color: var(--mt-accent); font-size: 18px; transition: 0.3s;" title="Auto-DJ (AI)"></i>
                </div>

                <div id="moodtube-volume-container" style="display: flex; align-items: center; width: 90%; flex-shrink: 0;">
                    <i class="fa-solid fa-volume-low" style="font-size: 12px; color: var(--mt-accent);"></i>
                    <input type="range" id="moodtube-vol-slider" min="0" max="100" value="50" class="moodtube-slider moodtube-ctrl">
                    <i class="fa-solid fa-volume-high" style="font-size: 14px; color: var(--mt-accent);"></i>
                </div>
            </div>
            
            <div id="moodtube-queue-container" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; background:${BG_COLOR}; z-index:4; padding:15px; box-sizing:border-box; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
                    <div style="display:flex; align-items:center; gap: 10px;">
                        <span style="font-weight:bold; font-size:14px; color:var(--mt-accent);">Очередь треков</span>
                        <i class="fa-solid fa-trash moodtube-ctrl" id="moodtube-btn-clear-queue" style="cursor:pointer; font-size:12px; color:var(--mt-accent);" title="Очистить очередь"></i>
                        <i class="fa-solid fa-list-check moodtube-ctrl" id="moodtube-btn-spotify-playlists" style="cursor:pointer; font-size:12px; color:var(--mt-accent); display:none;" title="Мои плейлисты Spotify"></i>
                    </div>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl" id="moodtube-btn-close-queue" style="cursor:pointer; font-size:14px; color:#fff;" title="Скрыть"></i>
                </div>
                <div id="moodtube-queue-list" style="flex:1; overflow-y:auto; padding-right:5px;">
                    <div style="font-size:12px; color:#888; text-align:center; padding:10px;">Очередь пуста</div>
                </div>
            </div>
            
            <div id="moodtube-spotify-playlists-container" style="display:none; position:absolute; top:0; left:0; width:100%; height:100%; background:${BG_COLOR}; z-index:5; padding:15px; box-sizing:border-box; flex-direction:column;">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; flex-shrink:0;">
                    <span style="font-weight:bold; font-size:14px; color:var(--mt-accent);">Плейлисты Spotify</span>
                    <i class="fa-solid fa-chevron-down moodtube-ctrl" id="moodtube-btn-close-playlists" style="cursor:pointer; font-size:14px; color:#fff;" title="Скрыть"></i>
                </div>
                <div id="moodtube-playlists-list" style="flex:1; overflow-y:auto; padding-right:5px;"></div>
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
                                </select>
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
            $fab.css({
                position: 'fixed', left: Math.max(0, Math.min(sPos.left, window.innerWidth - 60)) + 'px', top: Math.max(0, Math.min(sPos.top, window.innerHeight - 60)) + 'px', right: 'auto', bottom: 'auto',
                zIndex: '9999999', width: '48px', height: '48px',
                border: '2px solid var(--mt-accent)', backgroundColor: 'var(--mt-bg-secondary)', color: 'var(--mt-accent)',
                boxShadow: '0 4px 15px rgba(0,0,0,0.5)', cursor: 'grab'
            });
            $fab.find('#moodtube-fab-icon').css('color', 'var(--mt-accent)');
        }

        function createFab() {
            if ($('#moodtube-fab').length === 0) {
                $(`
                <div id="moodtube-fab" class="moodtube-ctrl" style="
                    position: fixed; width: 48px; height: 48px;
                    background: var(--mt-bg-secondary); border: 2px solid var(--mt-accent); border-radius: 50%;
                    display: flex; justify-content: center; align-items: center;
                    box-shadow: 0 4px 15px rgba(0,0,0,0.5); cursor: grab; z-index: 9999999;
                    color: var(--mt-accent); font-size: 18px; transition: background 0.2s, border 0.2s;
                    touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
                ">
                    <i class="fa-solid fa-play" id="moodtube-fab-icon" style="margin-left: 3px; pointer-events: none; position: relative; z-index: 2;"></i>
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
                    el.style.cursor = 'grabbing';
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
                    el.style.cursor = 'grab';
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
                $('#moodtube-fab-icon').attr('class', isPaused ? 'fa-solid fa-pause' : 'fa-solid fa-play').css('margin-left', isPaused ? '0' : '3px');
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
                    $fab.css({
                        position: 'relative', left: 'auto', top: 'auto', right: 'auto', bottom: 'auto',
                        zIndex: 'auto', width: '48px', height: '48px',
                        border: '2px solid ' + ACCENT_COLOR, backgroundColor: 'rgba(20, 15, 20, 0.82)', color: ACCENT_COLOR,
                        boxShadow: '0 4px 8px rgba(0,0,0,0.3)', cursor: 'pointer'
                    });
                    $fab.find('#moodtube-fab-icon').css('color', ACCENT_COLOR);
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
                    $('#moodtube-fab-icon').attr('class', isPaused ? 'fa-solid fa-pause' : 'fa-solid fa-play');
                    // Убираем марджин для ровного центрирования иконки паузы
                    $('#moodtube-fab-icon').css('margin-left', isPaused ? '0' : '3px');
                    if (isPaused) $('#moodtube-fab').addClass('mt-playing'); else $('#moodtube-fab').removeClass('mt-playing');
                }
            }
        });
        observerBtn.observe($('#moodtube-btn-playpause')[0], { attributes: true });


        $('#moodtube-btn-playpause').on('click', async () => {
            const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
            if (source === 'spotify') {
                const wasPlaying = isCurrentlyPlaying;
                if (spotifyPlayer && isSpotifyReady) {
                    if (wasPlaying) spotifyPlayer.pause();
                    else spotifyPlayer.resume();
                }
                const token = await refreshSpotifyToken();
                if (token) {
                    if (wasPlaying) {
                        fetch('https://api.spotify.com/v1/me/player/pause', { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
                            .then(res => { if (!res.ok) res.json().then(data => toastr.error("Spotify: " + (data.error?.message || "Ошибка паузы"))); })
                            .catch(()=>{});
                        isCurrentlyPlaying = false;
                        $('#moodtube-btn-playpause').attr('class', 'fa-solid fa-play moodtube-ctrl');
                    } else {
                        fetch('https://api.spotify.com/v1/me/player/play', { method: 'PUT', headers: { Authorization: `Bearer ${token}` } })
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
            if (!isCurrentlyPlaying) return;
            
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
                        }
                    }
                });
                return;
            } else if (isUsingAudioFallback && audioFallback) {
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
        });

        // --- Save settings ---
        $('#moodtube-btn-save-settings').on('click', () => {
            activeProfileName = $('#moodtube-api-profile-select').val();
            localStorage.setItem('moodtube_active_profile_name', activeProfileName);
            
            const theme = $('#moodtube-setting-theme').val();
            localStorage.setItem('moodtube_theme', theme);
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
    }
    applyTheme(localStorage.getItem('moodtube_theme') || 'blue');
    updatePlayerVisibility();
    restoreQueueCache();
    startBackgroundPrefetch();
}

$(document).ready(() => { setTimeout(initializeExtension, 1500); });
