"""Create 72-second, mono AAC excerpts from the CC0 packs. macOS afconvert required."""
import array
import hashlib
import json
import math
import pathlib
import subprocess
import wave

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / ".artifacts/audio"
TARGET = ROOT / "public/cc0"
TRACKS = [
    ("cc01-calm", "calm/Calm3 - Peaceful Days.ogg"),
    ("cc02-warm", "calm/Calm2 - Childhood Friends.ogg"),
    ("cc03-sad", "calm/Calm5 - Summer Memories.ogg"),
    ("cc04-tense", "dramatic/Alexander Ehlers - Free Music Pack/Alexander Ehlers - Doomed.mp3"),
    ("cc05-hopeful", "calm/Calm1 - A Place I Call Home.ogg"),
    ("cc06-focus", "dramatic/Alexander Ehlers - Free Music Pack/Alexander Ehlers - Spacetime.mp3"),
    ("cc07-epic", "dramatic/Alexander Ehlers - Free Music Pack/Alexander Ehlers - Great mission.mp3"),
    ("cc08-mystery", "dramatic/Alexander Ehlers - Free Music Pack/Alexander Ehlers - Twists.mp3"),
    ("cc09-night", "calm/Calm4 - Sand Castles.ogg"),
    ("cc10-bed", "calm/Calm6 - Innocence.ogg"),
]
records = []
TARGET.mkdir(parents=True, exist_ok=True)
for name, source_name in TRACKS:
    source = SOURCE / source_name
    decoded = SOURCE / (name + "-decoded.wav")
    subprocess.run(["afconvert", str(source), str(decoded), "-f", "WAVE", "-d", "LEI16@32000", "-c", "1"], check=True)
    with wave.open(str(decoded)) as audio:
        rate = audio.getframerate()
        samples = array.array("h", audio.readframes(audio.getnframes()))
    original_seconds = len(samples) / rate
    # Repeat only loopable short sources; use equal-power 0.5-second joins.
    while len(samples) < 72 * rate:
        overlap = min(rate // 2, len(samples) // 4)
        repeated = array.array("h", samples)
        for i in range(overlap):
            p = i / overlap * math.pi / 2
            repeated[-overlap + i] = max(-32768, min(32767, int(samples[-overlap + i] * math.cos(p) + samples[i] * math.sin(p))))
        repeated.extend(samples[overlap:])
        samples = repeated
    samples = samples[:72 * rate]
    gain = .7 * 32767 / max(1, max(abs(s) for s in samples))
    for i, sample in enumerate(samples):
        fade = min(1, i / (.1 * rate), (len(samples) - i - 1) / (1.5 * rate))
        samples[i] = int(sample * gain * max(0, fade))
    prepared = SOURCE / (name + "-prepared.wav")
    with wave.open(str(prepared), "wb") as audio:
        audio.setparams((1, 2, rate, 0, "NONE", "not compressed"))
        audio.writeframes(samples.tobytes())
    output = TARGET / (name + ".m4a")
    subprocess.run(["afconvert", str(prepared), str(output), "-f", "m4af", "-d", "aac", "-b", "96000", "-q", "127"], check=True)
    rms = []
    for offset in range(0, min(len(samples), 30 * rate), rate // 20):
        block = samples[offset:offset + rate // 20]
        rms.append(math.sqrt(sum((s / 32768) ** 2 for s in block) / len(block)))
    records.append({"id": name[:4], "file": output.name, "source": source_name,
                    "sourceDurationSec": original_seconds, "durationSec": 72,
                    "bitrateKbps": 96, "format": "aac", "rms20Hz": rms,
                    "sourceSha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                    "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
                    "bytes": output.stat().st_size})
    print(name, original_seconds, output.stat().st_size, flush=True)
(SOURCE / "prepared.json").write_text(json.dumps(records, indent=2))
