#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');

// Read playlist from cache
const cacheFile = path.join(REPO_ROOT, 'cache', 'playlists.json');
const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));

// Extract all video IDs with their titles
const videos = [];
for (const playlistId in cache) {
  const playlist = cache[playlistId];
  if (playlist.items) {
    playlist.items.forEach(item => {
      videos.push({
        videoId: item.videoId,
        title: item.userTitle || item.title,
        position: item.position
      });
    });
  }
}

console.log(`Checking ${videos.length} videos using YouTube oEmbed API...`);
console.log('This method is more reliable for detecting unavailable videos.\n');

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
      available.push(video);
    } else {
      // 401, 404, or other error means video is unavailable
      unavailable.push(video);
      console.log(`❌ Unavailable: ${video.title} (${video.videoId})`);
    }
    
    checked++;
    if (checked % 50 === 0) {
      console.log(`Progress: ${checked}/${videos.length}...`);
    }
    
    // Be nice to the API - small delay between requests
    await new Promise(resolve => setTimeout(resolve, 50));
  } catch (error) {
    console.error(`Error checking ${video.videoId}:`, error.message);
  }
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
    console.log(`  URL: https://www.youtube.com/watch?v=${v.videoId}\n`);
  });
  
  // Save to file
  const outputFile = path.join(REPO_ROOT, 'data', 'unavailable-videos.json');
  fs.writeFileSync(outputFile, JSON.stringify({ 
    unavailable: unavailable.map(v => ({
      videoId: v.videoId,
      title: v.title,
      position: v.position
    })),
    count: unavailable.length,
    checkedAt: new Date().toISOString()
  }, null, 2));
  console.log(`Saved detailed list to: ${outputFile}`);
}
