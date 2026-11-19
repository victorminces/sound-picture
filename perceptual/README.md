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
| grain | raggedness (+ its rate) | pulsing, wet, gurgly, slushy |
| ripple | fluctuation | wobbly, unsteady |
| core filament | voicing | buzzy vs. airy |

Only sharpness gets a spatial axis, because position is the channel a child
reads best and sharpness carries the most. Colour runs with height too, so
position and hue say the same thing twice.

### The envelope comes from a worklet, and that is the whole point

Both temporal dimensions read off one modulation spectrum of the amplitude
envelope, which an **AudioWorklet** computes on every sample and hands over
decimated to 1.5 kHz.

That architecture is not tidiness. An AnalyserNode returns the most recent
2048 samples whenever it is asked, so consecutive reads overlap by an unknown
amount and filter state cannot be carried across them — each frame has to be
analysed alone. 43 ms cannot resolve modulation rate better than about 55 Hz,
and that is coarser than the distinction being measured. A French uvular /ʁ/
pulses near 30 Hz; a wet fricative modulates nearer 70. At 55 Hz resolution
those are one number.

They were worse than one number. Tested against a trill gated nearly to
silence — as deep as amplitude modulation gets — the within-frame version
scored a 30 Hz trill at **0.04 out of 1** while scoring 70 Hz at 0.34. The
rate most likely to show a trill fell in a dead zone, partly because 25 Hz was
in the *reference* set, so a trill suppressed its own score.

With a 341 ms window the rate resolves to about 6 Hz, so it is now **reported
as a number in its own right** instead of being collapsed into the strength.
That is a better display as well as a better measurement: a therapist can see
that a sound is pulsing 30 times a second rather than gurgling 70 times.

Two further details, both found by measurement rather than reasoning:

**Probe spacing has to stay inside the window's resolution.** Log-spaced
probes left 17 Hz between the top few while the window resolved 6 Hz, so a
95 Hz modulation fell between 88 and 105 and was missed by both — 0.02 against
1.00 at 75 Hz. The probes are now evenly spaced every 5 Hz from 15 to 160.

**The two bands are scored differently, for a measured reason.** Raggedness
uses a peak-to-median ratio, because noise self-modulation up there is large
and strongly bandwidth-dependent. Fluctuation uses depth directly, because at
a few Hz self-modulation is neither: steady noise measured 0.013 to 0.025 deep
across a twelvefold range of carrier bandwidth, against 0.40 or more for
anything genuinely wavering. Scored by ratio instead, fluctuation read 1.00 at
2 Hz, 0.22 at 4 Hz and 1.00 at 7 Hz — the six probes overlap at that window
length, and the median of six correlated numbers is not a background estimate.

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

trill, rate reported  20->20  25->25  30->30  35->35  45->45
                      60->60  75->75  95->95  130->130   (all score 1.00)

fluctuation vs. rate  2 Hz 1.00   4 Hz 1.00   7 Hz 1.00
                      15 Hz 0.00   30 Hz 0.00   70 Hz 0.00
raggedness, same      0.01        0.05        0.00
                      1.00        1.00        1.00

steady noise, raggedness by carrier bandwidth:
  0.15x 0.01    0.35x 0.01    0.9x 0.00    1.8x 0.00
```

The last row is the one that matters most. How much a noise band modulates
itself depends entirely on how wide it is, and a measure that does not cancel
that will pass its calibration and then fail on real speech — which is exactly
what happened to the app at the repository root.

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
- Raggedness still cannot distinguish a genuinely wet production from any other
  source of modulation in its band. It now reports the rate, which helps —
  a trill and a slushy fricative beat at different speeds — but the rate alone
  does not identify the cause.
- The worklet is required. Without it the texture dimensions have no input,
  and the app says so rather than showing zeros, which would read as "this
  child's speech is perfectly smooth".
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
