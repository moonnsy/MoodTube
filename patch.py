import re

with open('c:\\SillyTavern\\public\\scripts\\extensions\\third-party\\MoodTube\\index.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add Spotify PKCE and functions before searchYouTube
spotify_code = """
// --- SPOTIFY API & PLAYER ---
let spotifyPlayer = null;
let spotifyDeviceId = null;
let isSpotifyReady = false;
let currentSpotifyTrackId = null;

function generateRandomString(length) {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < length; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

async function sha256(plain) {
    const encoder = new TextEncoder();
    const data = encoder.encode(plain);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return hash;
}

function base64encode(hash) {
    return btoa(String.fromCharCode.apply(null, new Uint8Array(hash)))
        .replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
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
    
    const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge_method: 'S256',
        code_challenge: codeChallenge,
        scope: 'streaming user-read-email user-read-private user-read-playback-state user-modify-playback-state'
    });
    
    window.location.href = `https://accounts.spotify.com/authorize?${params.toString()}`;
}

async function handleSpotifyCallback() {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const verifier = localStorage.getItem('moodtube_spotify_verifier');
    const clientId = localStorage.getItem('moodtube_spotify_client_id');
    
    if (code && verifier && clientId && !localStorage.getItem('moodtube_spotify_token')) {
        const redirectUri = window.location.origin + '/';
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
                toastr.success("Spotify успешно подключен!");
                
                window.history.replaceState({}, document.title, window.location.pathname);
            } else {
                toastr.error("Ошибка авторизации Spotify");
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
    if (spotifyPlayer) return;
    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    document.body.appendChild(script);

    window.onSpotifyWebPlaybackSDKReady = async () => {
        const token = await refreshSpotifyToken();
        if (!token) return;

        spotifyPlayer = new window.Spotify.Player({
            name: 'MoodTube Web Player',
            getOAuthToken: cb => { 
                refreshSpotifyToken().then(t => { if(t) cb(t); });
            },
            volume: currentVolume / 100
        });

        spotifyPlayer.addListener('ready', ({ device_id }) => {
            console.log('[MoodTube] Spotify Ready with Device ID', device_id);
            spotifyDeviceId = device_id;
            isSpotifyReady = true;
        });

        spotifyPlayer.addListener('not_ready', ({ device_id }) => {
            console.log('[MoodTube] Spotify Device ID has gone offline', device_id);
            isSpotifyReady = false;
        });
        
        spotifyPlayer.addListener('player_state_changed', state => {
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

        spotifyPlayer.connect();
    };
}

async function searchSpotify(query) {
    const token = await refreshSpotifyToken();
    if (!token) {
        console.warn("[MoodTube] No Spotify token for search");
        return null;
    }
    const cleanQuery = query.replace(/[\\[\\](){}]/g, '').trim();
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

async function searchYouTube(query, isRetry = false) {"""
content = content.replace("async function searchYouTube(query, isRetry = false) {", spotify_code)

# 2. Modify resolveQueueBackground
resolve_bg_old = """                const videoInfo = await searchYouTube(track.originalQuery);"""
resolve_bg_new = """                const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
                let videoInfo = null;
                if (source === 'spotify') {
                    videoInfo = await searchSpotify(track.originalQuery);
                    if (!videoInfo) videoInfo = await searchYouTube(track.originalQuery); // fallback
                } else {
                    videoInfo = await searchYouTube(track.originalQuery);
                }"""
content = content.replace(resolve_bg_old, resolve_bg_new)

# 3. Modify playTrack
play_track_old = """    $('#moodtube-widget-title').text(videoInfo.title || 'YouTube Track');"""
play_track_new = """    const source = localStorage.getItem('moodtube_playback_source') || 'youtube';

    if (source === 'spotify' && videoInfo.videoId && videoInfo.videoId.startsWith('spotify:track:')) {
        $('#moodtube-widget-title').text(videoInfo.title || 'Spotify Track');
        const thumbUrl = (videoInfo.videoThumbnails && videoInfo.videoThumbnails.length > 0) ? videoInfo.videoThumbnails[0].url : 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        $('#moodtube-widget-cover').attr('src', thumbUrl);
        
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

    $('#moodtube-widget-title').text(videoInfo.title || 'YouTube Track');"""
content = content.replace(play_track_old, play_track_new)

# 4. Handle Play/Pause
playpause_old = """        $('#moodtube-btn-playpause').on('click', () => {
            if (isUsingAudioFallback && audioFallback) {
                if (isCurrentlyPlaying) audioFallback.pause();
                else audioFallback.play();
            } else if (ytPlayer) {
                if (isCurrentlyPlaying) ytPlayer.pauseVideo();
                else ytPlayer.playVideo();
            }
        });"""
playpause_new = """        $('#moodtube-btn-playpause').on('click', () => {
            const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
            if (source === 'spotify' && spotifyPlayer && isSpotifyReady) {
                if (isCurrentlyPlaying) spotifyPlayer.pause();
                else spotifyPlayer.resume();
            } else if (isUsingAudioFallback && audioFallback) {
                if (isCurrentlyPlaying) audioFallback.pause();
                else audioFallback.play();
            } else if (ytPlayer) {
                if (isCurrentlyPlaying) ytPlayer.pauseVideo();
                else ytPlayer.playVideo();
            }
        });"""
content = content.replace(playpause_old, playpause_new)

# 5. Handle Settings UI
settings_ui_old = """                            <div class="mt-cat-content" id="mt-cat-api">
                                <span class="mt-label" style="margin-top:0;">Количество треков для генерации за раз</span>"""
settings_ui_new = """                            <div class="mt-cat-content" id="mt-cat-api">
                                <span class="mt-label" style="margin-top:0;">Источник воспроизведения</span>
                                <select id="moodtube-playback-source" class="mt-input-field">
                                    <option value="youtube">YouTube (По умолчанию)</option>
                                    <option value="spotify">Spotify (Premium SDK)</option>
                                </select>
                                
                                <div id="moodtube-spotify-settings" style="display:none; padding: 10px; background: rgba(0,0,0,0.2); border-radius: 8px; margin-top: 10px; border: 1px solid var(--mt-border);">
                                    <span class="mt-label" style="margin-top:0; color:#1DB954;"><i class="fa-brands fa-spotify"></i> Spotify Настройки</span>
                                    <span class="mt-label">Client ID (из Developer Dashboard)</span>
                                    <input type="text" id="moodtube-spotify-client-id" class="mt-input-field" placeholder="Client ID">
                                    <button id="moodtube-btn-spotify-auth" class="mt-btn-test" style="margin-top: 10px; background: #1DB954; color: #fff; border: none; font-weight: 600;">Авторизоваться в Spotify</button>
                                    <div id="moodtube-spotify-status" style="margin-top: 8px; font-size: 0.85em; color: #9CA3AF;"></div>
                                </div>
                                
                                <hr style="border:0; border-top:1px solid rgba(255,255,255,0.05); margin:15px 0;">

                                <span class="mt-label" style="margin-top:0;">Количество треков для генерации за раз</span>"""
content = content.replace(settings_ui_old, settings_ui_new)

# 6. Settings init and events
init_ext_old = """        isDaLinked = stContext?.extensionSettings?.DreamAlbum?.moodtube_link === true;"""
init_ext_new = """        isDaLinked = stContext?.extensionSettings?.DreamAlbum?.moodtube_link === true;
        
        // --- Spotify Init ---
        handleSpotifyCallback();
        const source = localStorage.getItem('moodtube_playback_source') || 'youtube';
        if (source === 'spotify') initSpotifyPlayer();
        
        $('#moodtube-playback-source').on('change', function() {
            if ($(this).val() === 'spotify') $('#moodtube-spotify-settings').slideDown();
            else $('#moodtube-spotify-settings').slideUp();
        });
        
        $('#moodtube-btn-spotify-auth').on('click', () => {
            authSpotify();
        });
"""
content = content.replace(init_ext_old, init_ext_new)

# 7. Settings load
load_settings_old = """            $('#moodtube-setting-theme').val(localStorage.getItem('moodtube_theme') || 'blue');"""
load_settings_new = """            $('#moodtube-setting-theme').val(localStorage.getItem('moodtube_theme') || 'blue');
            $('#moodtube-playback-source').val(localStorage.getItem('moodtube_playback_source') || 'youtube').trigger('change');
            $('#moodtube-spotify-client-id').val(localStorage.getItem('moodtube_spotify_client_id') || '');
            const spotToken = localStorage.getItem('moodtube_spotify_token');
            if (spotToken) {
                $('#moodtube-spotify-status').html('<span style="color:#1DB954;">Авторизован ✓</span>');
                $('#moodtube-btn-spotify-auth').text('Переавторизоваться');
            } else {
                $('#moodtube-spotify-status').html('Не авторизован');
                $('#moodtube-btn-spotify-auth').text('Авторизоваться в Spotify');
            }"""
content = content.replace(load_settings_old, load_settings_new)

# 8. Settings Save
save_settings_old = """            const fabEnabled = $('#moodtube-setting-fab').is(':checked');"""
save_settings_new = """            const source = $('#moodtube-playback-source').val();
            localStorage.setItem('moodtube_playback_source', source);
            localStorage.setItem('moodtube_spotify_client_id', $('#moodtube-spotify-client-id').val().trim());
            if (source === 'spotify') initSpotifyPlayer();
            
            const fabEnabled = $('#moodtube-setting-fab').is(':checked');"""
content = content.replace(save_settings_old, save_settings_new)

# 9. Volume change
vol_change_old = """                audioFallback.volume = currentVolume / 100;"""
vol_change_new = """                audioFallback.volume = currentVolume / 100;
                if (typeof spotifyPlayer !== 'undefined' && spotifyPlayer) spotifyPlayer.setVolume(currentVolume / 100);"""
content = content.replace(vol_change_old, vol_change_new)

with open('c:\\SillyTavern\\public\\scripts\\extensions\\third-party\\MoodTube\\index.js', 'w', encoding='utf-8') as f:
    f.write(content)
print("Patched index.js")
