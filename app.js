var redirect_uri = config.redirect_uri;
var client_id = config.client_id;
var client_secret = config.client_secret;
var access_token = null;
var refresh_token = null;
var currentPlaylist = "";
var savedTracks = [];
var allsavedTracks = [];
var savedTracksIds = [];
var selectedArtists = []; // Array to store selected artist names
var nextBatchLength = 0;
var ArtistTracks = [];
var playlistTracksIds = [];

const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN = "https://accounts.spotify.com/api/token";
const loading = document.getElementById("loading");
const progress = document.getElementById("progress");
const loginButton = document.getElementById("loginButton");
const createPlaylistButton = document.getElementById("createPlaylistButton");
const artistsContainer = document.getElementById("artistsContainer");
const showArtistsContainer = document.getElementById("showArtistsContainer");

async function fetchWebApi(endpoint, method, body) {
    let accessToken = localStorage.getItem("access_token");
    console.log("Access token is: " + accessToken);
    const refreshToken = localStorage.getItem("refresh_token");
    console.log("Refresh token is: " + refreshToken);

    if (!accessToken) {
        console.error("Access token not found");
        return null;
    }

    // Check if token is expired
    const expiration = parseInt(localStorage.getItem("token_expires_at"), 10);
    if (Date.now() >= expiration * 1000) {
        console.log("Token expired. Refreshing...");
        await refreshAccessToken();
        accessToken = localStorage.getItem("access_token"); // Get the updated access token
    }

    const headers = {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
    };

    const options = {
        method,
        headers,
    };

    if (body) {
        options.body = JSON.stringify(body);
    }

    const res = await fetch(`https://api.spotify.com/${endpoint}`, options);

    if (res.status === 401) {
        console.log("Token expired or invalid, refreshing...");
        await refreshAccessToken();
        accessToken = localStorage.getItem("access_token"); // Get the updated access token
        headers.Authorization = `Bearer ${accessToken}`;
        options.headers = headers;
        return fetch(`https://api.spotify.com/${endpoint}`, options);
    }

    return await res.json();
}

async function refreshAccessToken() {
    console.log("Refreshing access token...");
    const refreshToken = localStorage.getItem("refresh_token");

    if (!refreshToken) {
        console.error("No refresh token found - user needs to log in again");
        // Clear everything and force re-login
        localStorage.clear();
        window.location.href = "/";
        return null;
    }

    const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: client_id,
        client_secret: client_secret,
    });

    try {
        const response = await fetch(TOKEN, {
            method: "POST",
            headers: {
                "Content-Type": "application/x-www-form-urlencoded",
            },
            body: body.toString(),
        });

        if (response.ok) {
            const data = await response.json();
            const newAccessToken = data.access_token;
            const expiresIn = data.expires_in;

            localStorage.setItem("access_token", newAccessToken);
            
            // Update refresh token if a new one is provided
            if (data.refresh_token) {
                localStorage.setItem("refresh_token", data.refresh_token);
            }
            
            // Calculate the new expiration time
            const expiresAt = Date.now() + expiresIn * 1000;
            localStorage.setItem("token_expires_at", expiresAt);

            console.log("Access token refreshed successfully");
            return newAccessToken;
        } else {
            console.error("Failed to refresh access token:", response.status);
            // If refresh fails, clear and force re-login
            localStorage.clear();
            window.location.href = "/";
            return null;
        }
    } catch (error) {
        console.error("Error refreshing access token:", error);
        localStorage.clear();
        window.location.href = "/";
        return null;
    }
}

async function init() {
    // Scroll to the top of the page
    window.scrollTo({ top: 0, behavior: 'smooth' });

    const header = document.querySelector(".artists-header");
    const titleHeader = document.getElementById("titleHeader");

    header.style.display = "none";
    titleHeader.style.display = "none";
    createPlaylistButton.style.display = "none";
    showArtistsContainer.style.display = "none";

    loading.style.display = "block";
    progress.style.display = "block";
    console.log("Fetching saved songs...");
    let offset = 0; // Initialize offset
    allsavedTracks = await getSavedTracks(offset); // Fetch first set of songs

    // Continue fetching until we get less than 50 songs or reach 2000
    while (nextBatchLength >= 1 && allsavedTracks.length < 2000) {
        offset += 50; // Increment offset
        const nextBatch = await getSavedTracks(offset); // Fetch next batch of songs
        allsavedTracks = allsavedTracks.concat(nextBatch); // Combine batches
    }

    // Limit to first 2000 tracks
    allsavedTracks = allsavedTracks.slice(0, 2000);

    console.log("All Saved Songs (up to 2000):", allsavedTracks); // Log all saved songs

    // Filter saved tracks based on selected artists
    const selectedTracks = allsavedTracks.filter(track => {
        return selectedArtists.includes(track.track.artists[0].name);
    });

    console.log("Selected Tracks:", selectedTracks); // Log selected tracks

    // Create a map to store all tracks by each selected artist
    const artistTracksMap = new Map();
    selectedArtists.forEach(artist => {
        const tracksByArtist = selectedTracks.filter(track => track.track.artists[0].name === artist).map(track => track.track);
        artistTracksMap.set(artist, tracksByArtist);
    });

    console.log("Artist Tracks Map:", artistTracksMap); // Log artist tracks map

    // Clear existing playlistTracksIds
    playlistTracksIds = [];

    for (const [artist, tracks] of artistTracksMap) {
        // Get 3 random tracks from the artist's saved tracks
        const randomArtistTracks = getRandomTracks(tracks, 3);
        console.log("Random Tracks for", artist, ":", randomArtistTracks);

        for (const track of randomArtistTracks) {
            console.log(`${track.name} by ${track.artists.map(artist => artist.name).join(', ')}`);

            // Get recommendations for each random track
            const recommendations = await getRecommendations(track.id);
            if (recommendations.length > 0) {
                const recommendedTrack = recommendations[0]; // Get the first recommendation
                console.log("Recommended Track for", track.id, ":", recommendedTrack);
                playlistTracksIds.push(recommendedTrack.id); // Add recommended track ID to playlistTracksIds
            }
        }

        // Add random track IDs to playlistTracksIds
        playlistTracksIds.push(...randomArtistTracks.map(track => track.id));
    }

    console.log("Playlist Tracks IDs before shuffle:", playlistTracksIds); // Log playlist tracks IDs before shuffle

    // Shuffling the playlistTracksIds array
    shuffleArray(playlistTracksIds);

    console.log("Playlist Tracks IDs after shuffle:", playlistTracksIds); // Log playlist tracks IDs after shuffle

    // Creating playlist with playlistTracksIds
    const tracksUri = playlistTracksIds.map(trackId => `spotify:track:${trackId}`);

    // Create a playlist with the combined tracks
    const createdPlaylist = await createPlaylist(tracksUri);
    console.log("Created Playlist:", createdPlaylist);

    loading.style.display = "none";
    progress.style.display = "none";
    titleHeader.style.display = "block";

    // Display the playlist
    const playlistContainer = document.getElementById("playlistContainer");
    if (playlistContainer) {
        const playlistId = createdPlaylist.id; // Assuming createdPlaylist has the playlist ID
        const iframe = document.createElement("iframe");
        iframe.title = "Spotify Embed: Recommendation Playlist";
        iframe.src = `https://open.spotify.com/embed/playlist/${playlistId}?utm_source=generator&theme=0`;
        iframe.width = "100%";
        iframe.height = "100%";
        iframe.style.minHeight = "360px";
        iframe.frameBorder = "0";
        iframe.allow = "autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture";
        iframe.loading = "lazy";

        playlistContainer.appendChild(iframe);
    }
}

function getCode() {
    let code = null;
    const queryString = window.location.search;
    if (queryString.length > 0) {
        const urlParams = new URLSearchParams(queryString);
        code = urlParams.get('code')
    }
    return code;
}

function requestAuthorization() {
    localStorage.setItem("client_id", client_id);
    localStorage.setItem("client_secret", client_secret); // In a real app you should not expose your client_secret to the user

    let url = AUTHORIZE;
    url += "?client_id=" + client_id;
    url += "&response_type=code";
    url += "&redirect_uri=" + encodeURI(redirect_uri);
    url += "&show_dialog=true";
    url += "&scope=playlist-modify-public playlist-modify-private user-read-private user-read-email user-library-read user-top-read user-read-recently-played user-read-currently-playing";
    window.location.href = url; // Show Spotify's authorization screen
}

// Call init function on page load if access token is available
function redirectToHomePage() {
    window.location.href = "/index.html";
}

function isSameDate(date1, date2) {
    return date1.getFullYear() === date2.getFullYear() &&
        date1.getMonth() === date2.getMonth() &&
        date1.getDate() === date2.getDate();
}

function formatDate(date) {
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const month = monthNames[date.getMonth()];
    const day = date.getDate();

    return `${month} ${day}`;
}

// Function to check if access token has expired
function isTokenExpired() {
    const tokenExpiration = parseInt(localStorage.getItem("token_expires_at"), 10);
    if (!tokenExpiration) {
        return true;
    }
    const now = Date.now();
    return now >= tokenExpiration;
}

function onPageLoad() {
    const code = getCode();
    const accessToken = localStorage.getItem("access_token");
    
    if (code) {
        // User just came back from Spotify authorization
        getToken(code);
    } else if (accessToken) {
        // User already has a valid token, modify the landing page for logged-in state
        const loginButton = document.getElementById("loginButton");
        const loginP = document.getElementById("loginp");
        
        if (loginButton) loginButton.style.display = "none";
        if (loginP) loginP.textContent = "Use the menu above to explore your Spotify data.";
        
        document.getElementById("header").style.display = "block";
    }
}

async function getToken(code) {
    const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: redirect_uri,
        client_id: client_id,
        client_secret: client_secret,
    });

    const response = await fetch(TOKEN, {
        method: "POST",
        headers: {
            "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
    });

    const data = await response.json();
    
    if (data.access_token) {
        localStorage.setItem("access_token", data.access_token);
        localStorage.setItem("refresh_token", data.refresh_token);
        
        const expiresIn = data.expires_in;
        const expiresAt = Date.now() + expiresIn * 1000;
        localStorage.setItem("token_expires_at", expiresAt);
        
        // Redirect to clean URL
        window.location.href = redirect_uri;
    }
}