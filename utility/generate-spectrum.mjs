#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';

const MAGIC = Buffer.from('SPC1', 'ascii');
const VERSION = 1;

function whichOrThrow(cmd) {
  // Minimal check: rely on spawn error message; keep simple.
  return cmd;
}

function run(cmd, args, { captureStdout = false, input = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: [input ? 'pipe' : 'ignore', captureStdout ? 'pipe' : 'inherit', 'inherit'],
    });

    const chunks = [];
    if (captureStdout) {
      child.stdout.on('data', (d) => chunks.push(d));
    }

    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`${cmd} exited with code ${code}`));
        return;
      }
      resolve(captureStdout ? Buffer.concat(chunks) : undefined);
    });

    if (input) {
      child.stdin.end(input);
    }
  });
}

function hannWindow(n, N) {
  // 0.5 - 0.5*cos(2*pi*n/(N-1))
  return 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (N - 1));
}

function fftRadix2ReIm(re, im) {
  // In-place Cooley–Tukey radix-2 FFT.
  const N = re.length;
  if ((N & (N - 1)) !== 0) throw new Error('FFT size must be power of two');

  // Bit-reversal permutation
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }

  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wlenRe = Math.cos(ang);
    const wlenIm = Math.sin(ang);
    for (let i = 0; i < N; i += len) {
      let wRe = 1;
      let wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j];
        const uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;

        re[i + j] = uRe + vRe;
        im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe;
        im[i + j + len / 2] = uIm - vIm;

        const nextWRe = wRe * wlenRe - wIm * wlenIm;
        const nextWIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nextWRe;
        wIm = nextWIm;
      }
    }
  }
}

function bytesToFloat32LE(buffer, offset) {
  return buffer.readFloatLE(offset);
}

function computeBinsForFrame({ samples, sampleRate, startSample, frameSize, bins, fMin, fMax }) {
  // Use a Hann window on a real frame and compute magnitude in frequency bands.
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);

  for (let i = 0; i < frameSize; i++) {
    const s = samples[startSample + i] ?? 0;
    re[i] = s * hannWindow(i, frameSize);
    im[i] = 0;
  }

  fftRadix2ReIm(re, im);

  const nyquist = sampleRate / 2;
  const minHz = Math.max(0, Math.min(fMin, nyquist));
  const maxHz = Math.max(minHz, Math.min(fMax, nyquist));

  // Precompute magnitude spectrum for positive freqs
  const half = frameSize / 2;
  const mags = new Float64Array(half);
  for (let k = 1; k < half; k++) {
    const mr = re[k];
    const mi = im[k];
    mags[k] = Math.sqrt(mr * mr + mi * mi);
  }

  // Map bins to log-spaced frequency bands for a nicer Winamp-like feel.
  const out = new Uint8Array(bins);
  const logMin = Math.log10(Math.max(10, minHz));
  const logMax = Math.log10(Math.max(10, maxHz));

  const bandEnergies = new Float64Array(bins);
  for (let b = 0; b < bins; b++) {
    const t0 = b / bins;
    const t1 = (b + 1) / bins;
    const hz0 = Math.pow(10, logMin + (logMax - logMin) * t0);
    const hz1 = Math.pow(10, logMin + (logMax - logMin) * t1);

    const k0 = Math.max(1, Math.floor((hz0 / nyquist) * half));
    const k1 = Math.max(k0 + 1, Math.min(half - 1, Math.floor((hz1 / nyquist) * half)));

    let acc = 0;
    for (let k = k0; k <= k1; k++) {
      const m = mags[k];
      acc += m;
    }
    bandEnergies[b] = acc / (k1 - k0 + 1);
  }

  // Convert to dB-ish scale then normalize within the frame.
  let maxVal = 1e-12;
  for (let b = 0; b < bins; b++) {
    const v = Math.log10(1 + bandEnergies[b]);
    if (v > maxVal) maxVal = v;
    bandEnergies[b] = v;
  }

  for (let b = 0; b < bins; b++) {
    const v = bandEnergies[b] / maxVal;
    out[b] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  return out;
}

async function decodeToMonoFloat32(inputPath, { ffmpegPath, sampleRate }) {
  // Output raw f32le mono to stdout.
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    '-f',
    'f32le',
    'pipe:1',
  ];

  const buf = await run(ffmpegPath, args, { captureStdout: true });
  const sampleCount = Math.floor(buf.length / 4);
  const samples = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    samples[i] = bytesToFloat32LE(buf, i * 4);
  }
  return samples;
}

async function downloadAudioForVideoId(videoId, { ytDlpPath, tmpDir }) {
  const url = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const outTemplate = path.join(tmpDir, `${videoId}.%(ext)s`);
  // Bestaudio download; let yt-dlp pick container.
  const args = ['-f', 'bestaudio/best', '-o', outTemplate, url];
  await run(ytDlpPath, args);

  // Find the downloaded file.
  const files = await fs.readdir(tmpDir);
  const match = files
    .filter((f) => f.startsWith(`${videoId}.`))
    .map((f) => path.join(tmpDir, f));
  if (!match.length) throw new Error(`yt-dlp did not produce an audio file for ${videoId}`);

  // Choose the largest; sometimes multiple artifacts.
  let best = match[0];
  let bestSize = 0;
  for (const f of match) {
    const st = await fs.stat(f);
    if (st.size > bestSize) {
      best = f;
      bestSize = st.size;
    }
  }
  return best;
}

function buildSpc32({ videoId, bins, fps, sampleRate, durationMs, frames }) {
  // Header:
  // 0..3   magic 'SPC1'
  // 4      version u8
  // 5      bins u8
  // 6      fps u8
  // 7      reserved u8 (0)
  // 8..11  sampleRate u32le
  // 12..15 durationMs u32le
  // 16..19 frameCount u32le
  // 20..27 videoIdHash u64le (first 8 bytes of sha256)
  // 28..31 reserved
  // payload: frameCount * bins bytes (u8 magnitudes)

  const frameCount = frames.length;
  const header = Buffer.alloc(32);
  MAGIC.copy(header, 0);
  header.writeUInt8(VERSION, 4);
  header.writeUInt8(bins, 5);
  header.writeUInt8(fps, 6);
  header.writeUInt8(0, 7);
  header.writeUInt32LE(sampleRate >>> 0, 8);
  header.writeUInt32LE(durationMs >>> 0, 12);
  header.writeUInt32LE(frameCount >>> 0, 16);

  const h = createHash('sha256').update(videoId, 'utf8').digest();
  // u64le from first 8 bytes
  for (let i = 0; i < 8; i++) header[20 + i] = h[i];

  const payload = Buffer.alloc(frameCount * bins);
  for (let i = 0; i < frameCount; i++) {
    Buffer.from(frames[i]).copy(payload, i * bins);
  }

  return Buffer.concat([header, payload]);
}

async function main() {
  const argv = await yargs(hideBin(process.argv))
    .option('videoId', { type: 'string', demandOption: true, describe: 'YouTube video id' })
    .option('outDir', { type: 'string', default: 'public/spectrum-cache', describe: 'Output directory' })
    .option('bins', { type: 'number', default: 16, describe: 'Number of spectrum bins' })
    .option('fps', { type: 'number', default: 20, describe: 'Frames per second' })
    .option('sampleRate', { type: 'number', default: 22050, describe: 'Resample rate for analysis' })
    .option('frameSize', { type: 'number', default: 2048, describe: 'FFT size (power of two)' })
    .option('minHz', { type: 'number', default: 60, describe: 'Low frequency bound' })
    .option('maxHz', { type: 'number', default: 12000, describe: 'High frequency bound' })
    .option('source', { type: 'string', default: '', describe: 'Optional local audio file path; if set, skip yt-dlp' })
    .option('tmpDir', { type: 'string', default: '.tmp-spectrum', describe: 'Temp directory for downloads' })
    .option('ytDlpPath', { type: 'string', default: 'yt-dlp', describe: 'yt-dlp executable' })
    .option('ffmpegPath', { type: 'string', default: 'ffmpeg', describe: 'ffmpeg executable' })
    .strict()
    .parse();

  const videoId = argv.videoId.trim();
  const bins = Math.max(1, Math.min(255, argv.bins | 0));
  const fps = Math.max(1, Math.min(60, argv.fps | 0));
  const sampleRate = Math.max(8000, argv.sampleRate | 0);
  const frameSize = argv.frameSize | 0;

  if ((frameSize & (frameSize - 1)) !== 0) {
    throw new Error('--frameSize must be a power of two');
  }

  const ytDlpPath = whichOrThrow(argv.ytDlpPath);
  const ffmpegPath = whichOrThrow(argv.ffmpegPath);

  await fs.mkdir(argv.outDir, { recursive: true });
  await fs.mkdir(argv.tmpDir, { recursive: true });

  const inputPath = argv.source
    ? path.resolve(argv.source)
    : await downloadAudioForVideoId(videoId, { ytDlpPath, tmpDir: path.resolve(argv.tmpDir) });

  const samples = await decodeToMonoFloat32(inputPath, { ffmpegPath, sampleRate });

  const durationSec = samples.length / sampleRate;
  const durationMs = Math.max(0, Math.round(durationSec * 1000));

  const hop = Math.floor(sampleRate / fps);
  const frames = [];
  for (let start = 0; start + frameSize <= samples.length; start += hop) {
    const frameBins = computeBinsForFrame({
      samples,
      sampleRate,
      startSample: start,
      frameSize,
      bins,
      fMin: argv.minHz,
      fMax: argv.maxHz,
    });
    frames.push(frameBins);
  }

  const spc = buildSpc32({ videoId, bins, fps, sampleRate, durationMs, frames });
  const outPath = path.join(argv.outDir, `${videoId}.spc32`);
  await fs.writeFile(outPath, spc);

  // eslint-disable-next-line no-console
  console.log(`Wrote ${outPath} (${frames.length} frames, ${bins} bins @ ${fps}fps)`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
