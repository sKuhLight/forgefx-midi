## Before Starting

- Latest processed capture: 2026-07-05 BigCapture, analyzed 2026-07-06. Findings are summarized in
  [`AM4-CAPTURE-2026-07-05.md`](./AM4-CAPTURE-2026-07-05.md).
- Use a scratch preset if possible.
- Start the MIDI/SysEx capture before opening AM4-Edit.
- Wait 5 seconds before and after each test.
- Do one small action at a time.
- Please write rough notes like: "opened tuner", "played high E", "changed BPM to 120".
- Screenshots are helpful if a meter or tuner value is visible.

## Baseline

1. Open AM4-Edit.
2. Wait 10 seconds without touching anything.
3. Select a scratch preset.
4. Build this chain: Compressor -> Amp -> Gate -> Volume/Pan.
5. Capture 10 seconds of silence.
6. Capture 10 seconds of normal playing.
7. Capture 10 seconds of hard strumming.

## Tempo / BPM

1. Open the tempo or tap tempo area.
2. Set BPM to 80, then wait 3 seconds.
3. Set BPM to 120, then wait 3 seconds.
4. Set BPM to 139, then wait 3 seconds.
5. Tap tempo 4 times at medium speed.
6. Tap tempo 4 times slower.
7. Change Tap Tempo Mode: Average -> Last Two -> Average.

## Tuner

1. Open the tuner.
2. Wait 5 seconds with no sound.
3. Play high E for 3 seconds, then stop.
4. Play low E for 3 seconds, then stop.
5. Play an A note if possible.
6. Bend a note flat -> centered -> sharp.
7. Change calibration: 430 -> 440 -> 450.
8. Change accidentals: Flats -> Both -> Sharps.
9. Try tuner mute options if visible.

## Meters

1. Open the main/home meter screen.
2. Capture silence.
3. Play quietly.
4. Play normally.
5. Play loudly.
6. Mute the strings hard.
7. Do one hard strum.

Then repeat the same idea on these pages:

- Input Gate
- Compressor
- Gate
- Amp / Cab meter page, if visible
- Volume/Pan, especially Auto-Swell if visible

For Compressor, please make compression obvious and note the idle value and
playing value if the screen shows numbers.

## CPU

1. Open any Utility, Status, or About page showing CPU.
2. Capture a simple preset.
3. Capture a heavier preset with Compressor, Amp, Reverb, Delay, and Gate.
4. Change a few block types while the CPU page is open.
5. Note whether CPU changes on screen.

## Footswitches

1. Open footswitch/global setup.
2. Change Switch LED Brightness: 0 -> 50 -> 100.
3. Change Switch LED Dim: 0 -> 50 -> 100.
4. Change Startup Mode: Preset -> Scene -> Effects -> Amp.
5. Change Press & Hold Mode: Disabled -> Gig -> Custom.
6. For switches 1 to 4: tap once, hold 2 seconds, release.
7. Try this in Preset, Scene, Effects, and Amp modes.
8. Try any switch assigned to Tuner or Tap Tempo.
9. Note what changes on screen or LEDs.

## Expression / Modifier

1. Add a modifier to Wah Control or Amp Gain.
2. Set source to Pedal 1.
3. Move pedal heel down for 3 seconds.
4. Move pedal halfway for 3 seconds.
5. Move pedal toe down for 3 seconds.
6. Try External 1 and Envelope as sources if visible.
7. Change Min, Max, Start, Mid, End, and Slope.
8. Turn Auto-Engage on and off.
9. Remove the modifier.

## Looper

Please check if AM4 has a Looper anywhere in AM4-Edit or on the device.
If not, just write: "No Looper found on AM4."
