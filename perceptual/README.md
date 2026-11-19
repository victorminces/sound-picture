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

### How roughness is scored, and how it got here

Roughness is the **modulation depth** of the high-band envelope — how deeply it
rises and falls between 40 and 110 Hz, as a fraction of its level — after two
things have been taken out of it: the voice's own pulse, and any straight-line
fade. Both were found on real and synthetic sounds, not reasoned out.

**The voice's own pulse.** A vowel's energy above 2 kHz arrives as one burst
per glottal cycle, so its envelope is a pulse train at the pitch. For an adult
voice (85–140 Hz) that sits right in the roughness band, and clean vowels drew
grainy: a real /i/ read up to 0.51 as its pitch fell. Each frame is now averaged
over its whole pitch periods to get the shape of one cycle, and that shape is
subtracted cycle by cycle. Whatever is not locked to the pitch — a trill beats
at its own rate — survives. This needs a pitch estimate that can be trusted,
which is why it arrived with the YIN tracker below.

**Depth, not a ratio.** Roughness used to be a peak divided by the modulation
at reference rates either side of the band, to cancel the self-modulation every
noise has. That hid exactly the sound it was meant to show. A trill is a train
of sharp interruptions, sharp pulses put energy at every rate including the
references, and the trill cancelled its own score: a synthetic voiced uvular R
had depth 0.67 and ratio 2.3, which displayed as 0.1. Depth separates them:

```
                                  depth, median / 90th percentile
clean vowels, synthetic           0.01 / 0.01
real vowels                       0.04-0.09 / 0.09-0.34
real /s/ and /sh/                 0.12-0.14 / 0.31-0.36
voiced uvular R, beating 30/s     0.56-0.63 / 0.86-1.00
```

The floor sits at 0.32, above what smooth sounds reach on their own.

**Fades.** A sound fading in or out changes level across the frame, and a ramp
puts its energy at the lowest rates, on the 40 Hz probe. The envelope is
detrended with a straight line, not just its mean.

## Pitch

YIN (de Cheveigné and Kawahara, 2002) replaces plain autocorrelation, with two
additions: an octave guard, which prefers half the period when that dip is
nearly as good — YIN's normalisation favours the doubled period while the
amplitude is changing, so a vowel onset read an octave low — and continuity in
the spirit of pYIN, which scores the octave neighbours against the previous
frame so one noisy frame cannot jump an octave.

Checked against Praat and pYIN on real recordings, on frames where those two
agree:

```
                       gross errors (more than a quarter octave out)
old autocorrelation    22.3%   (mostly octave errors)
YIN alone               5.9%   (octave low at onsets)
YIN + guard            11-24%  (octave high without continuity)
YIN + guard + cont.     0.3%
```

On synthetic vowels with an exactly known contour, 70 to 580 Hz, it makes no
gross errors and is typically within 4–10 cents. The old tracker failed on 31%
of frames at 400 Hz and all of them at 500 Hz, which is where small children's
voices are.

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

roughness             clean /a/, 80-320 Hz       0.00
                      voiced uvular R, 30/s      0.83-1.00
                      voiced gurgle, 70/s        0.59
                      steady hiss                0.00
fluctuation           4/s wobble 0.77            70/s wobble 0.00
```

`tools/probe-pitch.mjs` checks the pitch tracker against a known contour.

Real recordings (Wikimedia Commons IPA samples — three vowels, /s/, /ʃ/) all
read 0.00 roughness at the median and the 90th percentile. They are not in the
repository.

The two temporal dimensions are orthogonal: roughness reads zero across the
fluctuation band and vice versa. In a browser check, sharpness was identical
(3.74) for the same /s/ with and without 70 Hz modulation, so the spectral and
temporal dimensions do not contaminate each other either.

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

- **Never used with a child.** Roughness is checked against real vowels and
  sibilants, but the trills it is meant to show are synthetic. No real French R
  or lateral production has been measured offline yet.
- A breathy vowel ending — the voice turning into breath, quiet — can still
  read rough for a frame or two. It is genuine turbulence, not the voice pulse,
  so it was left rather than tuned away.
- A perfectly smooth sinusoidal wobble on hiss scores low (about 0.1). It is a
  laboratory stimulus, not speech; scoring it higher made a clean /s/ sparkle.
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
node tools/probe-pitch.mjs
```

needs no microphone and no browser.
