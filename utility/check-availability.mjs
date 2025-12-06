#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MIN_DURATION_SECONDS = 30;

// Read playlist from cache
const cacheFile = path.join(REPO_ROOT, 'cache', 'playlists.json');
const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

// Extract all video IDs with their titles
const filterIdsEnv = process.env.CHECK_AVAILABLE_IDS || '';
const filterIds = filterIdsEnv
  .split(',')
  .map((v) => v.trim())
  .filter((v) => v.length > 0);

const videos = [];
for (const playlistId in cache) {
  const playlist = cache[playlistId];
  if (!playlist.items) continue;
  playlist.items.forEach((item) => {
    if (filterIds.length > 0 && !filterIds.includes(item.videoId)) {
      return;
    }
    videos.push({
      videoId: item.videoId,
      title: item.userTitle || item.title,
      position: item.position
    });
  });
}

if (filterIds.length) {
  console.log(`Filtering to ${filterIds.length} video ID(s): ${filterIds.join(', ')}`);
}

console.log(`Checking ${videos.length} videos using YouTube oEmbed API...`);
console.log('This method uses oEmbed plus watch-page parsing so no quota is consumed, and marks videos as unavailable when duration is missing or under 30 seconds.\n');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function extractJsonAfterMarker(source, marker) {
  const markerIndex = source.indexOf(marker);
  if (markerIndex === -1) return null;
  const jsonStart = source.indexOf('{', markerIndex + marker.length);
  if (jsonStart === -1) return null;
  let depth = 0;
  for (let i = jsonStart; i < source.length; i += 1) {
    const char = source[i];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return source.slice(jsonStart, i + 1);
      }
    }
  }
  return null;
}

async function fetchWatchMetadata(videoId) {
  const timestamp = Math.floor(Date.now() / 1000);
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}&bpctr=${timestamp}`;
  const response = await fetch(watchUrl, {
    headers: {
      'user-agent': USER_AGENT,
      'accept-language': 'en-US,en;q=0.9'
    }
  });

  if (!response.ok) {
    throw new Error(`watch page fetch failed with status ${response.status}`);
  }

  const html = await response.text();
  const jsonText = extractJsonAfterMarker(html, 'ytInitialPlayerResponse =');
  if (!jsonText) return null;

  let playerResponse;
  try {
    playerResponse = JSON.parse(jsonText);
  } catch (error) {
    console.warn(`Failed to parse player response for ${videoId}:`, error.message);
    return null;
  }

  const playability = playerResponse?.playabilityStatus ?? {};
  const lengthSeconds = playerResponse?.videoDetails?.lengthSeconds;
  const seconds = Number.parseInt(lengthSeconds, 10);
  const hasDuration = !Number.isNaN(seconds) && seconds > 0;

  return {
    seconds: hasDuration ? seconds : null,
    playabilityStatus: playability.status || null,
    playabilityReason: playability.reason || null,
    isPlayable: playability.status === 'OK'
  };
}

const unavailable = [];
const available = [];
let checked = 0;

// Check videos one by one using oEmbed endpoint
// This endpoint returns 404 or error for unavailable videos
for (const video of videos) {
  const url = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${video.videoId}&format=json`;
  
  try {
    const response = await fetch(url);
    
    if (response.ok) {
      let metadata = null;
      try {
        metadata = await fetchWatchMetadata(video.videoId);
      } catch (durationError) {
        console.warn(`Failed to retrieve metadata for ${video.videoId}:`, durationError.message);
      }

      const durationSeconds = metadata?.seconds ?? null;
      const isPlayable = metadata?.isPlayable ?? false;
      const playabilityStatus = metadata?.playabilityStatus ?? null;
      const playabilityReason = metadata?.playabilityReason ?? null;

      if (!metadata) {
        unavailable.push({ ...video, reason: 'metadataUnavailable' });
        console.log(`❌ Unavailable (metadata missing): ${video.title} (${video.videoId})`);
      } else if (!isPlayable) {
        unavailable.push({
          ...video,
          reason: `playability:${playabilityStatus || 'unknown'}`,
          playabilityStatus,
          playabilityReason,
          durationSeconds
        });
        console.log(
          `❌ Unavailable (playability ${playabilityStatus || 'unknown'}): ${video.title} (${video.videoId})`
        );
      } else if (durationSeconds === null) {
        unavailable.push({
          ...video,
          reason: 'durationUnavailable',
          playabilityStatus,
          playabilityReason
        });
        console.log(`❌ Unavailable (no duration): ${video.title} (${video.videoId})`);
      } else if (durationSeconds < MIN_DURATION_SECONDS) {
        unavailable.push({
          ...video,
          reason: 'durationTooShort',
          durationSeconds,
          playabilityStatus,
          playabilityReason
        });
        console.log(`❌ Unavailable (duration ${durationSeconds}s): ${video.title} (${video.videoId})`);
      } else {
        available.push({
          ...video,
          durationSeconds,
          playabilityStatus,
          playabilityReason
        });
      }
    } else {
      // 401, 404, or other error means video is unavailable
      unavailable.push({ ...video, reason: 'oEmbedUnavailable' });
      console.log(`❌ Unavailable: ${video.title} (${video.videoId})`);
    }
    
  } catch (error) {
    console.error(`Error checking ${video.videoId}:`, error.message);
    unavailable.push({ ...video, reason: 'requestError' });
  }

  checked += 1;
  if (checked % 50 === 0) {
    console.log(`Progress: ${checked}/${videos.length}...`);
  }

  // Be nice to the API - small delay between requests
  await sleep(80);
}

console.log('\n=== RESULTS ===');
console.log(`Total videos checked: ${videos.length}`);
console.log(`Available: ${available.length}`);
console.log(`Unavailable: ${unavailable.length}`);

if (unavailable.length > 0) {
  console.log('\n=== UNAVAILABLE VIDEOS ===');
  unavailable.forEach(v => {
    console.log(`Position ${v.position}: ${v.title}`);
    console.log(`  ID: ${v.videoId}`);
    console.log(`  URL: https://www.youtube.com/watch?v=${v.videoId}`);
    const reasonLabel = v.reason ? v.reason : 'unknown';
    const durationLabel = typeof v.durationSeconds === 'number' ? `${v.durationSeconds}s` : 'unknown';
    const statusLabel = v.playabilityStatus || 'unknown';
    const statusReason = v.playabilityReason || 'n/a';
    console.log(`  Reason: ${reasonLabel}`);
    console.log(`  Duration: ${durationLabel}`);
    console.log(`  Playability: ${statusLabel} (${statusReason})\n`);
  });
  
  // Save to file
  const outputFile = path.join(REPO_ROOT, 'data', 'unavailable-videos.json');
  fs.writeFileSync(outputFile, JSON.stringify({ 
    unavailable: unavailable.map(v => ({
      videoId: v.videoId,
      title: v.title,
      position: v.position,
      reason: v.reason || null,
      durationSeconds: typeof v.durationSeconds === 'number' ? v.durationSeconds : null,
      playabilityStatus: v.playabilityStatus || null,
      playabilityReason: v.playabilityReason || null
    })),
    count: unavailable.length,
    checkedAt: new Date().toISOString()
  }, null, 2));
  console.log(`Saved detailed list to: ${outputFile}`);
}
