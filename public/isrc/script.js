const CLIENT_ID = '71ef4e2ab1b24e04b8d78005c1e0797a';
const CLIENT_SECRET = '6b935357c20340b48d9d42858b252673';

let spotifyToken = null;
let tokenExpiryTime = 0;

async function getSpotifyToken() {
    if (spotifyToken && Date.now() < tokenExpiryTime) {
        return spotifyToken;
    }

    const authString = btoa(`${CLIENT_ID}:${CLIENT_SECRET}`);
    const response = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
            "Authorization": `Basic ${authString}`,
            "Content-Type": "application/x-www-form-urlencoded"
        },
        body: "grant_type=client_credentials"
    });

    const data = await response.json();
    spotifyToken = data.access_token;
    tokenExpiryTime = Date.now() + (data.expires_in * 1000) - 60000; // Refresh 1 minute before expiry
    return spotifyToken;
}

async function findTrack(query, searchType) {
    const resultsContainer = document.getElementById('results-container');
    resultsContainer.innerHTML = '<div class="text-center text-white-50"><div class="spinner-border text-primary" role="status"><span class="visually-hidden">Loading...</span></div> Searching...</div>';

    try {
        const token = await getSpotifyToken();
        if (!token) {
            resultsContainer.innerHTML = '<div class="alert alert-danger">Could not get Spotify token.</div>';
            return;
        }

        let apiUrl = '';
        let errorMessage = '';

        if (searchType === 'isrc') {
            if (query.includes('/album/')) {
                errorMessage = 'Please enter a track URL, ISRC, or text for ISRC search.';
            } else if (query.startsWith("spotify:track:") || query.startsWith("https://open.spotify.com/track/")) {
                const trackId = query.split('/').pop().split('?')[0];
                apiUrl = `https://api.spotify.com/v1/tracks/${trackId}`;
            } else if (query.length === 12 && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(query)) { // Basic ISRC validation
                apiUrl = `https://api.spotify.com/v1/search?q=isrc:${query}&type=track&limit=1`;
            } else {
                apiUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=track&limit=1`;
            }
        } else if (searchType === 'upc') {
            if (query.includes('/track/')) {
                errorMessage = 'Please enter an album URL, UPC, or text for UPC search.';
            } else if (query.startsWith("spotify:album:") || query.startsWith("https://open.spotify.com/album/")) {
                const albumId = query.split('/').pop().split('?')[0];
                apiUrl = `https://api.spotify.com/v1/albums/${albumId}`;
            } else if (query.length === 12 && /^[0-9]{12}$/.test(query)) { // Basic UPC validation
                apiUrl = `https://api.spotify.com/v1/search?q=upc:${query}&type=album&limit=1`;
            } else {
                apiUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=album&limit=1`;
            }
        }

        if (errorMessage) {
            resultsContainer.innerHTML = `<div class="alert alert-warning">${errorMessage}</div>`;
            return;
        }

        if (!apiUrl) {
            resultsContainer.innerHTML = '<div class="alert alert-warning">Invalid query. Please try again.</div>';
            return;
        }

        const response = await fetch(apiUrl, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            const errorText = await response.text();
            console.error(`API Error: ${response.status} - ${response.statusText}`, errorText);
            resultsContainer.innerHTML = `<div class="alert alert-danger">API Error: ${response.status} - ${response.statusText}. Check console for details.</div>`;
            return;
        }

        const data = await response.json();

        if (searchType === 'isrc') {
            let track = null;
            if (data.type === 'track') {
                track = data;
            } else if (data.tracks && data.tracks.items.length > 0) {
                track = data.tracks.items[0];
            }

            if (track) {
                displayTrackCard(track, 'isrc');
            } else {
                resultsContainer.innerHTML = '<div class="alert alert-warning">No track found for this query.</div>';
            }
        } else if (searchType === 'upc') {
            let album = null;
            if (data.type === 'album') {
                album = data;
            } else if (data.albums && data.albums.items.length > 0) {
                album = data.albums.items[0];
            }

            if (album) {
                displayTrackCard(album, 'upc');
            } else {
                resultsContainer.innerHTML = '<div class="alert alert-warning">No album found for this query.</div>';
            }
        }

    } catch (error) {
        console.error('Error during search:', error);
        resultsContainer.innerHTML = `<div class="alert alert-danger">An error occurred: ${error.message}. Please try again.</div>`;
    }
}

function displayTrackCard(data, type) {
    const resultsContainer = document.getElementById('results-container');
    let imageUrl = '';
    let title = '';
    let artist = '';
    let releaseDate = '';
    let label = '';
    let code = '';
    let codeLabel = '';
    let spotifyUrl = '';
    let platform = 'Spotify'; // Assuming Spotify as the platform

    if (type === 'isrc') {
        imageUrl = data.album.images.length > 0 ? data.album.images[0].url : 'https://via.placeholder.com/150';
        title = data.name;
        artist = data.artists.map(a => a.name).join(', ');
        releaseDate = data.album.release_date;
        label = data.album.label || 'N/A';
        code = data.external_ids.isrc || 'N/A';
        codeLabel = 'ISRC';
        spotifyUrl = data.external_urls.spotify;
    } else if (type === 'upc') {
        imageUrl = data.images.length > 0 ? data.images[0].url : 'https://via.placeholder.com/150';
        title = data.name;
        artist = data.artists.map(a => a.name).join(', ');
        releaseDate = data.release_date;
        label = data.label || 'N/A';
        code = data.external_ids.upc || 'N/A';
        codeLabel = 'UPC';
        spotifyUrl = data.external_urls.spotify;
    }

    const cardHtml = `
        <div class="card track-card mb-3 animate__animated animate__fadeInUp">
            <div class="row g-0 align-items-center">
                <div class="col-md-4">
                    <img src="${imageUrl}" class="img-fluid rounded-start" alt="Album Art">
                </div>
                <div class="col-md-8">
                    <div class="card-body text-start">
                        <h5 class="card-title">${title}</h5>
                        <p class="card-text"><i class="bi bi-person-fill"></i> <strong>Artist:</strong> ${artist}</p>
                        <p class="card-text"><i class="bi bi-calendar-event-fill"></i> <strong>Release Date:</strong> ${releaseDate}</p>
                        <p class="card-text"><i class="bi bi-tag-fill"></i> <strong>Label:</strong> ${label}</p>
                        <p class="card-text"><i class="bi bi-disc-fill"></i> <strong>Platform:</strong> ${platform}</p>
                        <p class="card-text"><i class="bi bi-hash"></i> <strong>${codeLabel} Code:</strong> ${code}</p>
                        ${spotifyUrl ? `<a href="${spotifyUrl}" target="_blank" class="btn listen-btn mt-3"><i class="bi bi-spotify"></i> Listen on Spotify</a>` : ''}
                    </div>
                </div>
            </div>
        </div>
    `;
    resultsContainer.innerHTML = cardHtml;

    // Dynamically add rectangle ad next to the result card on desktop, or below on mobile
    const resultsAndAdContainer = document.getElementById('results-and-ad-container');
    const adHtml = `
        <div class="adsense-rectangle-ad text-center">
            <div class="ad-placeholder">Rectangle Ad (300x250)</div>
        </div>
    `;
    // Clear previous ads if any
    resultsAndAdContainer.querySelectorAll('.adsense-rectangle-ad').forEach(ad => ad.remove());
    resultsAndAdContainer.insertAdjacentHTML('beforeend', adHtml);
}

document.getElementById('isrc-form').addEventListener('submit', function(event) {
    event.preventDefault();
    const query = document.getElementById('isrc-query').value.trim();
    if (query) {
        findTrack(query, 'isrc');
    } else {
        document.getElementById('results-container').innerHTML = '<div class="alert alert-info">Please enter a query for ISRC search.</div>';
    }
});

document.getElementById('upc-form').addEventListener('submit', function(event) {
    event.preventDefault();
    const query = document.getElementById('upc-query').value.trim();
    if (query) {
        findTrack(query, 'upc');
    } else {
        document.getElementById('results-container').innerHTML = '<div class="alert alert-info">Please enter a query for UPC search.</div>';
    }
});

// Initialize Bootstrap tabs
var myTabs = document.querySelectorAll('#myTab button')
myTabs.forEach(function (tab) {
  var tabTrigger = new bootstrap.Tab(tab)
  tab.addEventListener('click', function () {
    tabTrigger.show()
  })
})

// Micro-interactions for input fields and buttons
document.querySelectorAll('.custom-input').forEach(input => {
    input.addEventListener('focus', () => input.classList.add('glowing-border'));
    input.addEventListener('blur', () => input.classList.remove('glowing-border'));
});

document.querySelectorAll('.custom-btn-primary, .listen-btn').forEach(button => {
    button.addEventListener('mouseenter', () => button.classList.add('glowing-shadow'));
    button.addEventListener('mouseleave', () => button.classList.remove('glowing-shadow'));
});



