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

const argv = await yargs(hideBin(process.argv))
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
  .option('dry-run', {
    type: 'boolean',
    default: false,
    describe: "Simulate the run without creating or populating a playlist"
  })
  .option('replace', {
    type: 'boolean',
    default: false,
    describe: 'Delete any of your playlists with the same title before creating the new one'
  })
  .option('token-path', {
    type: 'string',
    default: DEFAULT_TOKEN_PATH,
    describe: 'Where to cache OAuth tokens (defaults to utility/.oauth-token.json)'
  })
  .alias('h', 'help')
  .alias('v', 'version')
  .wrap(terminalWidth)
  .strict()
  .parse();

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || DEFAULT_REDIRECT_URI;

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET. Check your environment variables or .env file.');
  process.exit(1);
}

const resolvedInputPath = path.resolve(process.cwd(), argv.input);
const tokenPath = path.resolve(process.cwd(), argv['token-path'] || DEFAULT_TOKEN_PATH);

const playlistData = await loadPlaylist(resolvedInputPath, argv['no-sort']);

const authClient = await getAuthenticatedClient({
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
  redirectUri: REDIRECT_URI,
  tokenPath
});

if (argv['dry-run']) {
  console.log('Dry run enabled. No calls will be made to YouTube.');
}

const youtube = google.youtube({ version: 'v3', auth: authClient });

let playlistId = null;

if (!argv['dry-run']) {
  if (argv.replace) {
    await deleteExistingPlaylists(youtube, argv.title);
  }
  playlistId = await createPlaylist(youtube, {
    title: argv.title,
    privacyStatus: argv.privacy
  });
} else {
  if (argv.replace) {
    console.log(`Would delete any existing playlists titled "${argv.title}" before recreation.`);
  }
  console.log(`Would create playlist titled "${argv.title}" with privacy "${argv.privacy}".`);
  playlistId = 'DRY_RUN_PLAYLIST_ID';
}

let successCount = 0;
const failures = [];

for (const [position, item] of playlistData.entries()) {
  const videoId = item.videoId || item.contentDetails?.videoId || item.id;
  if (!videoId) {
    failures.push({ item, reason: 'Missing videoId' });
    console.warn(`Skipping item without videoId: ${item.title ?? item.userTitle ?? '[untitled]'}`);
    continue;
  }

  const displayTitle = item.userTitle || item.title || videoId;

  if (argv['dry-run']) {
    console.log(`Would add #${position + 1}: ${displayTitle} [videoId=${videoId}]`);
    successCount += 1;
    continue;
  }

  try {
    await youtube.playlistItems.insert({
      part: ['snippet'],
      requestBody: {
        snippet: {
          playlistId,
          position,
          resourceId: {
            kind: 'youtube#video',
            videoId
          }
        }
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

  await sleep(250); // small delay to avoid hitting quota spikes
}

const summaryLines = [
  '',
  '---',
  `Inserted videos: ${successCount}/${playlistData.length}`
];

if (failures.length > 0) {
  summaryLines.push(`Failures (${failures.length}):`);
  for (const failure of failures) {
    const title = failure.item.userTitle || failure.item.title || failure.item.videoId || '[unknown]';
    summaryLines.push(`  • ${title} -> ${failure.reason}`);
  }
}

if (!argv['dry-run']) {
  const playlistUrl = `https://www.youtube.com/playlist?list=${playlistId}`;
  summaryLines.push(`New playlist URL: ${playlistUrl}`);
} else {
  summaryLines.push('Dry run complete; no playlist was created.');
}

summaryLines.push('---');
console.log(summaryLines.join('\n'));

if (failures.length > 0 && !argv['dry-run']) {
  process.exitCode = 1;
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

async function loadPlaylist(filePath, noSort) {
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
    items = items.slice().sort((a, b) => {
      const aTitle = (a.userTitle || a.title || '').toLocaleLowerCase();
      const bTitle = (b.userTitle || b.title || '').toLocaleLowerCase();
      if (aTitle === bTitle) {
        return a.__position - b.__position;
      }
      return aTitle.localeCompare(bTitle);
    });
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
