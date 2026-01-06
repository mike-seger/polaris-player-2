import fs from 'fs/promises';
import path from 'path';
import * as esbuild from 'esbuild-wasm';

const repoRoot = process.cwd();
const publicDir = path.join(repoRoot, 'public');
const distDir = path.join(repoRoot, 'dist');
const distAssetsDir = path.join(distDir, 'assets');
const distVideoDir = path.join(distDir, 'video');

async function pathExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(from, to) {
  if (!(await pathExists(from))) return;
  await fs.cp(from, to, { recursive: true });
}

async function rmIfExists(p) {
  if (!(await pathExists(p))) return;
  await fs.rm(p, { recursive: true, force: true });
}

async function ensureDir(p) {
  await fs.mkdir(p, { recursive: true });
}

function buildDistIndexHtml(sourceHtml) {
  let html = String(sourceHtml);

  // Remove the file:// warning overlay/scripts from the build output.
  html = html.replace(/\s*<style>[\s\S]*?#fileSchemeWarning[\s\S]*?<\/style>\s*/m, '\n');
  html = html.replace(/\s*<script>\s*\/\/ Running this app from file:\/\/[\s\S]*?<\/script>\s*/m, '\n');
  html = html.replace(/\s*<div id="fileSchemeWarning"[\s\S]*?<\/div>\s*/m, '\n');

  // Drop font preloads (fonts are inlined into the bundled CSS).
  html = html.replace(/\s*<link[^>]*rel="preload"[^>]*player-fill[01]\.woff2[^>]*>\s*/g, '\n');

  // Point to bundled assets.
  html = html.replace(/<link rel="stylesheet"[^>]*href="style\.css[^"]*"\s*>/i, '<link rel="stylesheet" href="./assets/style.css">');

  // For file:// builds, load local-player config via a plain script tag (fetch() is blocked).
  // This script sets globalThis.__POLARIS_LOCAL_PLAYER_CONFIG__.
  const appScriptTag = '<script src="./assets/app.js"></script>';
  const localPlayerScriptTag = '<script src="./video/local-player.js"></script>';
  html = html.replace(
    /<script type="module"[^>]*src="\.\/js\/bootstrap\.mjs[^"]*"\s*><\/script>/i,
    `${localPlayerScriptTag}\n  ${appScriptTag}`
  );

  return html;
}

async function generateDefaultPlaylistLibrary() {
  // For file:// builds we can't fetch playlist JSON files at runtime reliably.
  // Instead, embed a map of default playlistId -> playlist JSON into the bundle.
  const indexPath = path.join(publicDir, 'video', 'default-playlists.json');
  if (!(await pathExists(indexPath))) return;

  let defaults;
  try {
    defaults = JSON.parse(await fs.readFile(indexPath, 'utf8'));
  } catch {
    return;
  }
  if (!Array.isArray(defaults)) return;

  const inferIdFromUri = (uri) => {
    const u = String(uri || '').trim().replace(/\\/g, '/');
    const base = u.split('/').pop() || '';
    return base.endsWith('.json') ? base.slice(0, -5) : base;
  };

  /**
   * Convert a default playlist entry uri like './video/sub/abc.json'
   * into an absolute filesystem path rooted under public/.
   */
  const uriToPublicPath = (uri) => {
    const u = String(uri || '').trim();
    if (!u) return null;
    if (/^https?:\/\//i.test(u)) return null;
    const rel = u.startsWith('./') ? u.slice(2) : u;
    const normalized = rel.replace(/\\/g, '/');
    if (normalized.startsWith('../') || normalized.includes('/../')) return null;
    return path.join(publicDir, normalized);
  };

  /** @type {Record<string, any>} */
  const libraryById = {};
  /** @type {Array<any>} */
  const expandedDefaults = [];

  for (const entry of defaults) {
    const uri = (typeof entry === 'string')
      ? String(entry || '').trim()
      : (entry && typeof entry === 'object' ? String(entry.uri || entry.url || '').trim() : '');
    if (!uri) continue;

    const fsPath = uriToPublicPath(uri);
    if (!fsPath || !(await pathExists(fsPath))) continue;

    let playlist = null;
    try {
      playlist = JSON.parse(await fs.readFile(fsPath, 'utf8'));
    } catch {
      continue;
    }

    const idFromContent = (playlist && typeof playlist === 'object' && typeof playlist.playlistId === 'string')
      ? String(playlist.playlistId || '').trim()
      : '';
    const id = idFromContent || inferIdFromUri(uri);
    if (!id) continue;

    libraryById[id] = playlist;

    const title = (playlist && typeof playlist === 'object' && typeof playlist.title === 'string' && playlist.title.trim().length)
      ? playlist.title.trim()
      : id;
    const fetchedAt = (playlist && typeof playlist === 'object' && typeof playlist.fetchedAt === 'string')
      ? playlist.fetchedAt
      : '';

    expandedDefaults.push({
      id,
      title,
      uri,
      fetchedAt,
      default: true,
      type: 'polaris',
    });
  }

  const libOutPath = path.join(publicDir, 'video', 'default-playlist-library.json');
  await fs.writeFile(libOutPath, JSON.stringify(libraryById, null, 2) + '\n', 'utf8');

  const expandedOutPath = path.join(publicDir, 'video', 'default-playlists-expanded.json');
  await fs.writeFile(expandedOutPath, JSON.stringify(expandedDefaults, null, 2) + '\n', 'utf8');
}

async function generateLocalPlayerEmbeddedConfig() {
  // file:// builds cannot fetch local JSON due to browser CORS restrictions.
  // Create a stable generated file that bootstrap-file.mjs can always import.
  const inPath = path.join(publicDir, 'video', 'local-player.json');
  const outPath = path.join(publicDir, 'video', 'local-player-embedded.json');

  let hasLocalMedia = false;
  try {
    if (await pathExists(inPath)) {
      const raw = await fs.readFile(inPath, 'utf8');
      const data = JSON.parse(raw);
      hasLocalMedia = !!(data && typeof data === 'object' && data.hasLocalMedia === true);
    }
  } catch {
    hasLocalMedia = false;
  }

  await fs.writeFile(outPath, JSON.stringify({ hasLocalMedia }, null, 2) + '\n', 'utf8');
}

async function generateLocalPlayerJsConfig() {
  // file:// builds cannot fetch local JSON due to browser CORS restrictions.
  // Generate a tiny JS file that sets a global config object.
  const inPath = path.join(publicDir, 'video', 'local-player.json');
  const outPath = path.join(publicDir, 'video', 'local-player.js');

  let hasLocalMedia = false;
  try {
    if (await pathExists(inPath)) {
      const raw = await fs.readFile(inPath, 'utf8');
      const data = JSON.parse(raw);
      hasLocalMedia = !!(data && typeof data === 'object' && data.hasLocalMedia === true);
    }
  } catch {
    hasLocalMedia = false;
  }

  const js = `globalThis.__POLARIS_LOCAL_PLAYER_CONFIG__ = ${JSON.stringify({ hasLocalMedia })};\n`;
  await fs.writeFile(outPath, js, 'utf8');
}

async function main() {
  // In Node, esbuild-wasm starts a long-lived service automatically.
  // initialize() is optional; calling it with no options is safe.
  await esbuild.initialize();

  // Ensure the file:// bundle can embed default playlists.
  await generateDefaultPlaylistLibrary();
  await generateLocalPlayerEmbeddedConfig();
  await generateLocalPlayerJsConfig();

  // IMPORTANT: preserve dist/video (large local media) across builds.
  await ensureDir(distDir);
  await rmIfExists(distAssetsDir);
  await rmIfExists(path.join(distDir, 'img'));
  await rmIfExists(path.join(distDir, 'api'));
  await rmIfExists(path.join(distDir, 'index.html'));
  await ensureDir(distAssetsDir);

  // Bundle JS to a single non-module file.
  await esbuild.build({
    entryPoints: [path.join(publicDir, 'js', 'bootstrap-file.mjs')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['es2019'],
    outfile: path.join(distAssetsDir, 'app.js'),
    minify: true,
    sourcemap: false,
    logLevel: 'info',
    loader: {
      '.json': 'json',
    },
  });

  // Bundle CSS and inline fonts so file:// works.
  await esbuild.build({
    entryPoints: [path.join(publicDir, 'style.css')],
    bundle: true,
    outfile: path.join(distAssetsDir, 'style.css'),
    minify: true,
    sourcemap: false,
    logLevel: 'info',
    loader: {
      '.woff2': 'dataurl',
      '.woff': 'dataurl',
      '.ttf': 'dataurl',
      '.otf': 'dataurl',
    },
  });

  // Copy static assets needed by the HTML.
  await copyIfExists(path.join(publicDir, 'img'), path.join(distDir, 'img'));
  // Do NOT overwrite dist/video if it already exists.
  if (!(await pathExists(distVideoDir))) {
    await copyIfExists(path.join(publicDir, 'video'), distVideoDir);
  }

  // Even when dist/video is preserved (large local media), keep local-player config fresh.
  try {
    await ensureDir(distVideoDir);
    const srcLocalPlayerJs = path.join(publicDir, 'video', 'local-player.js');
    if (await pathExists(srcLocalPlayerJs)) {
      await fs.copyFile(srcLocalPlayerJs, path.join(distVideoDir, 'local-player.js'));
    }
  } catch {
    // ignore copy errors
  }

  await copyIfExists(path.join(publicDir, 'api'), path.join(distDir, 'api'));

  // Favicons / misc static files referenced by index.html.
  const passthroughFiles = [
    'polaris.ico',
    'droid-sans-mono.woff2',
    'player-fill0.woff2',
    'player-fill1.woff2',
    'player.woff2',
    'roboto-mono-400.woff2',
    'spotify-callback.html',
  ];
  for (const name of passthroughFiles) {
    const from = path.join(publicDir, name);
    if (await pathExists(from)) {
      await fs.copyFile(from, path.join(distDir, name));
    }
  }

  // Write dist/index.html
  const srcIndex = await fs.readFile(path.join(publicDir, 'index.html'), 'utf8');
  const distIndex = buildDistIndexHtml(srcIndex);
  await fs.writeFile(path.join(distDir, 'index.html'), distIndex, 'utf8');

  console.log(`\nBuilt file-friendly bundle: ${distDir}`);
  console.log('Open dist/index.html (file://) in your browser.');
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
