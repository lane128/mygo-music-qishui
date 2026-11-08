// One second of generated stereo test audio; no recordings or account data.
export function stressWave(kind, rate = 44100) {
  const values = new Float64Array(rate * 2)
  let peak = 0
  for (let i = 0; i < rate; i++) for (let c = 0; c < 2; c++) {
    const t = i / rate
    let v = 0.45 * Math.sin(2 * Math.PI * (c ? 661 : 443) * t) +
      0.27 * Math.sin(2 * Math.PI * (c ? 4903 : 3109) * t) +
      0.18 * Math.sin(2 * Math.PI * (c ? 14023 : 12007) * t)
    if (kind === 'transient') v *= Math.sin(2 * Math.PI * 13 * t) > 0.7 ? 1 : 0.04
    else v = Math.tanh(v * 7)
    values[i * 2 + c] = v
    peak = Math.max(peak, Math.abs(v))
  }
  const wave = Buffer.alloc(44 + values.length * 3)
  wave.write('RIFF'); wave.writeUInt32LE(wave.length - 8, 4); wave.write('WAVEfmt ', 8)
  wave.writeUInt32LE(16, 16); wave.writeUInt16LE(1, 20); wave.writeUInt16LE(2, 22)
  wave.writeUInt32LE(rate, 24); wave.writeUInt32LE(rate * 6, 28); wave.writeUInt16LE(6, 32)
  wave.writeUInt16LE(24, 34); wave.write('data', 36); wave.writeUInt32LE(values.length * 3, 40)
  for (let i = 0; i < values.length; i++) wave.writeIntLE(Math.round(values[i] * 0.9999 / peak * 8388607), 44 + i * 3, 3)
  return wave
}
