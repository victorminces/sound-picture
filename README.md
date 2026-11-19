# Sound Picture

A real-time visual representation of speech sounds, for therapy work on /s/ and
the sibilant family.

It does not judge. There is no target, no score, no reward and no label saying
whether a production was right. The app draws what it hears, as clearly as it
can, and the therapist supplies the guidance.

The reason it exists: a spectrogram carries everything you need, which is why
it works as biofeedback for some children, and it is also dense, grey and
abstract, which is why it defeats younger ones. This keeps the information and
changes how it is drawn.

---

## Running it

```powershell
npm run dev
```

Then open <http://localhost:5174/>.

A server is required. `getUserMedia` only works in a secure context, and
opening `index.html` straight off the disk (`file://`) is not one. `localhost`
counts as secure, which is what the bundled zero-dependency server is for.

No dependencies, no build step.

```powershell
npm run probe
```

runs the offline checks: gate decisions on synthetic sibilants and vowels, the
display spectrum of each production as ASCII, roughness on clean vowels, hiss and
trilled Rs, and the display reference lock. `tools/grain-check.html`, opened
through the dev server, checks the drawing: that a ragged sound is drawn grainy
and a vowel is not.

---

## Two analysis paths

The window used for *drawing* and the analysis used for *measuring* are
independent, and separating them removes the time-frequency tradeoff from
everywhere it does not belong.

**The spectral path** (`spectral.js`) owns the envelope that gets drawn, plus
every measure that is a summary of that envelope's shape: centre of gravity,
spread, high-frequency ratio, bimodality, antiresonance notch. It deliberately
uses a long window (42.7 ms) and heavy band averaging, because all of those
are averages anyway and stability matters more than speed.

**The temporal path** (`temporal.js`) works straight off the waveform with no
FFT at all, and owns everything needing millisecond resolution: level, roughness,
F0, periodicity.

### The envelope filter

Before anything is binned for display, the linear power spectrum is smoothed
with a box filter of constant width in Hz (450 Hz). This is what turns a
narrowband view into a wideband one: harmonics sit F0 apart in Hz, so the
kernel that erases them is constant in Hz too, while formants sit roughly
1300 Hz apart for a child, so the envelope survives. It is the same choice that
sets the ~3 ms window of a classic wideband spectrogram, arrived at from the
other direction.

Doing it here rather than by shortening the analysis window keeps fine
frequency resolution for the measurement path, and cuts per-band estimate noise
about fourfold as a bonus. The measurement path — moments, notch — still sees
the unsmoothed spectrum.

### Tilt and brightness

A vowel runs 20–30 dB hotter than the sibilant band, so with one global scale
across six octaves the vowels set the top of the window and /s/ sinks to the
bottom of it. A **fixed tilt**, a gain curve rising with frequency (default
+9 dB/octave, pivot 1 kHz, centred in its range), compensates. Being a constant offset per band, it
leaves every production comparable to every other and to a frozen reference —
unlike per-band AGC, which would make the picture lie about relative energy and
would undo the reference lock below.

**Brightness** slides the 46 dB window up and down. Both are display-only and
never touch the measurements.

That split matters most for roughness. A 2048-point FFT averages power over
42.7 ms, which acts as a low-pass with its first null at 23 Hz — so any
raggedness faster than roughly 12 Hz is gone before anything downstream could
look at it. Rectifying the waveform instead costs nothing and keeps modulation
up to several hundred Hz.

---

## What is on screen

**The field** (left) is frequency against time, 80 Hz to 15 kHz, newest at the
right, scrolling away over about seven seconds.

The display range is wider than the measurement range at both ends: down to
80 Hz so voicing is visible, up to 15 kHz so the weak, diffuse high-frequency
energy of /f/ shows. Spectral moments stay on 1.2–12 kHz, because microphone
response above that is unreliable and widening it would shift every
centre-of-gravity figure these notes are calibrated against.

**The shape** (right) is the spectrum of this instant, mirrored into a single
form on the field's frequency axis. This is the view you freeze.

### Visual channels

Each quantity gets a channel suited to it, kept separate so adding one does not
muddy another:

| Channel | Carries |
|---|---|
| Vertical position | frequency |
| Hue | frequency again, fixed |
| Brightness | energy in that band |
| **Grain** | **roughness** — a ragged airstream renders rough, a clean one glassy |
| F0 line | pitch, with weight and brightness scaled by how voiced the moment is |
| Amber marker | an antiresonance notch |
| White thread | centre of gravity, moment by moment |

**Colour is a fixed function of frequency, never of quality.** The same sound
always draws the same colours. That is what lets a child recognise their own
/s/ by sight, and it is structurally why nothing on screen can read as praise
or correction.

The grain is an iconic mapping rather than an arbitrary one — slushy looks
slushy, and nobody has to be taught what it means. It is driven entirely by the
measured modulation; at zero roughness the drawing is exactly smooth.

**The spectral measures need no channel of their own.** Centre of gravity,
spread, high-frequency ratio and bimodality are summaries of the envelope's
shape, so drawing the envelope well already shows them. A therapist reading
where the hump sits and how wide it is *is* reading COG and spread.

### What each sound looks like

- a crisp /s/ — a bright gold and green band pressed against the top, smooth;
- an sh — visibly lower, in teal;
- an interdental th — a dim wash spread over most of the height;
- an /f/ — weaker still and broader, reaching right to the top of the range;
- a /z/ — like an /s/ with a violet bar switched on at the bottom of the field
  and a bright F0 line running through it. That is the single most
  pointable-at thing in the app;
- a lateral — lower and broader, and if the airstream is ragged, visibly
  grainy.

---

## Freeze and compare — removed

There was a freeze-and-compare workflow: hold a model sound, keep it as a
dashed outline on the shape view, and have the child fill it. Freezing also
pinned the brightness scale to that production, so a weaker one rendered
visibly dimmer rather than being normalised back up.

The control has been removed. **The capability is still in the code** — the
renderer accepts a reference outline, and `spectral.js` still exposes
`lockDisplayTop` / `unlockDisplayTop`, which the probe still tests. Nothing was
deleted, because this project has no version control to recover it from. It
needs only a button to come back.

With no reference to pin against, the brightness scale floats at all times, and
the picture therefore shows spectral shape rather than absolute loudness. The
brightness slider is now how you place the scale.

## Measurements

Descriptive only, with no interpretation attached, and **ungated**: they are
reported for any sound above the room floor, not only for sibilants. So a
centre of gravity will appear for a vowel too — it simply describes where that
sound's energy sits, which is what the number means.

The only thing still held back by the sibilant gate is the **grain**, and for a
correctness reason rather than a preference: a vowel's envelope is modulated at
the voicing rate, so grain would appear on every vowel and mean nothing.

There is no threshold control. A sound has to clear the measured room floor by
a fixed 6 dB, which is only there to keep the room itself out of the numbers.
The panel reports that margin as **Above room floor**, which is the number to
look at first whenever something is not being reported.

Two things about that test were wrong and are worth recording, because both
produced the same symptom — measurements missing most of the time:

1. It compared the *noise-subtracted* signal against the *unsubtracted* room
   floor. Subtraction removes the noise, and with 1.6× over-subtraction on top,
   the margin was understated by roughly the whole noise level. Both sides are
   now measured raw.
2. The band ran from 60 Hz, where rooms are loudest. Rumble dominated the floor
   *and* the signal, so speech barely moved the total. The band is now
   200 Hz–10 kHz, where speech energy actually lives — high enough to clear
   rumble, low enough to include a vowel's first formant.

- **Centre of gravity** — first spectral moment, the most robust single
  acoustic correlate of /s/ place.
- **Spread** — second moment, in **octaves**. On a linear Hz axis a
  high-frequency /s/ always looks wider than a low-frequency sh purely because
  of where it sits, which would confound place with focus. Log-frequency
  moments do not.
- **Focus** — spread, inverted and bounded.
- **High-frequency ratio** — energy above 4.5 kHz against 2–4.5 kHz.
- **Roughness** — how deeply the high-band envelope rises and falls at
  40–110 Hz, after the voice's own pulse has been removed. Zero for clean
  vowels and a clean hiss; near 1 for a trilled or gurgly production. See
  *Roughness* below for why it replaced the earlier flutter measure.
- **Notch** — deepest valley flanked by real energy on both sides, searched
  over 2–6 kHz, detected unsmoothed. Suppressed on voiced sounds, because the
  gap between voice bar and frication in a /z/ is a genuine deep valley that
  has nothing to do with a side channel.
- **Steadiness**, **Voicing**, **F0**.
- **Level** — broadband, 60 Hz to 20 kHz, and the same figure that decides
  whether anything is reported at all. Gain dependent, so read it as a
  recording check rather than as a property of the child.

Voicing is drawn as the F0 line, whose weight and brightness rise faster than
voicing itself, so a marginal moment stays discreet and a fully voiced one is
bold. Detection is deliberately generous and the *drawing* does the
discriminating: measured periodicity is around 0.12-0.20 for room noise and
0.58 or better for voiced speech even when the noise is louder than the voice,
so the cut-in at 0.38 sits in clear air between them.

Voicing has a gate of its own, separate from the sibilant gate. The temporal
path measures periodicity on the raw waveform with no level test, and the
autocorrelation of quiet room noise drifts well past a naive threshold, which
drew an F0 line over silence. Voicing now requires the voice band itself to sit
clearly above the measured room floor, and a firmer periodicity threshold.

The remaining hole: a steady hum that was *present* during the room measurement
becomes part of the floor and is correctly ignored, but one that starts
afterwards can read as voicing. Re-measure the room if that happens.

### Roughness

The grain used to be driven by a *flutter* measure: the coefficient of
variation of a smoothed envelope against a fixed threshold. It never worked.
How much a band of noise varies on its own depends on how wide the band is, and
the threshold was calibrated on a narrow synthetic carrier; on anything as wide
as a real /s/ it read 0.00 at every modulation rate tested. And the grain was
gated on the sibilant gate, which a French R or any non-sibilant never opens —
in simulation the gate was open for 0% of an R's frames — so even a working
measure could not have drawn grain on one.

Both are replaced with what was developed and checked in the perceptual app
(`perceptual/README.md` has the full account):

- **The measure** (`src/modulation.js`, `src/pitch.js`). A YIN pitch tracker
  finds the voice's pulse, which is averaged over whole periods and subtracted
  from the envelope; a vowel's energy above 2 kHz arrives as one burst per
  glottal cycle, and for an adult voice that pulse sits right in the roughness
  band. What is left is scored on modulation depth at 40–110 Hz, above what
  smooth sounds reach. Clean vowels at 80–250 Hz and steady hiss read 0.00; a
  voiced uvular R reads 0.8–1.0.
- **The gate.** Grain now follows `f.loud` — there is sound — rather than the
  sibilant gate. Vowels no longer need keeping out by gating; they read zero
  on their own.
- **The drawing.** Light flecks and dark pits, square, about 4.5 CSS pixels,
  in place of opacity scaled up and down per column (which clipped in bright
  regions and read as vertical streaks). Raggedness rises in 25 ms and falls in
  50, and flecks fade in between 0.05 and 0.20, so an R's grain stops at the R
  instead of trailing into the next vowel.

Measured in `tools/grain-check.html` on four spoken a-R-a and a held R:

```
                                   before     after
grain added to each R              x1.00      x1.74 - x3.08
grain added to the vowels          0.000      0.000 - 0.001
```

This app's own pitch, voicing, gate and F0 line are unchanged; YIN is used only
inside the roughness measure.

### Gating

Routed on periodicity, because voiced and voiceless sounds need different
evidence. Voiceless: a fricative puts almost nothing in the vowel formant
region (300–2600 Hz). Voiced: for /z/ the voice bar legitimately dominates, so
the gate demands real frication at 4.5–12 kHz instead — which is also what
rejects a child's "ee", whose F2/F3 can reach 3.5 kHz but which has nothing at
all above 4.5 kHz.

### Background noise

**Press and hold to record and remove background noise.** The capture runs for
exactly as long as the button is held; whatever the microphone hears in that
time — a fan, a hum, the room itself — is averaged into a noise profile and
spectrally subtracted from every frame afterwards. Hold it longer for a better
estimate, and do it again whenever the room changes.

Press-and-hold rather than a click on purpose. A click did the same job
invisibly in 0.8 s, which made it impossible to tell that anything had been
captured, or when. Holding makes both obvious, and lets you take a longer
sample of a difficult room.

The floor is the per-bin **median** of the captured frames, not the mean.
Power means are dominated by their peaks, so one breath, click or chair creak
during the capture drags the whole floor up and every later sound then
measures as barely above the room. The median tolerates up to half the capture
being contaminated with no effect at all; past half it follows the
contamination, which is the point at which you were recording the wrong thing
and should record again.

Two different statistics come out of the same capture. The **mean** (estimated
as the median above) is what the band energies and the gate are measured
against, where an average really is the right question to ask. The
**subtraction** uses a high percentile of the same frames instead, and this
matters more than it sounds. The power in one FFT bin of a steady noise is
exponentially distributed about its mean, so subtracting the mean — even 1.6x
of it, as this did — leaves roughly a fifth of the bins still standing on every
frame. That residue was a speckle that filled the whole picture in a perfectly
quiet room. A percentile is what the room actually reaches rather than what it
averages, and subtracting that empties it.

Then the display gets its own floor, per band, measured rather than predicted.
Every captured frame is put through the whole chain — subtraction, smoothing,
binning — and a high percentile of the result becomes that band's floor; a band
fades in over the 6 dB above its own floor. The single scalar floor this
replaces was pinned to the loudest band of the *tilted* room, which with any
tilt at all is the topmost band. So an upward flicker at 20 kHz drew brightly,
brighter still with the brightness slider up, while exactly the same flicker in
the middle of the range drew black — which is why the top of the picture stayed
lit however carefully the room was recorded.

A hold shorter than 0.4 s is treated as a slip of the finger: the previous
profile is kept whole and put back, and the app says so, rather than quietly
replacing a good profile with a bad one. Elapsed time is the policy, not frame
count, so a slow machine does not reject a hold that was plenty long by the
clock.

This last point was aspiration rather than fact for a while. The rejection path
cleared the capture and then left the half-gathered *sum* of a few frames in
place of the profile — a floor several times too high. The visible effect was
upside down: a quick click over-subtracted so hard that the picture went clean,
while a correct press-and-hold, doing the honest thing, looked like it had done
nothing at all.

One short automatic capture still runs at startup so the app is usable
immediately.

Note for the record: the **measurement threshold** slider that used to sit here
never removed noise. It set a gate. Noise removal has always been this
subtraction; it was simply labelled badly.

---

## Microphone handling

The app explicitly requests `echoCancellation: false`, `noiseSuppression:
false` and `autoGainControl: false`.

This is not incidental. All three are built to protect speech on calls, and all
three attack exactly the signal being drawn: steady, high-frequency, low-energy
fricative noise. With noise suppression left on, a perfectly good /s/ can be
gated away to nothing, or have its spectrum reshaped enough to move the centre
of gravity by a kilohertz.

Browsers do not all honour these constraints. The app reads the track settings
back and warns in the panel if processing is still active, or if the sample
rate is too low to see where /s/ lives. **Take those warnings seriously.**

The microphone is never routed to the speakers, to avoid howl-round.

---

## Limitations

- **Untested with real speech.** Everything is validated against synthetic
  signals and driven end to end in a real browser; no child and no clinician
  has used it.
- **Roughness and notch are candidate cues for lateral productions, not settled
  diagnostics.** They are offered so you can find out whether they separate
  your lateral cases — not because the literature says they will. There is no
  clean acoustic signature for laterality.
- The picture shows spectral shape rather than loudness: the scale floats and
  there is no longer a reference to pin it against.
- Spectral measures suit sustained fricatives and slow syllable repetition;
  they describe rapid transitions poorly.
- Microphone and room both colour the measurements. Read change within a
  session, and freeze a fresh reference each session.

---

## Project layout

```
index.html        markup and the control panel
server.mjs        zero-dependency dev server
src/audio.js      microphone capture and constraint reporting
src/spectral.js   FFT path: envelope, moments, notch   (no DOM, no audio API)
src/temporal.js   waveform path: level, roughness, F0  (no DOM, no audio API)
src/modulation.js roughness, copied from perceptual/    (no DOM, no audio API)
src/pitch.js      YIN pitch tracker, copied likewise    (no DOM, no audio API)
src/viz.js        canvas rendering                     (no audio API)
src/app.js        wiring, smoothing, controls, freeze and compare
tools/probe.mjs   offline checks
tools/grain-check.html  in-browser check that grain is drawn where it should be
```

Both analysis modules are deliberately free of browser APIs: they take a
spectrum or a waveform and return numbers. That is what makes the offline probe
possible, and what will make them testable against real recordings later.

---

## Not built yet

- Word and phrase lists — initial, medial and final /s/, s-blends, and
  /s/ ~ /θ/ minimal pairs (sick/thick, sum/thumb, mouse/mouth).
- Keeping a whole *attempt* rather than one instant, so two tries can sit side
  by side.
- Re-exposing the frozen outline and the brightness lock behind some control.
- An AudioWorklet, for a genuinely continuous envelope across frame boundaries
  rather than one measured within each frame.
- Saving a reference between sessions.
