# Activities: what each one records

Every activity returns an `ActivityResult` (see `docs/rebuild/contract.md`). Only timing and
movement are kept. No key identities, no typed text, no pointer positions outside the
activity's box. Metrics that could not be measured (for example hold time on a phone
keyboard) are left out of `metrics`, never stored as `NaN`.

`vsBaseline` is a z for each metric against the person's completed calm runs of the same
activity: `(x - mean) / max(sd, 10% of |mean|, 1e-6)`, shown only with at least 2 calm runs
(`activities/stats.ts`, `vsCalm`). The result screen turns z into words: under 1 "about your
usual", 1 to 2 "slightly ...", 2 or more "... than usual". This is labelled change, not stress,
until a personal model for that activity is ready (`personal/`).

Pointer positions are in stage units: 0..1 across the square activity box.

## Typing check (`typing`, 45 s, baseline)

A fixed passage (one of five neutral ones). The input box's value is compared with the
passage by position; only lengths and right/wrong flags are kept. Key codes pair a key-down
with its key-up for a moment and are dropped on release.

| Metric | Meaning |
|---|---|
| `wpm` | correct characters / 5 per minute, first to last keystroke |
| `holdMeanMs`, `holdSdMs` | key-down to key-up (physical keyboards only; under 1.5 s) |
| `flightMeanMs`, `flightSdMs` | key-up to the next key-down (under 2 s) |
| `interKeyMeanMs`, `interKeySdMs`, `interKeyMedianMs` | time between inserted characters, pauses excluded |
| `interKeyCv` | `interKeySdMs / interKeyMeanMs`, rhythm unevenness |
| `errorRate` | inserted characters that did not match the passage at their position / all inserted |
| `corrections` | input events that shortened the text (deletions) |
| `pauses` | gaps over 2 s between inserted characters |
| `charsTyped`, `progress` | characters inserted; share of the passage typed correctly |

## Follow the dot (`follow-dot`, 30 s, baseline)

The dot follows two sums of three slow sines per axis (0.07 to 0.28 Hz), seeded per run.
Starts when the pointer reaches the dot; the first second is ignored.

| Metric | Meaning |
|---|---|
| `meanErrorPct`, `rmsErrorPct` | pointer-to-dot distance, % of the box |
| `onTargetPct` | % of samples within 0.04 of the dot |
| `jerk` | median magnitude of the third derivative of the pointer path (50 Hz resample, 5-sample smoothing), box/s^3 |
| `overCorrectionsPerMin` | times per minute the error flips from > 0.04 behind to > 0.04 past the dot, per axis |

## Target taps (`target-taps`, 40 s, check-in)

Targets of radius 0.075, 0.05 and 0.03 at least 0.25 apart. A centre "Start" circle begins it.

| Metric | Meaning |
|---|---|
| `trials`, `accuracyPct` | targets clicked; % with the click inside the target |
| `timeToTapMs`, `timeToTapSdMs` | median / SD, target shown to click |
| `errorRadii` | mean click distance from centre, in target radii |
| `reactionMs` | median, target shown to the pointer moving 0.01 (mouse/pen only) |
| `movementMs` | median, movement start to click |
| `hesitationMs` | median, last entry into the target to click |
| `overshootPct` | % of trials where the path passed the far edge of the target along the approach line |
| `throughputBits` | mean Fitts index of difficulty `log2(D / W + 1)` / movement time, bits/s |

On touch screens only taps exist, so the movement metrics are left out.

## Colour words (`stroop`, 2 min, challenge)

Half congruent, half not; the same word never twice in a row. 2.5 s per word, 0.35 s gap.
Answer with buttons or R, G, B, Y.

| Metric | Meaning |
|---|---|
| `trials`, `missed` | words shown; words left unanswered |
| `rtCongruentMs`, `rtIncongruentMs` | median reaction time of correct answers |
| `interferenceMs` | incongruent minus congruent |
| `errorRate`, `incongruentErrors` | wrong answers / answered; wrong answers on mismatched words |

## Beat the clock (`beat-the-clock`, 3 min, challenge)

Ten levels of mental arithmetic (single-digit sums up to two-digit products). Per-problem
limit `max(5, 11 - floor(level / 2))` s. A one-up one-down staircase (right: harder, wrong
or out of time: easier) settles at about half right. No comparison with other people.

| Metric | Meaning |
|---|---|
| `problems`, `accuracy` | problems answered or timed out; share right |
| `meanRtMs` | mean time of right answers |
| `meanLevel`, `finalLevel` | average level across problems; level at the end |
| `timeouts`, `stoppedEarly` | problems that ran out of time; 1 when Stop was pressed |

## Paced breathing (`paced-breathing`, 3 min, recovery)

Six breaths a minute: 4 s in, 6 s out.

| Metric | Meaning |
|---|---|
| `breaths`, `completedPct` | complete guided breaths; % of the planned time done |
| `hrStart`, `hrEnd`, `hrChange` | mean HR in the first and last 30 s (needs a live device) |
| `rsaBpm` | mean over complete breaths of max minus min instantaneous HR (60000 / RR) within the breath |

## Steady hand (`steady-hand`, 20 s, check-in, phone)

`DeviceMotionEvent` (`acceleration`, else `accelerationIncludingGravity`), high-passed by
subtracting a 0.5 s moving average. iOS asks for permission from the Start button.

| Metric | Meaning |
|---|---|
| `rms`, `p95` | RMS and 95th percentile of the high-passed magnitude, m/s^2 |
| `peakHz` | strongest frequency 2 to 15 Hz (plain DFT, 0.25 Hz steps) |
| `bandShare` | share of 2 to 15 Hz power in 8 to 12 Hz (physiological tremor) |
| `sampleHz` | motion events per second |

## Tap the rhythm (`tap-rhythm`, about 30 s, check-in)

Count-in of 4, then 8 paced beats at 80 bpm (750 ms), then 16 taps without the beat.

| Metric | Meaning |
|---|---|
| `pacedTaps`, `asyncMeanMs`, `asyncSdMs` | taps during the beat; tap minus nearest beat (negative = early) |
| `freeTaps`, `intervalMeanMs`, `intervalMedianMs` | taps without the beat and their intervals |
| `intervalCv` | SD / mean of the free intervals |
| `driftMsPerTap` | slope of interval against tap number (negative = speeding up) |
| `tempoErrorPct` | (mean free interval - 750) / 750 |

## Personal model features

`personal/model.ts` `PERSONAL_FEATURES` picks a few metrics per activity that are measured
on every device (no hold time, which phones lack).
