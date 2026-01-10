#!/usr/bin/env node
/**
 * Generate pre-computed visualization data for YouTube videos
 * 
 * Usage:
 *   node generate-visualization.mjs -i input.mp4 -o output.viz
 *   node generate-visualization.mjs -i input.mp4 -o output.viz --fps 30 --bins 512
 *   node generate-visualization.mjs -i input.mp4 -o output.viz --start 60 --duration 180
 * 
 * Output format (.viz file):
 *   - Header: Magic bytes "VIZ1" + version + metadata
 *   - Binary array of frequency data (Uint8Array)
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import process from 'node:process';

// Default configuration
const DEFAULT_FFT_SIZE = 2048;
const DEFAULT_BINS_TO_STORE = 512;
const DEFAULT_SAMPLE_RATE = 30;
const MAGIC = 'VIZ1';
const VERSION = 1;

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    input: null,
    output: null,
    start: 0,
    duration: null,
    bpm: null,
    fps: DEFAULT_SAMPLE_RATE,
    bins: DEFAULT_BINS_TO_STORE,
    fftSize: DEFAULT_FFT_SIZE
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-i' || arg === '--input') {
      opts.input = args[++i];
    } else if (arg === '-o' || arg === '--output') {
      opts.output = args[++i];
    } else if (arg === '--start') {
      opts.start = parseFloat(args[++i]);
    } else if (arg === '--duration') {
      opts.duration = parseFloat(args[++i]);
    } else if (arg === '--bpm') {
      opts.bpm = parseInt(args[++i], 10);
    } else if (arg === '--fps') {
      opts.fps = parseInt(args[++i], 10);
    } else if (arg === '--bins') {
      opts.bins = parseInt(args[++i], 10);
    } else if (arg === '--fft-size') {
      opts.fftSize = parseInt(args[++i], 10);
    }
  }

  if (!opts.input || !opts.output) {
    console.error('Usage: generate-visualization.mjs -i <input> -o <output> [options]');
    console.error('Options:');
    console.error('  --start <seconds>     Start offset (default: 0)');
    console.error('  --duration <seconds>  Duration to process (default: full)');
    console.error('  --fps <number>        Visualization frame rate (default: 30)');
    console.error('  --bins <number>       Frequency bins to store (default: 512)');
    console.error('  --fft-size <number>   FFT size (default: 2048)');
    console.error('  --bpm <number>        Override BPM detection');
    process.exit(1);
  }

  return opts;
}

async function extractAudioPCM(inputFile, startSec, durationSec) {
  console.log(`Extracting audio from ${inputFile}...`);
  
  const ffmpegArgs = [
    '-i', inputFile,
    '-ss', startSec.toString(),
  ];
  
  if (durationSec !== null) {
    ffmpegArgs.push('-t', durationSec.toString());
  }
  
  ffmpegArgs.push(
    '-vn',                    // No video
    '-acodec', 'pcm_f32le',  // 32-bit float PCM
    '-ar', '44100',          // Sample rate
    '-ac', '1',              // Mono
    '-f', 'f32le',           // Raw float format
    'pipe:1'                 // Output to stdout
  );

  return new Promise((resolve, reject) => {
    const chunks = [];
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'inherit']
    });

    ffmpeg.stdout.on('data', chunk => chunks.push(chunk));
    
    ffmpeg.on('error', reject);
    ffmpeg.on('close', code => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exited with code ${code}`));
      } else {
        resolve(Buffer.concat(chunks));
      }
    });
  });
}

function computeFFT(samples, fftSize) {
  const N = fftSize;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  
  // Copy samples and apply Hann window
  for (let i = 0; i < N; i++) {
    const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    real[i] = samples[i] * window;
    imag[i] = 0;
  }
  
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < N; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
    let k = N / 2;
    while (k <= j) {
      j -= k;
      k /= 2;
    }
    j += k;
  }
  
  // Cooley-Tukey FFT
  for (let len = 2; len <= N; len *= 2) {
    const halfLen = len / 2;
    const angle = -2 * Math.PI / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < halfLen; k++) {
        const idx1 = i + k;
        const idx2 = i + k + halfLen;
        const cosA = Math.cos(angle * k);
        const sinA = Math.sin(angle * k);
        const tReal = real[idx2] * cosA - imag[idx2] * sinA;
        const tImag = real[idx2] * sinA + imag[idx2] * cosA;
        real[idx2] = real[idx1] - tReal;
        imag[idx2] = imag[idx1] - tImag;
        real[idx1] += tReal;
        imag[idx1] += tImag;
      }
    }
  }
  
  // Convert to magnitudes and normalize to 0-255
  const magnitudes = new Uint8Array(N / 2);
  let maxMag = 0;
  for (let i = 0; i < N / 2; i++) {
    const mag = Math.sqrt(real[i] * real[i] + imag[i] * imag[i]);
    if (mag > maxMag) maxMag = mag;
    magnitudes[i] = mag;
  }
  
  // Normalize
  if (maxMag > 0) {
    for (let i = 0; i < N / 2; i++) {
      magnitudes[i] = Math.floor((magnitudes[i] / maxMag) * 255);
    }
  }
  
  return magnitudes;
}

function detectBPM(pcmBuffer, sampleRate) {
  console.log('Detecting BPM...');
  
  const samples = new Float32Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 4);
  const windowSize = Math.floor(sampleRate * 0.05);
  const energies = [];
  
  for (let i = 0; i < samples.length - windowSize; i += windowSize) {
    let energy = 0;
    for (let j = 0; j < windowSize; j++) {
      energy += samples[i + j] * samples[i + j];
    }
    energies.push(energy / windowSize);
  }
  
  const threshold = energies.reduce((sum, e) => sum + e, 0) / energies.length * 1.5;
  const peaks = [];
  for (let i = 1; i < energies.length - 1; i++) {
    if (energies[i] > threshold && energies[i] > energies[i-1] && energies[i] > energies[i+1]) {
      peaks.push(i * windowSize / sampleRate);
    }
  }
  
  if (peaks.length < 2) {
    return 120;
  }
  
  const intervals = [];
  for (let i = 1; i < peaks.length; i++) {
    intervals.push(peaks[i] - peaks[i-1]);
  }
  const avgInterval = intervals.reduce((sum, i) => sum + i, 0) / intervals.length;
  const bpm = Math.round(60 / avgInterval);
  
  console.log(`Detected BPM: ${bpm} (from ${peaks.length} peaks)`);
  return bpm;
}

async function generateVisualizationData(inputFile, opts) {
  const pcmBuffer = await extractAudioPCM(inputFile, opts.start, opts.duration);
  const sampleRate = 44100;
  const samples = new Float32Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.byteLength / 4);
  
  console.log(`Extracted ${samples.length} samples (${(samples.length / sampleRate).toFixed(2)}s)`);
  
  const bpm = opts.bpm || detectBPM(pcmBuffer, sampleRate);
  
  const durationSeconds = samples.length / sampleRate;
  const totalFrames = Math.floor(durationSeconds * opts.fps);
  const samplesPerFrame = Math.floor(sampleRate / opts.fps);
  
  console.log(`Generating ${totalFrames} frames at ${opts.fps} fps with ${opts.bins} bins...`);
  
  const allFrameData = new Uint8Array(totalFrames * opts.bins);
  
  for (let frame = 0; frame < totalFrames; frame++) {
    const startSample = frame * samplesPerFrame;
    const frameSamples = new Float32Array(opts.fftSize);
    
    for (let i = 0; i < opts.fftSize; i++) {
      frameSamples[i] = samples[startSample + i] || 0;
    }
    
    const magnitudes = computeFFT(frameSamples, opts.fftSize);
    
    const offset = frame * opts.bins;
    for (let i = 0; i < opts.bins; i++) {
      allFrameData[offset + i] = magnitudes[i];
    }
    
    if (frame % 100 === 0) {
      console.log(`  Progress: ${Math.round(frame / totalFrames * 100)}%`);
    }
  }
  
  console.log('✓ Frequency data generated');
  
  return {
    fps: opts.fps,
    bins: opts.bins,
    frames: totalFrames,
    duration: durationSeconds,
    bpm: bpm,
    data: allFrameData
  };
}

function writeVizFile(outputFile, vizData) {
  const headerSize = 28;
  const totalSize = headerSize + vizData.data.length;
  const buffer = Buffer.alloc(totalSize);
  
  let offset = 0;
  
  buffer.write(MAGIC, offset, 'ascii');
  offset += 4;
  
  buffer.writeUInt8(VERSION, offset++);
  buffer.writeUInt8(vizData.fps, offset++);
  
  buffer.writeUInt16LE(vizData.bins, offset);
  offset += 2;
  
  buffer.writeUInt32LE(vizData.frames, offset);
  offset += 4;
  
  buffer.writeFloatLE(vizData.duration, offset);
  offset += 4;
  
  buffer.writeUInt16LE(vizData.bpm, offset);
  offset += 2;
  
  offset += 10; // Reserved
  
  buffer.set(vizData.data, offset);
  
  return fs.writeFile(outputFile, buffer);
}

async function main() {
  const opts = parseArgs();
  
  console.log('Visualization Data Generator');
  console.log('============================');
  console.log(`Input: ${opts.input}`);
  console.log(`Output: ${opts.output}`);
  console.log(`Start: ${opts.start}s`);
  console.log(`Duration: ${opts.duration || 'full'}s`);
  console.log(`FPS: ${opts.fps}`);
  console.log(`Bins: ${opts.bins}`);
  console.log('');
  
  const vizData = await generateVisualizationData(opts.input, opts);
  
  await writeVizFile(opts.output, vizData);
  
  console.log('');
  console.log(`✓ Visualization data saved to ${opts.output}`);
  console.log(`  Size: ${(vizData.data.length / 1024 / 1024).toFixed(2)} MB`);
  console.log(`  Frames: ${vizData.frames}`);
  console.log(`  Duration: ${vizData.duration.toFixed(2)}s`);
  console.log(`  BPM: ${vizData.bpm}`);
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
