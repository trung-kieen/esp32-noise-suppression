# Add near the top
import json

# Inside handle_client, after parsing (e.g. after print(...))
# For quick test: echo back some dummy data
dummy_dto = {
    "batchSeq": batch_seq,
    "latencyMs": 42,
    "snr": 15.7,
    "vad": vad_prob,
    "packetLoss": 0,
    "rawSpectrum": [0.1] * 257,      # fake array
    "cleanSpectrum": [0.05] * 257,
    "rawWaveform": raw_pcm.tolist(), # convert tuple → list
    "cleanWaveform": raw_pcm.tolist() # fake same as raw for now
}

await websocket.send(json.dumps(dummy_dto))
