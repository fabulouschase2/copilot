// AudioWorklet: forwards raw input frames to the main renderer thread in
// ~100 ms batches (38 blocks of 128 samples @ 48 kHz). No DSP here on purpose:
// this file must stay trivial to audit (privacy requirement).
class PcmCollector extends AudioWorkletProcessor {
  constructor() {
    super()
    this._blocksPerBatch = Math.ceil(sampleRate / 128 / 10) // ~100 ms
    this._buf = []
    this._count = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      this._buf.push(new Float32Array(channel))
      this._count++
      if (this._count >= this._blocksPerBatch) {
        this.port.postMessage(this._buf)
        this._buf = []
        this._count = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-collector', PcmCollector)
