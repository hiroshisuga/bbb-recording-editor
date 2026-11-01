#!/usr/bin/env python3
"""Reproduce 250 ms cues A and tape, without dependencies. C is the supplied wooden sample."""
import math
import struct
import wave
from pathlib import Path

RATE = 48000
N = RATE // 4


def note(t, onset, frequency, decay):
    x = t - onset
    if x < 0:
        return 0.0
    attack = (1 - math.exp(-x / 0.0025)) ** 2
    return attack * sum(a * math.sin(2 * math.pi * frequency * ratio * x)
                        * math.exp(-x / (decay / math.sqrt(ratio)))
                        for ratio, a in [(1, 1), (2, 0.12), (3, 0.025)])


def write_pcm(path, values):
    rms = math.sqrt(sum(v * v for v in values) / N)
    gain = min(10 ** (-25.5 / 20) / rms, 0.28 / max(map(abs, values)))
    with wave.open(str(path), 'wb') as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(RATE)
        wav.writeframes(struct.pack('<' + 'h' * N, *(round(v * gain * 32767) for v in values)))


def generate(path):
    values = [note(i / RATE, 0.004, 659.255, 0.033)
              + note(i / RATE, 0.105, 523.251, 0.048) for i in range(N)]
    values = [v * (0.5 - 0.5 * math.cos(math.pi * min(1, (N - 1 - i) / (RATE * 0.025))))
              for i, v in enumerate(values)]
    write_pcm(path, values)


def generate_tape(path):
    # Two short FM glissandi evoke a tape being shuttled quickly. No speech or
    # external sample is used. Both ends fade to zero; loudness matches cue A.
    values = [0.0] * N
    for onset, duration, direction in [(0.004, 0.106, 1), (0.118, 0.116, -1)]:
        phase = 0.0
        for i in range(N):
            x = i / RATE - onset
            if not 0 <= x < duration:
                continue
            u = x / duration
            frequency = 650 + 2300 * math.sin(math.pi * u) ** 1.4
            frequency *= 1 + 0.12 * math.sin(2 * math.pi * (32 + 20 * u) * x)
            phase += 2 * math.pi * frequency / RATE * direction
            envelope = math.sin(math.pi * u) ** 1.2
            values[i] += envelope * (math.sin(phase) + 0.2 * math.sin(2 * phase) + 0.07 * math.sin(3 * phase))
    write_pcm(path, values)


if __name__ == '__main__':
    generate(Path(__file__).with_name('cut-cue-a.wav'))
    generate_tape(Path(__file__).with_name('cut-cue-tape.wav'))
