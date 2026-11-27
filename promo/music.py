# Soft, easy-going backing track for the promo, synthesised from scratch (no samples, no licences).
#   python3 music.py out.wav
# Bars are 2 s (120 BPM grid, felt in half time), C major with sevenths: Cmaj7 – G – Am7 – Fmaj7.
# Only warm timbres: electric piano, pad, round bass, a soft kick. No bells, hats or claps; the
# master is low-passed so nothing sounds sharp. Cues follow TL in kiwiboard-promo.html.
import sys, wave
import numpy as np

SR, DUR, BEAT = 48000, 56.65, 0.5
N = int(SR * DUR)
L = np.zeros(N); R = np.zeros(N)
hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)


def put(sig, t0, gain=1.0, pan=0.0):
    i = int(round(t0 * SR))
    if i >= N: return
    sig = sig[: N - i] * gain
    L[i:i + len(sig)] += sig * (1 - pan) ** 0.5
    R[i:i + len(sig)] += sig * (1 + pan) ** 0.5


def tt(d): return np.arange(int(d * SR)) / SR


def epiano(m, d=1.6):  # mellow electric piano: fundamental plus a little octave, gentle attack
    t, f = tt(d), hz(m)
    env = np.minimum(1, t / 0.012) * np.exp(-t / 0.8) * np.clip((d - t) / 0.3, 0, 1)
    return env * (np.sin(2 * np.pi * f * t) + 0.18 * np.sin(4 * np.pi * f * t) * np.exp(-t / 0.3))


def flute(m, d):  # soft sine lead with a slow swell and light vibrato
    t, f = tt(d + 0.3), hz(m)
    env = np.minimum(1, t / 0.06) * np.exp(-t / 1.2) * np.clip((d + 0.3 - t) / 0.3, 0, 1)
    vib = 0.003 * np.sin(2 * np.pi * 5 * t) * np.minimum(1, t / 0.3)
    return env * np.sin(2 * np.pi * f * np.cumsum(1 + vib) / SR)


def bass(m, d=0.9):
    t, f = tt(d), hz(m)
    env = np.minimum(1, t / 0.01) * np.exp(-t / 0.5) * np.clip((d - t) / 0.1, 0, 1)
    return env * (np.sin(2 * np.pi * f * t) + 0.25 * np.sin(4 * np.pi * f * t))


def pad(ms, d):
    t = tt(d)
    env = np.minimum(1, t / 0.6) * np.clip((d - t) / 0.6, 0, 1)
    return env * sum(np.sin(2 * np.pi * hz(m) * t) + np.sin(2 * np.pi * hz(m) * 1.003 * t) for m in ms) / len(ms)


def kick():  # soft, low thump
    t = tt(0.35)
    ph = 2 * np.pi * np.cumsum(45 + 45 * np.exp(-t / 0.04)) / SR
    return np.sin(ph) * np.minimum(1, t / 0.004) * np.exp(-t / 0.15)


CHORDS = [(36, [60, 64, 67, 71]), (31, [59, 62, 67, 69]), (33, [60, 64, 67, 69]), (29, [60, 64, 65, 69])]  # Cmaj7 G6 Am7 Fmaj7
MELODY = [(0, 64, 2), (2, 67, 1), (3, 69, 1), (4, 67, 4),
          (8, 62, 2), (10, 67, 1), (11, 62, 1), (12, 62, 4),
          (16, 60, 2), (18, 64, 1), (19, 69, 1), (20, 67, 4),
          (24, 65, 2), (26, 64, 2), (28, 60, 4)]               # in 8ths, an octave lower than before
GROOVE_END = 52.5

# Intro: the logo arrives on a soft rising arpeggio.
for k, m in enumerate([60, 64, 67, 72]): put(epiano(m, 2.0), 0.05 + 0.2 * k, 0.16, -0.2 + 0.13 * k)
pad_bus = np.zeros(N)
for b in range(0, 27):
    t0, (root, ch) = b * 2.0, CHORDS[b % 4]
    if t0 >= GROOVE_END: break
    i0 = int(t0 * SR)
    pad_bus[i0:i0 + int(2.0 * SR)] += pad([m - 12 for m in ch], 2.0)[: N - i0]
    if b == 0: continue
    beat_on = b >= 5 and b != 14     # the gentle beat starts with the chart, rests for a bar as the phone appears
    for q, m in enumerate([ch[0], ch[2], ch[1], ch[3]]):   # quarter-note broken chord
        put(epiano(m, 1.4), t0 + q * BEAT, 0.09, -0.3 + 0.2 * (q % 2))
    put(bass(root + 12), t0, 0.3)
    put(bass(root + 12 + (7 if beat_on else 0)), t0 + 1.0, 0.24)
    if beat_on:
        put(kick(), t0, 0.45); put(kick(), t0 + 1.0, 0.38)
        if 5 <= b < 14 or 15 <= b < 23 or b >= 23:
            for e, m, ln in MELODY:
                if e // 8 == b % 4: put(flute(m + (12 if 15 <= b < 23 else 0), ln * 0.25), t0 + (e % 8) * 0.25, 0.10, 0.1)

# Small, soft accents: the points dropping into the score, the push notification.
for k, m in enumerate([67, 69, 72, 76]): put(epiano(m, 1.2), 7.25 + 0.28 * k, 0.11, -0.15 + 0.1 * k)
for k, m in enumerate([72, 79]): put(epiano(m, 1.5), 35.25 + 0.14 * k, 0.12, 0.15)
# End card: a warm Cmaj9 that rings out.
put(kick(), 53.15, 0.35)
put(bass(36, 3.0), 53.15, 0.32)
put(pad([48, 55, 59, 62, 64], 3.4), 53.15, 0.2)
for k, m in enumerate([60, 64, 67, 71, 74]): put(epiano(m, 3.0), 53.15 + 0.09 * k, 0.11, -0.2 + 0.1 * k)

put(pad_bus, 0, 0.13)
# A little room: soft echoes crossed between the channels.
d1, d2 = int(0.5 * SR), int(1.0 * SR)
L2, R2 = L.copy(), R.copy()
L2[d1:] += 0.14 * R[:-d1]; R2[d1:] += 0.14 * L[:-d1]
L2[d2:] += 0.06 * L[:-d2]; R2[d2:] += 0.06 * R[:-d2]
mix = np.stack([L2, R2], 1)
# Gentle low-pass on the master (about 3 kHz, 2nd-order) so nothing is sharp.
f = np.fft.rfftfreq(N, 1 / SR)
mix = np.fft.irfft(np.fft.rfft(mix, axis=0) * (1 / np.sqrt(1 + (f / 3000) ** 4))[:, None], n=N, axis=0)
mix = np.tanh(1.1 * mix / np.abs(mix).max()) / np.tanh(1.1) * 0.85
mix[: int(0.02 * SR)] *= np.linspace(0, 1, int(0.02 * SR))[:, None]
fade = int(2.4 * SR); mix[-fade:] *= np.linspace(1, 0, fade)[:, None] ** 1.5
with wave.open(sys.argv[1], "wb") as w:
    w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
    w.writeframes((mix * 32767).astype("<i2").tobytes())
print("wrote", sys.argv[1], f"{DUR} s")
