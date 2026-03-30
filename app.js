const client_id    = "3629edd575284d0aa6671c69ae8fb3d3"; // public, not secret
const redirect_uri = window.location.hostname === "127.0.0.1"
  ? "http://127.0.0.1:5502/"
  : "https://aurals.net/index.html";
const SCOPES       = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "playlist-modify-public",
  "playlist-modify-private",
  "user-read-private",
  "user-read-email",
  "user-library-read",
  "user-top-read",
  "user-read-recently-played",
  "user-read-currently-playing",
  "user-read-playback-state",
].join(" ");

const AUTHORIZE = "https://accounts.spotify.com/authorize";
const TOKEN     = "https://accounts.spotify.com/api/token";

// --------------- PKCE HELPERS --------------------------------

/** Generate a cryptographically random code verifier (43–128 chars). */
function generateCodeVerifier(length = 128) {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const array    = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (b) => possible[b % possible.length]).join("");
}

/** SHA-256 hash → base64url (no padding). */
async function generateCodeChallenge(verifier) {
  const encoder = new TextEncoder();
  const data     = encoder.encode(verifier);
  const digest   = await crypto.subtle.digest("SHA-256", data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

// --------------- AUTHORIZATION -------------------------------

/**
 * Kick off the PKCE flow.
 * Generates verifier + challenge, saves verifier to sessionStorage,
 * then redirects to Spotify's /authorize endpoint.
 */
async function requestAuthorization() {
  const verifier   = generateCodeVerifier();
  const challenge  = await generateCodeChallenge(verifier);

  // Verifier must survive the redirect — sessionStorage is fine here.
  // Do NOT store it in localStorage longer-term.
  sessionStorage.setItem("pkce_verifier", verifier);

  const params = new URLSearchParams({
    client_id,
    response_type:         "code",
    redirect_uri,
    scope:                 SCOPES,
    code_challenge_method: "S256",
    code_challenge:        challenge,
    show_dialog:           "true",
  });

  window.location.href = `${AUTHORIZE}?${params.toString()}`;
}

// --------------- TOKEN EXCHANGE ------------------------------

/**
 * Exchange the authorization code for tokens.
 * Called once after Spotify redirects back with ?code=...
 * No client_secret needed — the verifier proves identity instead.
 */
async function getToken(code) {
  const verifier = sessionStorage.getItem("pkce_verifier");

  if (!verifier) {
    console.error("PKCE verifier missing — cannot exchange code. Restarting auth.");
    requestAuthorization();
    return;
  }

  const body = new URLSearchParams({
    grant_type:    "authorization_code",
    code,
    redirect_uri,
    client_id,
    code_verifier: verifier,   // <-- replaces client_secret
  });

  try {
    const response = await fetch(TOKEN, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    const data = await response.json();

    if (data.access_token) {
      storeTokens(data);
      sessionStorage.removeItem("pkce_verifier"); // clean up — no longer needed
      window.location.href = redirect_uri;         // redirect to clean URL
    } else {
      console.error("Token exchange failed:", data);
    }
  } catch (err) {
    console.error("Token exchange error:", err);
  }
}

// --------------- TOKEN REFRESH -------------------------------

/**
 * Refresh the access token using the stored refresh token.
 * PKCE refresh does NOT need client_secret.
 */
async function refreshAccessToken() {
  const refreshToken = localStorage.getItem("refresh_token");

  if (!refreshToken) {
    console.warn("No refresh token — redirecting to login.");
    clearTokensAndLogout();
    return null;
  }

  const body = new URLSearchParams({
    grant_type:    "refresh_token",
    refresh_token: refreshToken,
    client_id,
    // No client_secret!
  });

  try {
    const response = await fetch(TOKEN, {
      method:  "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body:    body.toString(),
    });

    if (response.ok) {
      const data = await response.json();
      storeTokens(data);
      return data.access_token;
    } else {
      console.error("Refresh failed:", response.status);
      clearTokensAndLogout();
      return null;
    }
  } catch (err) {
    console.error("Refresh error:", err);
    clearTokensAndLogout();
    return null;
  }
}

// --------------- API WRAPPER ---------------------------------

/**
 * Authenticated fetch wrapper for all Spotify API calls.
 * Proactively refreshes if token is within 60s of expiry.
 * Retries once on a 401.
 */
async function fetchWebApi(endpoint, method = "GET", body = null) {
  let accessToken = localStorage.getItem("access_token");

  if (!accessToken) {
    console.error("No access token — redirecting to login.");
    clearTokensAndLogout();
    return null;
  }

  // Proactive refresh: if token expires in < 60 seconds, refresh now
  const expiresAt = parseInt(localStorage.getItem("token_expires_at"), 10);
  if (Date.now() >= expiresAt - 60_000) {
    accessToken = await refreshAccessToken();
    if (!accessToken) return null;
  }

  const makeRequest = (token) =>
    fetch(`https://api.spotify.com/${endpoint}`, {
      method,
      headers: {
        Authorization:  `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });

  let res = await makeRequest(accessToken);

  // Reactive refresh: retry once on 401
  if (res.status === 401) {
    accessToken = await refreshAccessToken();
    if (!accessToken) return null;
    res = await makeRequest(accessToken);
  }

  // 204 No Content (e.g. currently-playing when nothing is playing)
  if (res.status === 204) return null;

  return res.json();
}

// --------------- HELPERS -------------------------------------

/** Persist tokens to localStorage. */
function storeTokens(data) {
  localStorage.setItem("access_token",    data.access_token);
  localStorage.setItem("token_expires_at", Date.now() + data.expires_in * 1000);
  if (data.refresh_token) {
    localStorage.setItem("refresh_token", data.refresh_token);
  }
}

/** Wipe tokens and send user back to login. */
function clearTokensAndLogout() {
  localStorage.removeItem("access_token");
  localStorage.removeItem("refresh_token");
  localStorage.removeItem("token_expires_at");
  window.location.href = redirect_uri;
}

// --------------- CALLBACK HANDLER ----------------------------
// Runs immediately on page load. If Spotify redirected back with
// ?code=..., exchange it. Otherwise, check for a stored token.

(function handleCallback() {
  const params = new URLSearchParams(window.location.search);
  const code   = params.get("code");

  if (code) {
    // Remove code from URL immediately (security hygiene)
    window.history.replaceState({}, document.title, window.location.pathname);
    getToken(code);
    return;
  }

  // No code — normal page load. onPageLoad() handles UI state.
})();

async function getTopArtists() {
    const artists = (await fetchWebApi(
        'v1/me/top/artists?time_range=long_term&limit=20', 'GET'
    )).items;
    return artists;
}

async function createPlaylist(tracksUri) {
    try {
        const { id: user_id } = await fetchWebApi('v1/me', 'GET');

        const playlist = await fetchWebApi(
            `v1/users/${user_id}/playlists`, 'POST', {
            "name": "For you",
            "description": generatePlaylistDescription(selectedArtists),
            "public": false
        },
        );

        if (!playlist || !playlist.id) {
            throw new Error("Playlist ID not found");
        }

        // Convert tracks URIs to objects with URIs
        const tracks = tracksUri.map(uri => ({ "uri": uri }));

        // Add tracks one by one to ensure they are added sequentially
        for (let i = 0; i < tracks.length; i++) {
            const track = tracks[i];
            await fetchWebApi(
                `v1/playlists/${playlist.id}/tracks`,
                'POST',
                { "uris": [track.uri] }, // Each track should be added as an array
                localStorage.getItem("access_token")
            );
        }

        return playlist;
    } catch (error) {
        console.error("Error creating playlist:", error);
        throw error;
    }
}

async function getSavedTracks(offset = 0) {
    try {
        const response = await fetchWebApi(
            `v1/me/tracks?limit=50&offset=${offset}`, 'GET'
        );

        if (!response || !response.items) {
            console.log("No tracks found in response:", response);
            return []; // Return an empty array if no tracks found
        }

        const tracks = response.items;
        tracks.forEach(item => {
            const track = item.track; // Access the 'track' object
        });

        console.log("Saved Songs:", tracks);
        nextBatchLength = tracks.length; // Store the length of the next batch

        return tracks;
    } catch (error) {
        console.error("Error fetching saved tracks:", error);
        return []; // Return an empty array in case of error
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

function redirectToHomePage() {
    window.location.href = "/index.html";
}

async function displayTopTracks(timeRange) {
    const topTracks = await fetchWebApi(`v1/me/top/tracks?limit=50&time_range=${timeRange}`, 'GET');
    const tracksList = document.getElementById("topTracksList");

    // Iterate through the top tracks and create list items
    topTracks.items.forEach((track, index) => {
        const trackItem = document.createElement("li");
        trackItem.classList.add("track-item");

        // Create an anchor for the track
        const trackLink = document.createElement("a");
        trackLink.href = track.external_urls.spotify;
        trackLink.target = "_blank"; // Open link in a new tab
        trackLink.classList.add("track-link");

        // Create a div for the track
        const trackDiv = document.createElement("div");
        trackDiv.classList.add("track");

        // Create a div for the track number
        const trackNumberDiv = document.createElement("div");
        trackNumberDiv.classList.add("track-number");
        const trackNumber = document.createElement("span");
        trackNumber.textContent = index + 1;
        trackNumberDiv.appendChild(trackNumber);

        // Create an image element for the album artwork
        const albumImage = document.createElement("img");
        albumImage.src = track.album.images[0].url;
        albumImage.alt = "Album Artwork";
        albumImage.classList.add("album-image");

        // Create a div for track details
        const trackDetails = document.createElement("div");
        trackDetails.classList.add("track-details");

        // Create elements for track name and artist(s)
        const trackName = document.createElement("div");
        trackName.textContent = track.name;
        trackName.classList.add("track-name");

        const artists = document.createElement("div");
        artists.textContent = track.artists.map(artist => artist.name).join(', ');
        artists.classList.add("track-artists");

        // Append track number, album artwork, track name, and artist(s) to track div
        trackDiv.appendChild(trackNumberDiv);
        trackDiv.appendChild(albumImage);
        trackDetails.appendChild(trackName);
        trackDetails.appendChild(artists);
        trackDiv.appendChild(trackDetails);

        // Append track div to track link
        trackLink.appendChild(trackDiv);

        // Append track link to track item
        trackItem.appendChild(trackLink);

        // Append track item to tracks list
        tracksList.appendChild(trackItem);
    });
}

async function displayTopArtists(timeRange) {
    const topArtists = await fetchWebApi(`v1/me/top/artists?limit=50&time_range=${timeRange}`, 'GET');
    const artistsContainer = document.getElementById("artistsContainer");

    // Iterate through the top artists and create artist cards
    topArtists.items.forEach((artist, index) => {
        const artistCard = document.createElement("div");
        artistCard.classList.add("artist");

        // Create a div for the artist number
        const artistNumberDiv = document.createElement("div");
        artistNumberDiv.classList.add("artist-number");
        const artistNumber = document.createElement("span");
        artistNumber.textContent = index + 1;
        artistNumberDiv.appendChild(artistNumber);

        // Create an anchor for the artist's Spotify page
        const artistLink = document.createElement("a");
        artistLink.href = artist.external_urls.spotify;
        artistLink.target = "_blank"; // Open link in a new tab

        // Create a div for the artist image and name
        const artistContent = document.createElement("div");
        artistContent.classList.add("artist-content");

        // Create an image element for the artist picture
        const artistImage = document.createElement("img");
        artistImage.src = artist.images[0].url;
        artistImage.alt = "Artist Picture";
        artistImage.classList.add("artist-image");

        // Create a div for the artist name
        const artistName = document.createElement("div");
        artistName.textContent = artist.name;
        artistName.classList.add("artist-name");

        // Append artist image and name to the artist content div
        artistContent.appendChild(artistImage);
        artistContent.appendChild(artistName);

        // Append artist content to the artist link
        artistLink.appendChild(artistContent);

        // Append artist number and artist link to the artist card
        artistCard.appendChild(artistNumberDiv);
        artistCard.appendChild(artistLink);

        // Append artist card to the artists container
        artistsContainer.appendChild(artistCard);
    });
}

async function displayRecentTracks() {
    await displayCurrentlyPlayingTrack(); // Call to display currently playing track

    const recentTracks = await fetchWebApi('v1/me/player/recently-played?limit=50', 'GET');
    const tracksList = document.getElementById("recentList");

    // Iterate through the recent tracks and create list items
    recentTracks.items.forEach((track, index) => {
        const trackItem = document.createElement("div");
        trackItem.classList.add("track-item");

        // Create an anchor for the track
        const trackLink = document.createElement("a");
        trackLink.href = track.track.external_urls.spotify;
        trackLink.target = "_blank"; // Open link in a new tab
        trackLink.classList.add("track-link");

        // Create a div for the track
        const trackDiv = document.createElement("div");
        trackDiv.classList.add("track");

        // Create a div for the track number
        const trackNumberDiv = document.createElement("div");
        trackNumberDiv.classList.add("track-number");
        const trackNumber = document.createElement("span");
        trackNumber.textContent = index + 1;
        trackNumberDiv.appendChild(trackNumber);

        // Create an image element for the album artwork
        const albumImage = document.createElement("img");
        albumImage.src = track.track.album.images[0].url;
        albumImage.alt = "Album Artwork";
        albumImage.classList.add("album-image");

        // Create a div for track details
        const trackDetails = document.createElement("div");
        trackDetails.classList.add("track-details");

        // Create elements for track name, artist(s), and played_at time
        const trackName = document.createElement("div");
        trackName.textContent = track.track.name;
        trackName.classList.add("track-name");

        const artists = document.createElement("div");
        artists.textContent = track.track.artists.map(artist => artist.name).join(', ');
        artists.classList.add("track-artists");

        // Calculate played at date
        const playedAt = document.createElement("div");
        const playedDate = new Date(track.played_at);
        const currentDate = new Date();
        const yesterday = new Date(currentDate);
        yesterday.setDate(currentDate.getDate() - 1);

        let playedDateStr = '';
        if (isSameDate(playedDate, currentDate)) {
            playedDateStr = "Today";
        } else if (isSameDate(playedDate, yesterday)) {
            playedDateStr = "Yesterday";
        } else {
            playedDateStr = formatDate(playedDate);
        }

        // Format played time
        const playedTime = playedDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        playedAt.textContent = `Played: ${playedDateStr} at ${playedTime}`;
        playedAt.classList.add("played");

        // Append track number, album artwork, track name, artist(s), and played_at to track div
        trackDiv.appendChild(trackNumberDiv);
        trackDiv.appendChild(albumImage);
        trackDetails.appendChild(trackName);
        trackDetails.appendChild(artists);
        trackDetails.appendChild(playedAt);
        trackDiv.appendChild(trackDetails);

        // Append track div to track link
        trackLink.appendChild(trackDiv);

        // Append track link to track item
        trackItem.appendChild(trackLink);

        // Append track item to tracksList
        tracksList.appendChild(trackItem);
    });
}

async function displayCurrentlyPlayingTrack() {
    try {
        const currentlyPlayingTrack = await fetchWebApi('v1/me/player/currently-playing', 'GET');
        const currentTrackElement = document.getElementById("recentList");

        // Check if currentlyPlayingTrack is empty or does not have the expected structure
        if (!currentlyPlayingTrack || !currentlyPlayingTrack.item) {
            throw new Error("No track is currently playing.");
        }

        const track = currentlyPlayingTrack.item;

        // Create a div for the track
        const trackDiv = document.createElement("div");
        trackDiv.classList.add("track");

        // Music bar animation
        const musicBar = document.createElement("div");
        musicBar.classList.add("now", "playing");
        musicBar.id = "music";
        musicBar.innerHTML = `
                    <span class="bar n1"></span>
                    <span class="bar n2"></span>
                    <span class="bar n3"></span>
                    <span class="bar n4"></span>
                    <span class="bar n5"></span>
                `;
        trackDiv.appendChild(musicBar);

        // Create a div for album artwork and track info
        const artworkAndInfoDiv = document.createElement("div");
        artworkAndInfoDiv.classList.add("artwork-info");

        // Create a div for album artwork
        const albumDiv = document.createElement("div");
        albumDiv.classList.add("album-div");

        // Create an image element for the album artwork
        const albumImage = document.createElement("img");
        albumImage.src = track.album.images[0].url;
        albumImage.alt = "Album Artwork";
        albumImage.classList.add("album-image");

        // Append album image to albumDiv
        albumDiv.appendChild(albumImage);

        // Create a div for track details
        const trackDetails = document.createElement("div");
        trackDetails.classList.add("track-details");

        // Create elements for track name and artist(s)
        const trackName = document.createElement("div");
        trackName.textContent = track.name;
        trackName.classList.add("track-name");

        const artists = document.createElement("div");
        artists.textContent = track.artists.map(artist => artist.name).join(', ');
        artists.classList.add("track-artists");

        // Append track name and artists to track details
        trackDetails.appendChild(trackName);
        trackDetails.appendChild(artists);

        // Append albumDiv and trackDetails to artworkAndInfoDiv
        artworkAndInfoDiv.appendChild(albumDiv);
        artworkAndInfoDiv.appendChild(trackDetails);

        // Create an anchor for the track
        const trackLink = document.createElement("a");
        trackLink.href = track.external_urls.spotify;
        trackLink.target = "_blank"; // Open link in a new tab
        trackLink.classList.add("track-link");

        // Append artworkAndInfoDiv to trackLink
        trackLink.appendChild(artworkAndInfoDiv);

        // Append trackLink to trackDiv
        trackDiv.appendChild(trackLink);

        // Append trackDiv to currentTrackElement
        currentTrackElement.appendChild(trackDiv);
    } catch (error) {
        return;
    }
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