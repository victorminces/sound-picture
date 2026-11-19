# Sound Dimensions

A second app, in its own folder, built on a different premise from the
spectrogram-style one at the repository root. That one is deployed and shared;
nothing here touches it.

**Premise: show the dimensions a listener is responding to, not the signal.**

## Why not articulation

The obvious alternative to a spectrogram is a display of where the tongue is.
It was considered and rejected. Inferring articulation from a single
microphone is an inverse problem with no unique answer, it needs per-speaker
calibration that a therapy session cannot supply, and — decisively — it cannot
be checked. Validating a claim about tongue position needs ultrasound or
electropalatography standing next to it.

Perceptual dimensions can be checked. Every clinical judgement in this field
is made by ear, and every labelled corpus in it — PERCEPT-R, PAVSig and the
rest — is labelled by listeners. A display whose axes are perceptual shows the
same thing the clinician is already judging, which means it can be correlated
against ratings and shown to be right or wrong.

There is also a gap to fill. Voice assessment already has continuous
perceptual scales (GRBAS, CAPE-V: roughness, breathiness, strain). Articulation
does not — it is scored categorically, correct or distorted. A child 80% of the
way to a good /s/ and one 20% of the way get the same mark. That is precisely
why a spectrogram helps a therapist despite being hard to read: it is
continuous where the scoring is not.

## The substrate

Everything is measured on a **specific loudness pattern** across the Bark
scale, not on an FFT power spectrum. Three differences matter:

- **Frequency.** The ear's resolution is roughly constant in Bark. Equal
  distance along this axis is equal perceived distance, so the display does not
  exaggerate differences at the top of the range the way a linear or even a log
  axis does.
- **Sensitivity.** The ear is far less sensitive at 60 Hz and 15 kHz than at
  3 kHz. An unweighted spectrum draws energy nobody can hear.
- **Level.** Loudness grows as roughly the 0.23 power of intensity, and a band
  below threshold contributes *nothing* rather than a little. That last
  property is why a quiet room draws as black here without any extra gating.

Honestly labelled: this is a working approximation of the Zwicker loudness
model, not an ISO 532-1 implementation. Traunmüller's Bark formula, Terhardt's
threshold in quiet for both the ear weighting and the threshold term,
Schroeder's level-independent spreading function. Sharpness and spread are
ratios within the pattern and survive those simplifications. **Absolute
loudness in sone is not trustworthy here and is never presented as such** — a
web microphone reports no calibrated level, so loudness is shown relative to
the child's own recent speech and nothing else.

## The dimensions

| Shown as | Dimension | What a listener calls it |
|---|---|---|
| height | sharpness | squeaky vs. deep |
| thickness | loudness | strong vs. weak |
| edge softness | spread | focused vs. diffuse |
| grain | roughness | wet, gurgly, slushy |
| ripple | fluctuation | wobbly, unsteady |
| core filament | voicing | buzzy vs. airy |

Only sharpness gets a spatial axis, because position is the channel a child
reads best and sharpness carries the most. Colour runs with height too, so
position and hue say the same thing twice.

### Roughness and fluctuation are not the same thing

They are both amplitude modulation and the app at the repository root conflates
them. They are an order of magnitude apart and they are different percepts:
fluctuation peaks near **4 Hz** and is heard as a wobble; roughness peaks near
**70 Hz**, too fast to resolve as events, and fuses into a wet or gurgly
quality. Roughness is the better candidate for a lateral release.

They need different machinery, because a frame of samples is about 43 ms —
enough for three cycles at 70 Hz and a fraction of one at 4 Hz. So **roughness
is measured within a frame** (Goertzel probes on the detrended, windowed
envelope) and **fluctuation across frames** (a one-pole bracket whose
coefficients come from elapsed time, so a throttled tab detunes nothing).

Roughness is a **peak against neighbouring rates**, not an absolute modulation
depth. Noise modulates itself, and how much depends on its bandwidth, which
varies from one fricative and one child to the next. Measuring depth directly
read a perfectly steady /s/ as half rough. Dividing by the modulation energy at
rates nobody would call rough cancels it, because self-modulation is flat
across rate.

## What was verified offline

`tools/probe-spectral.mjs` and `tools/probe-modulation.mjs` run without a
microphone. They test the claims the display depends on.

```
sharpness vs. place   2k=2.25  2.8k=2.59  4k=2.97  5.6k=3.34  8k=3.74  11k=4.10
                      monotonic: yes

level independence    -50 dBFS 3.96   -40 3.89   -30 3.84   -20 3.80
                      (0.16 drift over a 30 dB range)

/s/ 3.84   palatal 2.94   /sh/ 2.66   vowel 0.94
focused hiss 3.50 Bark   broad slushy 5.56 Bark

roughness vs. rate    steady 0.02   4 Hz 0.00   50 Hz 0.23   70 Hz 0.76
                                    100 Hz 0.62   150 Hz 0.00   250 Hz 0.00
fluctuation vs. rate  2 Hz 0.77   4 Hz 0.81   8 Hz 0.59   30 Hz+ 0.00
roughness vs. depth   0% 0.02   15% 0.10   30% 0.35   50% 0.67   80% 0.88
```

The two temporal dimensions are cleanly orthogonal: roughness reads zero across
the whole fluctuation band and vice versa. In a browser check, sharpness was
identical (3.74) for the same /s/ with and without 70 Hz modulation, so the
spectral and temporal dimensions do not contaminate each other either.

### The voicing confound, and why it went away

A voiced fricative is modulated at F0 by the glottis. If F0 lands in the
roughness band — an adult man at 110 Hz — an absolute measure cannot tell that
from a wet production, and an early version read 0.69 for exactly that case.
The ratio formulation fixed it incidentally: a pulse train puts harmonics into
the reference rates as well as the roughness band, so the ratio stays near one.
The same case now reads 0.04.

## A finding worth recording

Spectral peakedness was implemented, measured, and removed. The intent was to
separate a smeared, double-peaked production from a plain low one, which plain
spread cannot do. On the specific loudness pattern it could not either — 1.55
for /ʃ/ against 1.60 for a 3 k + 8 k smear.

The reason is the interesting part: **the ear's own masking fills in the valley
between two peaks.** The spectral notch the sibling app hunts for may not be
audible at all. Since the clinical ground truth is perceptual, a cue a listener
cannot hear is the wrong cue, and that is an argument for leaning on roughness
for laterality rather than on spectral shape.

## The room

Press and hold to capture it. Two statistics come out of one capture and they
are not interchangeable: the **mean** (as a per-bin median, which tolerates a
cough or a chair creak during the capture) is what levels are compared against;
a high **percentile** is what gets subtracted, because single-bin power is
exponentially distributed and subtracting the mean leaves a fifth of the bins
standing. A hold too short to trust restores the previous profile whole.

## Limitations

- **Never used with a child.** The roughness constants are calibrated against
  synthetic modulated noise, nothing real.
- Numbers are comparable **within a session**, not across children or devices.
  There is no absolute calibration and no child-specific normalisation, and
  children's sibilants sit much higher and vary much more than adults'.
- Sharpness is sharpness-*like*. DIN 45692's constant assumes a calibrated
  reference this app does not have, so the figure is not an acum.
- Roughness still cannot distinguish a genuinely wet production from any other
  source of ~70 Hz modulation in the frication band.
- The display shows nothing about *where the tongue is*, deliberately.

## Running it

```
node server.mjs
```

then open `http://localhost:5174/perceptual/`. A server is required:
`getUserMedia` needs a secure context and `file://` is not one.

```
node tools/probe-spectral.mjs
node tools/probe-modulation.mjs
```

needs no microphone and no browser.
