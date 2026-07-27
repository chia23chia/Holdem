// Generator for the placeholder sound-cue WAV files under public/sounds.
// Pure Node, no deps — synthesizes short sine-tone sequences and writes
// 16-bit PCM mono WAV. Re-run any time to regenerate; swap in real
// recordings later by just replacing the .wav files (lib/sound.ts only
// cares about the filenames).
// Run with: node scripts/gen-sounds.mjs public/sounds
import fs from 'node:fs';
import path from 'node:path';

const SAMPLE_RATE = 44100;

function synth(segments) {
  // segments: [{freq, duration, volume}] played back-to-back.
  const totalSamples = segments.reduce(
    (sum, s) => sum + Math.round(s.duration * SAMPLE_RATE),
    0,
  );
  const data = new Float32Array(totalSamples);
  let offset = 0;
  for (const seg of segments) {
    const n = Math.round(seg.duration * SAMPLE_RATE);
    const fadeSamples = Math.min(Math.round(0.008 * SAMPLE_RATE), Math.floor(n / 4) || 1);
    for (let i = 0; i < n; i++) {
      const t = i / SAMPLE_RATE;
      let env = 1;
      if (i < fadeSamples) env = i / fadeSamples;
      else if (i > n - fadeSamples) env = (n - i) / fadeSamples;
      const freq = seg.freq2
        ? seg.freq + (seg.freq2 - seg.freq) * (i / n) // linear chirp
        : seg.freq;
      data[offset + i] = Math.sin(2 * Math.PI * freq * t) * seg.volume * env;
    }
    offset += n;
  }
  return data;
}

function writeWav(filePath, samples) {
  const numSamples = samples.length;
  const bytesPerSample = 2;
  const blockAlign = bytesPerSample; // mono
  const byteRate = SAMPLE_RATE * blockAlign;
  const dataSize = numSamples * bytesPerSample;
  const buf = Buffer.alloc(44 + dataSize);

  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16); // fmt chunk size
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(SAMPLE_RATE, 24);
  buf.writeUInt32LE(byteRate, 28);
  buf.writeUInt16LE(blockAlign, 32);
  buf.writeUInt16LE(16, 34); // bits per sample
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);

  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(filePath, buf);
}

const V = 0.28; // gentle default volume

const CUES = {
  deal: [{ freq: 500, freq2: 720, duration: 0.09, volume: V }],
  fold: [{ freq: 260, freq2: 160, duration: 0.16, volume: V }],
  check: [{ freq: 520, duration: 0.07, volume: V * 0.9 }],
  call: [{ freq: 640, duration: 0.09, volume: V }],
  raise: [
    { freq: 700, duration: 0.08, volume: V },
    { freq: 920, duration: 0.1, volume: V },
  ],
  allin: [
    { freq: 500, duration: 0.09, volume: V * 1.1 },
    { freq: 700, duration: 0.09, volume: V * 1.1 },
    { freq: 950, duration: 0.16, volume: V * 1.2 },
  ],
  street: [{ freq: 900, freq2: 650, duration: 0.06, volume: V * 0.8 }],
  win: [
    { freq: 523.25, duration: 0.12, volume: V }, // C5
    { freq: 659.25, duration: 0.12, volume: V }, // E5
    { freq: 783.99, duration: 0.22, volume: V }, // G5
  ],
  myturn: [
    { freq: 880, duration: 0.1, volume: V },
    { freq: 1046.5, duration: 0.14, volume: V },
  ],
};

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: node gen-sounds.mjs <outDir>');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });
for (const [name, segments] of Object.entries(CUES)) {
  const samples = synth(segments);
  writeWav(path.join(outDir, `${name}.wav`), samples);
  console.log('wrote', name);
}
