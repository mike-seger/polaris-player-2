#!/usr/bin/env node
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import process from 'node:process';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { google } from 'googleapis';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const SCRIPT_DIR = path.dirname(SCRIPT_PATH);
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_TOKEN_PATH = path.join(SCRIPT_DIR, '.oauth-token.json');
const DEFAULT_REDIRECT_URI = 'http://localhost:53682/oauth2callback';
const YOUTUBE_SCOPE = ['https://www.googleapis.com/auth/youtube'];

await loadEnvFiles();

const terminalWidth = Math.min(100, process.stdout?.columns ?? 100);

function stripDiacritics(input) {
  const s = String(input ?? '');
  try {
    // NFKD splits accents into combining marks; removing them improves cross-locale stability.
    return s.normalize('NFKD').replace(/\p{M}+/gu, '');
  } catch {
    // Fallback for environments without Unicode property escapes.
    return s.normalize('NFKD').replace(/[\u0300-\u036f]+/g, '');
  }
}

const CYRILLIC_TO_LATIN = Object.freeze({
  А: 'A',
  а: 'a',
  Б: 'B',
  б: 'b',
  В: 'V',
  в: 'v',
  Г: 'G',
  г: 'g',
  Д: 'D',
  д: 'd',
  Е: 'E',
  е: 'e',
  Ё: 'E',
  ё: 'e',
  Ж: 'Zh',
  ж: 'zh',
  З: 'Z',
  з: 'z',
  И: 'I',
  и: 'i',
  Й: 'I',
  й: 'i',
  К: 'K',
  к: 'k',
  Л: 'L',
  л: 'l',
  М: 'M',
  м: 'm',
  Н: 'N',
  н: 'n',
  О: 'O',
  о: 'o',
  П: 'P',
  п: 'p',
  Р: 'R',
  р: 'r',
  С: 'S',
  с: 's',
  Т: 'T',
  т: 't',
  У: 'U',
  у: 'u',
  Ф: 'F',
  ф: 'f',
  Х: 'Kh',
  х: 'kh',
  Ц: 'Ts',
  ц: 'ts',
  Ч: 'Ch',
  ч: 'ch',
  Ш: 'Sh',
  ш: 'sh',
  Щ: 'Shch',
  щ: 'shch',
  Ы: 'Y',
  ы: 'y',
  Э: 'E',
  э: 'e',
  Ю: 'Yu',
  ю: 'yu',
  Я: 'Ya',
  я: 'ya',
  Ь: '',
  ь: '',
  Ъ: '',
  ъ: '',

  // Common non-Russian Cyrillic letters (Ukrainian/Belarusian).
  І: 'I',
  і: 'i',
  Ї: 'Yi',
  ї: 'yi',
  Є: 'Ye',
  є: 'ye',
  Ґ: 'G',
  ґ: 'g',
  Ў: 'U',
  ў: 'u'
});

function transliterateCyrillicToLatin(input) {
  const s = String(input ?? '');
  // Replace only mapped characters; leave the rest as-is.
  return s.replace(/[\u0400-\u04FF]/g, (ch) => CYRILLIC_TO_LATIN[ch] ?? ch);
}

function normalizeTitleForSort(title, { transliterateCyrillic } = {}) {
  let s = String(title ?? '');
  s = stripDiacritics(s);
  if (transliterateCyrillic) {
    s = transliterateCyrillicToLatin(s);
  }
  return s.toLocaleLowerCase();
}

function makeComparePlaylistItemsByTitle({ transliterateCyrillic } = {}) {
  return function comparePlaylistItemsByTitle(a, b) {
    const aTitleKey = normalizeTitleForSort(a.userTitle || a.title || '', { transliterateCyrillic });
    const bTitleKey = normalizeTitleForSort(b.userTitle || b.title || '', { transliterateCyrillic });
    if (aTitleKey === bTitleKey) {
      return (a.__position ?? 0) - (b.__position ?? 0);
    }
    return aTitleKey.localeCompare(bTitleKey);
  };
}

await yargs(hideBin(process.argv))
  .command(
    'insert-tsv',
    'Insert/update tracks from a TSV (videoId<TAB>title) into a local playlist JSON in A-Z order',
    (y) =>
      y
        .option('playlist', {
          type: 'string',
          demandOption: true,
          describe: 'Path to local playlist JSON (e.g. public/local-playlist.json)'
        })
        .option('playlistId', {
          type: 'string',
          demandOption: true,
          describe: 'Which playlist entry in the JSON to modify'
        })
        .option('tsv', {
          type: 'string',
          demandOption: true,
          describe: 'TSV path where each line is: videoId<TAB>userTitle'
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Show changes but do not write'
        })
        .option('create-missing', {
          type: 'boolean',
          default: true,
          describe: 'Create a new track if videoId does not exist'
        })
        .option('only-missing', {
          type: 'boolean',
          default: false,
          describe: 'Do not update titles of existing tracks; only insert missing ones'
        }),
    async (args) => {
      await insertTracksFromTsv(args);
    }
  )
  .command(
    'delete-tsv',
    'Delete tracks listed in a TSV (videoId<TAB>title) from a local playlist JSON',
    (y) =>
      y
        .option('playlist', {
          type: 'string',
          demandOption: true,
          describe: 'Path to local playlist JSON (e.g. public/local-playlist.json)'
        })
        .option('playlistId', {
          type: 'string',
          demandOption: true,
          describe: 'Which playlist entry in the JSON to modify'
        })
        .option('tsv', {
          type: 'string',
          demandOption: true,
          describe: 'TSV path where each line is: videoId<TAB>title (title is ignored for deletion)'
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Show changes but do not write'
        })
        .option('require-present', {
          type: 'boolean',
          default: false,
          describe: 'Fail if any TSV videoId is not present in the playlist'
        }),
    async (args) => {
      await deleteTracksFromTsv(args);
    }
  )
  .command(
    'youtube-delete-tsv',
    'Delete videos listed in a TSV from a real YouTube playlist (uses YouTube Data API quota)',
    (y) =>
      y
        .option('tsv', {
          type: 'string',
          demandOption: true,
          describe: 'TSV path where each line is: videoId<TAB>title (title ignored)'
        })
        .option('playlistId', {
          type: 'string',
          default: '',
          describe: 'YouTube playlist id (preferred for precision)'
        })
        .option('title', {
          type: 'string',
          default: '',
          describe: 'Playlist title (used only if playlistId is not provided)'
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Show what would be deleted but do not call the API'
        })
        .option('require-present', {
          type: 'boolean',
          default: false,
          describe: 'Fail if any TSV videoId is not present in the YouTube playlist'
        })
        .option('limit', {
          type: 'number',
          default: 0,
          describe: 'Limit number of deletions to perform (0 = no limit)'
        })
        .option('sleepMs', {
          type: 'number',
          default: 250,
          describe: 'Delay between delete calls (ms)'
        })
        .option('token-path', {
          type: 'string',
          default: DEFAULT_TOKEN_PATH,
          describe: 'Where to cache OAuth tokens (defaults to utility/.oauth-token.json)'
        }),
    async (args) => {
      await youtubeDeleteFromTsv(args);
    }
  )
  .command(
    '$0',
    'Create/populate a YouTube playlist from exported JSON (yt-playlist.json)',
    (y) =>
      y
        .usage('Usage: $0 --input <file> --title "My Playlist" [options]')
        .option('input', {
          alias: 'i',
          type: 'string',
          demandOption: true,
          describe: 'Path to exported playlist JSON (yt-playlist.json)'
        })
        .option('title', {
          alias: 't',
          type: 'string',
          demandOption: true,
          describe: 'Title for the new YouTube playlist'
        })
        .option('privacy', {
          alias: 'p',
          type: 'string',
          choices: ['private', 'public', 'unlisted'],
          default: 'private',
          describe: 'Playlist privacy setting'
        })
        .option('no-sort', {
          type: 'boolean',
          default: false,
          describe: 'Preserve order from the JSON file instead of sorting by userTitle'
        })
        .option('transliterate-sort', {
          type: 'boolean',
          default: false,
          describe:
            'When sorting, transliterate Cyrillic characters to Latin for a more natural A-Z order in mixed-script titles'
        })
        .option('dry-run', {
          type: 'boolean',
          default: false,
          describe: 'Simulate the run without creating or populating a playlist'
        })
        .option('replace', {
          type: 'boolean',
          default: false,
          describe: 'Delete any of your playlists with the same title before creating the new one'
        })
        .option('append', {
          type: 'boolean',
          default: false,
          describe: 'Append to an existing playlist with the same title; skips videos already present'
        })
        .option('token-path', {
          type: 'string',
          default: DEFAULT_TOKEN_PATH,
          describe: 'Where to cache OAuth tokens (defaults to utility/.oauth-token.json)'
        }),
    async (args) => {
      await runYouTubePlaylistCreate(args);
    }
  )
  .demandCommand(1)
  .alias('h', 'help')
  .alias('v', 'version')
  .wrap(terminalWidth)
  .strict()
  .parse();

async function readTsvVideoIdTitles(tsvPath) {
  const raw = await fs.readFile(tsvPath, 'utf8');
  const lines = raw.split(/\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    if (line.trimStart().startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 2) {
      throw new Error(`Invalid TSV at line ${i + 1}: expected "videoId<TAB>title"`);
    }
    const videoId = parts[0].trim();
    const userTitle = parts.slice(1).join('\t').trim();
    if (!videoId) {
      throw new Error(`Invalid TSV at line ${i + 1}: missing videoId`);
    }
    if (!userTitle) {
      throw new Error(`Invalid TSV at line ${i + 1}: missing title`);
    }
    out.push({ videoId, userTitle });
  }
  return out;
}

async function insertTracksFromTsv(args) {
  const playlistPath = path.resolve(process.cwd(), args.playlist);
  const playlistId = String(args.playlistId);
  const tsvPath = path.resolve(process.cwd(), args.tsv);

  const raw = await fs.readFile(playlistPath, 'utf8');
  const json = JSON.parse(raw);
  const playlist = json?.[playlistId];
  if (!playlist || !Array.isArray(playlist.items)) {
    throw new Error(`Playlist not found or invalid: ${playlistId} in ${playlistPath}`);
  }

  const tsvRows = await readTsvVideoIdTitles(tsvPath);
  const updatesById = new Map();
  for (const row of tsvRows) updatesById.set(row.videoId, row.userTitle);

  const existingItems = playlist.items.map((item, idx) => ({ ...item, __position: idx }));
  const byVideoId = new Map(existingItems.map((item) => [String(item.videoId), item]));

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const [videoId, userTitle] of updatesById.entries()) {
    const existing = byVideoId.get(videoId);
    if (existing) {
      if (args['only-missing']) {
        skipped += 1;
        continue;
      }
      if (existing.userTitle !== userTitle) {
        existing.userTitle = userTitle;
        updated += 1;
      } else {
        skipped += 1;
      }
      continue;
    }

    if (!args['create-missing']) {
      skipped += 1;
      continue;
    }

    const newItem = {
      videoId,
      title: userTitle,
      userTitle,
      thumbnail: '',
      channelTitle: ''
    };
    existingItems.push({ ...newItem, __position: existingItems.length });
    byVideoId.set(videoId, existingItems[existingItems.length - 1]);
    inserted += 1;
  }

  const beforeCount = playlist.items.length;
  const sorted = existingItems.slice().sort(comparePlaylistItemsByTitle);
  const nextItems = sorted.map((item, idx) => {
    const { __position, ...rest } = item;
    return { ...rest, position: idx };
  });

  if (args['dry-run']) {
    console.log(`Dry run: would write ${nextItems.length} items (was ${beforeCount}).`);
    console.log(`Inserted: ${inserted}, Updated titles: ${updated}, Skipped: ${skipped}`);
    return;
  }

  playlist.items = nextItems;
  playlist.fetchedAt = new Date().toISOString();
  await fs.writeFile(playlistPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${nextItems.length} items to ${playlistPath} (${playlistId}).`);
  console.log(`Inserted: ${inserted}, Updated titles: ${updated}, Skipped: ${skipped}`);
}

async function deleteTracksFromTsv(args) {
  const playlistPath = path.resolve(process.cwd(), args.playlist);
  const playlistId = String(args.playlistId);
  const tsvPath = path.resolve(process.cwd(), args.tsv);

  const raw = await fs.readFile(playlistPath, 'utf8');
  const json = JSON.parse(raw);
  const playlist = json?.[playlistId];
  if (!playlist || !Array.isArray(playlist.items)) {
    throw new Error(`Playlist not found or invalid: ${playlistId} in ${playlistPath}`);
  }

  const tsvRows = await readTsvVideoIdTitles(tsvPath);
  const idsToDelete = new Set(tsvRows.map((r) => r.videoId));

  const beforeItems = playlist.items.map((item, idx) => ({ ...item, __position: idx }));
  const existingIds = new Set(beforeItems.map((i) => String(i.videoId)));

  const missing = [];
  for (const id of idsToDelete) {
    if (!existingIds.has(id)) missing.push(id);
  }
  if (args['require-present'] && missing.length) {
    throw new Error(`Some TSV videoIds are not present in playlist: ${missing.slice(0, 10).join(', ')}${
      missing.length > 10 ? ` ... (+${missing.length - 10} more)` : ''
    }`);
  }

  const remaining = beforeItems.filter((item) => !idsToDelete.has(String(item.videoId)));
  const removedCount = beforeItems.length - remaining.length;

  const sorted = remaining.slice().sort(comparePlaylistItemsByTitle);
  const nextItems = sorted.map((item, idx) => {
    const { __position, ...rest } = item;
    return { ...rest, position: idx };
  });

  if (args['dry-run']) {
    console.log(`Dry run: would write ${nextItems.length} items (was ${beforeItems.length}).`);
    console.log(`Removed: ${removedCount}, Missing in playlist: ${missing.length}`);
    return;
  }

  if (removedCount === 0) {
    console.log('No changes: no matching videoIds found to delete.');
    return;
  }

  playlist.items = nextItems;
  playlist.fetchedAt = new Date().toISOString();
  await fs.writeFile(playlistPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
  console.log(`Wrote ${nextItems.length} items to ${playlistPath} (${playlistId}).`);
  console.log(`Removed: ${removedCount}, Missing in playlist: ${missing.length}`);
}

async function youtubeDeleteFromTsv(args) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    throw new Error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET. Check your environment variables or .env file.');
  }

  const tokenPath = path.resolve(process.cwd(), args['token-path'] || DEFAULT_TOKEN_PATH);
  const tsvPath = path.resolve(process.cwd(), args.tsv);
  const playlistIdArg = String(args.playlistId || '').trim();
  const titleArg = String(args.title || '').trim();

  if (!playlistIdArg && !titleArg) {
    throw new Error('Provide either --playlistId or --title to identify the YouTube playlist.');
  }

  const authClient = await getAuthenticatedClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    tokenPath
  });
  const youtube = google.youtube({ version: 'v3', auth: authClient });

  let playlistId = playlistIdArg;
  if (!playlistId) {
    const found = await findPlaylistByTitle(youtube, titleArg);
    if (!found?.id) {
      throw new Error(`No playlist titled "${titleArg}" found.`);
    }
    playlistId = found.id;
  }

  const tsvRows = await readTsvVideoIdTitles(tsvPath);
  const idsToDelete = new Set(tsvRows.map((r) => r.videoId));

  const playlistItems = await fetchPlaylistVideoIdToItemIds(youtube, playlistId);
  const missing = [];
  const deletions = [];

  for (const vid of idsToDelete) {
    const itemIds = playlistItems.get(vid);
    if (!itemIds || itemIds.length === 0) {
      missing.push(vid);
      continue;
    }
    for (const playlistItemId of itemIds) {
      deletions.push({ videoId: vid, playlistItemId });
    }
  }

  if (args['require-present'] && missing.length) {
    throw new Error(
      `Some TSV videoIds are not present in the YouTube playlist: ${missing.slice(0, 10).join(', ')}${
        missing.length > 10 ? ` ... (+${missing.length - 10} more)` : ''
      }`
    );
  }

  const limit = Number(args.limit || 0);
  const sleepMs = Math.max(0, Number(args.sleepMs || 0));
  const planned = limit > 0 ? deletions.slice(0, limit) : deletions;

  if (args['dry-run']) {
    console.log(`Dry run: would delete ${planned.length} playlist items from playlist ${playlistId}.`);
    console.log(`Missing in playlist: ${missing.length}`);
    for (const d of planned.slice(0, 25)) {
      console.log(`  - videoId=${d.videoId} playlistItemId=${d.playlistItemId}`);
    }
    if (planned.length > 25) {
      console.log(`  ... (+${planned.length - 25} more)`);
    }
    return;
  }

  let deleted = 0;
  const failures = [];

  for (const d of planned) {
    try {
      await youtube.playlistItems.delete({ id: d.playlistItemId });
      deleted += 1;
      process.stdout.write(`✔ Deleted videoId=${d.videoId} (playlistItemId=${d.playlistItemId})\n`);
    } catch (error) {
      const msg = extractErrorMessage(error);
      failures.push({ ...d, reason: msg });
      process.stderr.write(`✖ Failed delete videoId=${d.videoId} (playlistItemId=${d.playlistItemId}): ${msg}\n`);
    }
    if (sleepMs) {
      await sleep(sleepMs);
    }
  }

  console.log('---');
  console.log(`Deleted: ${deleted}/${planned.length}`);
  console.log(`Missing in playlist: ${missing.length}`);
  if (failures.length) {
    console.log(`Failures: ${failures.length}`);
    for (const f of failures.slice(0, 10)) {
      console.log(`  • ${f.videoId} (${f.playlistItemId}) -> ${f.reason}`);
    }
    if (failures.length > 10) {
      console.log(`  ... (+${failures.length - 10} more)`);
    }
    process.exitCode = 1;
  }
}

async function fetchPlaylistVideoIdToItemIds(youtube, playlistId) {
  const map = new Map();
  let pageToken;

  do {
    const resp = await youtube.playlistItems.list({
      part: ['id', 'contentDetails'],
      maxResults: 50,
      playlistId,
      pageToken
    });

    for (const item of resp.data.items ?? []) {
      const playlistItemId = item.id;
      const vid = item.contentDetails?.videoId;
      if (typeof playlistItemId !== 'string' || typeof vid !== 'string') continue;
      const videoId = vid.trim();
      if (!videoId) continue;
      const arr = map.get(videoId) ?? [];
      arr.push(playlistItemId);
      map.set(videoId, arr);
    }

    pageToken = resp.data.nextPageToken ?? null;
  } while (pageToken);

  return map;
}

async function runYouTubePlaylistCreate(args) {
  const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
  const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
  const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI;

  if (!CLIENT_ID || !CLIENT_SECRET) {
    console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET. Check your environment variables or .env file.');
    process.exit(1);
  }

  const resolvedInputPath = path.resolve(process.cwd(), args.input);
  const tokenPath = path.resolve(process.cwd(), args['token-path'] || DEFAULT_TOKEN_PATH);

  const playlistData = await loadPlaylist(resolvedInputPath, args['no-sort'], args['transliterate-sort']);

  const authClient = await getAuthenticatedClient({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    tokenPath
  });

  if (args['dry-run']) {
    console.log('Dry run enabled. No calls will be made to YouTube.');
  }

  const youtube = google.youtube({ version: 'v3', auth: authClient });

  let playlistId = null;
  let existingVideoIds = new Set();
  let existingVideoCount = 0;
  const skippedDuplicates = [];
  let usedExistingPlaylist = false;

  if (args.append && args.replace) {
    console.error('Options --append and --replace cannot be used together. Choose one.');
    process.exit(1);
  }

  if (!args['dry-run']) {
    if (args.append) {
      const existing = await findPlaylistByTitle(youtube, args.title);
      if (existing) {
        playlistId = existing.id;
        console.log(`Appending to existing playlist "${args.title}" (${playlistId}).`);
        existingVideoIds = await fetchPlaylistVideoIds(youtube, playlistId);
        existingVideoCount = existingVideoIds.size;
        console.log(`Found ${existingVideoCount} existing videos; duplicates will be skipped.`);
        usedExistingPlaylist = true;
      } else {
        console.log(`No playlist titled "${args.title}" found. A new playlist will be created.`);
        playlistId = await createPlaylist(youtube, {
          title: args.title,
          privacyStatus: args.privacy
        });
      }
    } else {
      if (args.replace) {
        await deleteExistingPlaylists(youtube, args.title);
      }
      playlistId = await createPlaylist(youtube, {
        title: args.title,
        privacyStatus: args.privacy
      });
    }
  } else {
    if (args.append) {
      const existing = await findPlaylistByTitle(youtube, args.title);
      if (existing) {
        playlistId = existing.id;
        existingVideoIds = await fetchPlaylistVideoIds(youtube, playlistId);
        existingVideoCount = existingVideoIds.size;
        console.log(
          `Dry run: would append to playlist "${args.title}" (${playlistId}) containing ${existingVideoCount} videos.`
        );
        usedExistingPlaylist = true;
      } else {
        console.log(`Dry run: no playlist titled "${args.title}" found. Would create a new playlist.`);
        playlistId = 'DRY_RUN_PLAYLIST_ID';
      }
    } else {
      if (args.replace) {
        console.log(`Would delete any existing playlists titled "${args.title}" before recreation.`);
      }
      console.log(`Would create playlist titled "${args.title}" with privacy "${args.privacy}".`);
      playlistId = 'DRY_RUN_PLAYLIST_ID';
    }
  }

  let successCount = 0;
  const failures = [];

  for (const [position, item] of playlistData.entries()) {
    let videoId = item.videoId || item.contentDetails?.videoId || item.id;
    if (!videoId) {
      failures.push({ item, reason: 'Missing videoId' });
      console.warn(`Skipping item without videoId: ${item.title ?? item.userTitle ?? '[untitled]'}`);
      continue;
    }

    if (typeof videoId === 'string') {
      videoId = videoId.trim();
    }

    const displayTitle = item.userTitle || item.title || videoId;

    if (args.append && existingVideoIds.has(videoId)) {
      skippedDuplicates.push(displayTitle);
      console.log(`Skipping duplicate already in playlist: ${displayTitle} [videoId=${videoId}]`);
      continue;
    }

    if (args['dry-run']) {
      console.log(`Would add #${position + 1}: ${displayTitle} [videoId=${videoId}]`);
      successCount += 1;
      continue;
    }

    try {
      const snippet = {
        playlistId,
        resourceId: {
          kind: 'youtube#video',
          videoId
        }
      };

      if (!args.append) {
        snippet.position = position;
      }

      await youtube.playlistItems.insert({
        part: ['snippet'],
        requestBody: {
          snippet
        }
      });
      process.stdout.write(`✔ Added #${position + 1}: ${displayTitle}\n`);
      successCount += 1;
    } catch (error) {
      const message = extractErrorMessage(error);
      process.stderr.write(`✖ Failed to add ${displayTitle}: ${message}\n`);
      failures.push({ item, reason: message });
      await sleep(500);
    }

    await sleep(250);
  }

  const summaryLines = ['', '---', `Inserted videos: ${successCount}/${playlistData.length}`];
  if (skippedDuplicates.length > 0) {
    summaryLines.push(`Skipped duplicates already present: ${skippedDuplicates.length}`);
  }

  if (failures.length > 0) {
    summaryLines.push(`Failures (${failures.length}):`);
    for (const failure of failures) {
      const title = failure.item.userTitle || failure.item.title || failure.item.videoId || '[unknown]';
      summaryLines.push(`  • ${title} -> ${failure.reason}`);
    }
  }

  if (!args['dry-run']) {
    const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
    if (args.append && usedExistingPlaylist) {
      summaryLines.push(`Updated playlist URL: ${playlistUrl}`);
    } else {
      summaryLines.push(`New playlist URL: ${playlistUrl}`);
    }
  } else {
    summaryLines.push('Dry run complete; no playlist was created.');
  }

  summaryLines.push('---');
  console.log(summaryLines.join('\n'));

  if (failures.length > 0 && !args['dry-run']) {
    process.exitCode = 1;
  }
}

async function loadEnvFiles() {
  const envCandidates = [
    path.join(REPO_ROOT, '.env'),
    path.join(SCRIPT_DIR, '.env')
  ];

  try {
    const dotenv = await import('dotenv');
    for (const envPath of envCandidates) {
      if (existsSync(envPath)) {
        const result = dotenv.config({ path: envPath, override: false });
        if (result.error) {
          console.warn(`Warning: Failed to parse ${envPath}:`, result.error.message);
        }
      }
    }
  } catch (err) {
    // dotenv not installed; ignore silently
    if (err.code !== 'ERR_MODULE_NOT_FOUND') {
      console.warn('Warning: unable to load dotenv:', err.message);
    }
  }
}

async function loadPlaylist(filePath, noSort, transliterateSort) {
  let json;
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    json = JSON.parse(raw);
  } catch (error) {
    console.error(`Unable to read playlist JSON at ${filePath}:`, error.message);
    process.exit(1);
  }

  if (!json || !Array.isArray(json.items) || json.items.length === 0) {
    console.error('Playlist JSON does not contain an "items" array with entries.');
    process.exit(1);
  }

  let items = json.items.map((item, idx) => ({ ...item, __position: idx }));

  if (!noSort) {
    const compare = makeComparePlaylistItemsByTitle({ transliterateCyrillic: !!transliterateSort });
    items = items.slice().sort(compare);
  }

  console.log(`Loaded ${items.length} tracks from ${filePath}.`);
  return items;
}

async function getAuthenticatedClient({ clientId, clientSecret, redirectUri, tokenPath }) {
  await ensureDir(path.dirname(tokenPath));
  const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, redirectUri);

  let tokens = null;
  if (existsSync(tokenPath)) {
    try {
      const raw = await fs.readFile(tokenPath, 'utf8');
      tokens = JSON.parse(raw);
      oauth2Client.setCredentials(tokens);
      await oauth2Client.getAccessToken();
      return oauth2Client;
    } catch (error) {
      console.warn(`Warning: failed to use cached tokens at ${tokenPath}: ${error.message}`);
    }
  }

  tokens = await requestNewTokens(oauth2Client, redirectUri);
  await fs.writeFile(tokenPath, JSON.stringify(tokens, null, 2), 'utf8');
  oauth2Client.setCredentials(tokens);
  console.log(`Saved new OAuth tokens to ${tokenPath}`);
  return oauth2Client;
}

async function requestNewTokens(oauth2Client, redirectUri) {
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: YOUTUBE_SCOPE,
    prompt: 'consent'
  });

  console.log('\nAuthorize this application by visiting the following URL:\n');
  console.log(authUrl);
  console.log('');

  if (redirectUri.startsWith('http://localhost')) {
    return await listenForCallback(oauth2Client, redirectUri);
  }

  const rl = readline.createInterface({ input, output });
  const code = await rl.question('Enter the authorization code: ');
  rl.close();
  const { tokens } = await oauth2Client.getToken(code.trim());
  return tokens;
}

async function listenForCallback(oauth2Client, redirectUri) {
  const url = new URL(redirectUri);
  const port = Number(url.port) || 80;
  const pathname = url.pathname || '/';
  const host = url.hostname || '127.0.0.1';

  return await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        if (req.url && req.url.startsWith(pathname)) {
          const reqUrl = new URL(req.url, `${url.protocol}//${req.headers.host}`);
          const code = reqUrl.searchParams.get('code');
          const error = reqUrl.searchParams.get('error');

          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          if (error) {
            res.end('Authorization failed. You can close this window.');
            server.close();
            reject(new Error(`Authorization error: ${error}`));
            return;
          }

          if (!code) {
            res.end('Authorization code missing. You can close this window.');
            return;
          }

          res.end('Authorization successful! You can return to the terminal.');
          server.close();

          const { tokens } = await oauth2Client.getToken(code);
          resolve(tokens);
        } else {
          res.writeHead(404);
          res.end();
        }
      } catch (err) {
        server.close();
        reject(err);
      }
    });

    server.on('error', (err) => {
      reject(err);
    });

    server.listen(port, host, () => {
      console.log(`Waiting for OAuth callback on ${host}:${port}${pathname}`);
    });
  });
}

async function createPlaylist(youtube, { title, privacyStatus }) {
  try {
    const response = await youtube.playlists.insert({
      part: ['snippet', 'status'],
      requestBody: {
        snippet: { title },
        status: { privacyStatus }
      }
    });

    const newId = response.data.id;
    console.log(`Created playlist "${title}" (privacy: ${privacyStatus}) -> ${newId}`);
    return newId;
  } catch (error) {
    console.error('Failed to create playlist:', extractErrorMessage(error));
    process.exit(1);
  }
}

async function deleteExistingPlaylists(youtube, title) {
  const matches = [];
  let pageToken;

  do {
    const resp = await youtube.playlists.list({
      part: ['id', 'snippet'],
      mine: true,
      maxResults: 50,
      pageToken
    });

    const items = resp.data.items ?? [];
    for (const item of items) {
      if ((item.snippet?.title ?? '') === title) {
        matches.push(item.id);
      }
    }

    pageToken = resp.data.nextPageToken ?? null;
  } while (pageToken);

  if (matches.length === 0) {
    console.log(`No existing playlists titled "${title}" found; nothing to delete.`);
    return;
  }

  for (const id of matches) {
    try {
      await youtube.playlists.delete({ id });
      console.log(`Deleted existing playlist ${id} titled "${title}".`);
      await sleep(250);
    } catch (error) {
      console.warn(`Failed to delete playlist ${id}: ${extractErrorMessage(error)}`);
    }
  }
}

async function findPlaylistByTitle(youtube, title) {
  let pageToken;
  do {
    const resp = await youtube.playlists.list({
      part: ['id', 'snippet', 'contentDetails'],
      mine: true,
      maxResults: 50,
      pageToken
    });

    for (const item of resp.data.items ?? []) {
      if ((item.snippet?.title ?? '') === title) {
        return {
          id: item.id,
          itemCount: item.contentDetails?.itemCount ?? null
        };
      }
    }

    pageToken = resp.data.nextPageToken ?? null;
  } while (pageToken);

  return null;
}

async function fetchPlaylistVideoIds(youtube, playlistId) {
  const ids = new Set();
  let pageToken;

  do {
    const resp = await youtube.playlistItems.list({
      part: ['contentDetails'],
      maxResults: 50,
      playlistId,
      pageToken
    });

    for (const item of resp.data.items ?? []) {
      const vid = item.contentDetails?.videoId;
      if (typeof vid === 'string') {
        ids.add(vid.trim());
      }
    }

    pageToken = resp.data.nextPageToken ?? null;
  } while (pageToken);

  return ids;
}

function extractErrorMessage(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error.errors && Array.isArray(error.errors) && error.errors[0]?.message) {
    return error.errors[0].message;
  }
  if (error.response?.data?.error?.message) {
    return error.response.data.error.message;
  }
  if (error.message) return error.message;
  return 'Unknown error';
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
