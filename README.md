# dsh-plugin-hdc

HarmonyOS device tools for DeepSeek Harness, over `hdc`.

The plugin registers a family of `hdc_*` tools, so a HarmonyOS device can be
driven from the conversation: see the screen, tap, read the control tree, install
an app, read logs, move files, and record the screen. It also adds a device panel
to the sidebar, for driving the same device without a conversation turn.

## Device panel

Open the phone icon in the sidebar to reach a full-page panel for the attached
device:

- **Live video** — the picture is a stream, not a polled screenshot, so motion on
  the device appears without waiting out a refresh interval. Expect a few frames
  per second rather than 30: see *Why the picture runs at a few frames per
  second*.
- **Taps follow the finger.** The picture shows a target cursor with a center dot
  at the exact point that becomes the device coordinate, outlined so it stays
  visible over a light app as well as a dark one. A press is taken on
  `pointerdown` rather than on `click`, so a press that drifts a few pixels — the
  normal shape of a fingertip — is not cancelled as a drag, and a touch or pen
  press lands too. The tap is mapped to the device pixel it fell in (floored, not
  rounded to the nearest center, so nothing is biased by half a pixel).
  Tapping the picture marks the exact spot at once and sends the tap; the mark
  appears immediately because the device's own reply only arrives with a later
  frame. Taps are queued rather than dropped, so a double tap or a fast second
  tap is delivered in order instead of vanishing while the first one is still in
  flight, and the buttons stay usable meanwhile.
- **Screenshot** — saves the current frame at the device's own resolution and
  offers a link to download it.
- **Record** — captures frames for the length picked beside the button (5, 10, 20,
  or 30 seconds) and joins them into an mp4. Pressing the recording button again
  stops early. Both results are offered as a download link under the buttons.
- **Back / Home / Power**, plus a text row for typing into the focused field.
- **Interface hierarchy** — collapsible; each row carries a button that taps that
  control's own center, so a control without a label is still reachable.
- **Crash log** — the last crash lines, with a filter toggle.

The panel talks to the Host half over `/hdc/*` on the page's own origin. Nothing
leaves the machine, and the browser never calls `hdc` directly.

Every panel action is the same operation an `hdc_*` tool performs; the tools stay
available and are the way to do anything the panel does not show.

## Requirements

- The HarmonyOS `hdc` client. DevEco Studio ships one at
  `sdk/default/openharmony/toolchains/hdc`; the HarmonyOS command-line tools work
  too.
- A connected device with USB debugging enabled, or a running emulator.
- For `hdc_screenshot` only: a model that declares image input, the same
  requirement `read_image` has.

### How the client is located

The search runs on every call, so installing an SDK or fixing an environment
variable takes effect without restarting the Host. In order:

1. `hdcPath` from the plugin configuration, when set and the file exists.
2. The SDK root named by `DEVECO_SDK_HOME`, `HOS_SDK_HOME`,
   `HARMONYOS_SDK_HOME`, `OHOS_SDK_HOME`, `OHOS_BASE_SDK_HOME`, or
   `HOS_SDK_PATH`, or the install root named by `DEVECO_HOME`,
   `DEVECO_STUDIO_HOME`, `TOOL_HOME`, or `HOS_TOOLCHAIN_HOME`. A value may point
   at the SDK directory or at the directory holding it; both are tried.
3. The conventional install locations for the platform, including
   `/Applications/DevEco-Studio.app/Contents/sdk` on macOS.
4. SDK roots implied by `PATH`, which cover a DevEco Studio or command-line-tools
   checkout installed anywhere else.
5. The login shell's exported variables. A packaged desktop app does not inherit
   a terminal's environment, so a `DEVECO_SDK_HOME` that works in a shell can be
   absent from the Host; the plugin reads it back, caching the answer for five
   minutes.
6. `PATH` itself, last, because a stray or stale `hdc` there is a common cause of
   "device not found" when DevEco itself connects fine.

If the client really is somewhere none of those reach, set `hdcPath` to its
absolute path.

## Tools

| Tool | What it does |
|---|---|
| `hdc_devices` | List attached connect keys. Every other tool takes one as `device`. |
| `hdc_screenshot` | Capture the screen and return the image itself. `save_path` also keeps a PNG. |
| `hdc_input` | `click`, `doubleClick`, `longClick`, `swipe`, `drag`, `fling`, `text`, `key` via `uitest uiInput`. |
| `hdc_ui_tree` | `uitest dumpLayout`, reported as type, text, bounds, and the center point to tap. |
| `hdc_app` | `install`, `uninstall`, `start`, `stop`, `current`, `list`. |
| `hdc_log` | `hilog -z`, filtered by keyword or by crash markers. |
| `hdc_file` | `file send`, `file recv`, or an arbitrary device `shell` command. |
| `hdc_record` | Capture frames for a bounded length and join them into a local `.mp4`. |

Each tool finds the client and the device on its own, so no setup call is
needed. With several devices attached, pass `device`; with exactly one, omit it.

## Configuration

| Key | Meaning |
|---|---|
| `hdcPath` | Absolute path of the `hdc` executable. Omit to use the default search. |
| `downloadDir` | Directory for received files, panel screenshots, and recordings. Defaults to the session directory. |
| `ffmpegPath` | Absolute path of `ffmpeg`, used to join a recording into an mp4. Omit to use the default search. |

All settings are optional strings. A value of another type is rejected when the
plugin loads, naming the field, rather than failing partway through a device call.

## Behavior worth knowing

- **Calls act on a real device immediately.** A tap, an install, or a stop is a
  real change, not a preview.
- **Screenshots are pixels, not controls.** Coordinates for `hdc_input` are
  device pixels measured on the screenshot. When a control is hard to hit, use
  `hdc_ui_tree` to read its exact bounds.
- **A missing device is reported, not guessed.** With no device attached, calls
  fail with a message naming the problem; with several, they name the choices. A
  `device` key that only prefixes several attachments is reported as ambiguous
  rather than absent, so lengthening the key is the obvious next step.
- **The hierarchy keeps unlabeled controls.** `hdc_ui_tree` shows labeled nodes
  and every clickable node, so an icon button with no text, id, or description
  still appears with the point to tap. Pass `all_nodes` to include the plain
  containers as well.
- **A tap costs one device round trip, not two.** Every device call has to resolve
  which device it targets, and that resolution is a `hdc list targets` spawn. On
  the panel's click path that would double the work behind every tap, so the
  listing is reused for about a second. Only a non-empty answer is kept — an
  empty one would hide a device plugged in a moment later — and the explicit
  listings (`hdc_devices`, the panel's refresh button) always ask the device, so
  "what is attached right now" is never a cached guess.
- **Screenshot capture tries two commands.** `snapshot_display` is preferred and
  `uitest screenCap` is the fallback, because which exists varies by version.
  Each is named with the suffix it accepts: `snapshot_display` refuses anything
  but `.jpeg`, while `uitest screenCap` ignores the suffix and writes PNG. The
  media type is sniffed from the bytes, never taken from the file name.
- **The picture is never larger than its stage.** The image is a direct child of
  the stage and keeps the aspect ratio it was captured at, so `max-height: 100%`
  means what it says. A wrapper or a minimum size would let it overflow, which
  clips the picture *and* skews every tap: the click→device-pixel math divides by
  the image's own box, so a box taller than what is drawn sends taps hundreds of
  pixels away from where they were aimed.
- **One connection carries a whole stream.** The live picture and a recording each
  run one `hdc shell` loop that prints `FRAME <bytes>` and then the frame itself.
  The Host splits on that declared length because an image contains newline bytes
  and no delimiter could end a frame. A frame cut short at the end of a stream is
  dropped rather than shown, so an interrupted read never paints as a broken
  picture.
- **A recording outlives a missing ffmpeg.** Without ffmpeg the frames are kept
  under a `-frames` directory next to the requested path, still numbered, so the
  recording is not lost — any video tool can encode it later.
- **The picture is MJPEG in a plain `<img>`.** The live picture uses
  `multipart/x-mixed-replace`, which lets the browser repaint the element as each
  part arrives — no canvas, no decoder, no polling. Capture and recording results
  are served by an opaque id from an in-memory registry, so the panel can offer a
  download link without exposing an arbitrary local path over HTTP.
- **Remote scratch files are cleaned up.** Temporary files under
  `/data/local/tmp` are removed on every exit path, including a failed capture,
  and the removal is awaited before the call returns.
- **Logs are bounded by `hilog -z`.** `-z N` reads the last N lines and exits.
  It cannot be combined with `-x`: hilog rejects that pair with
  `Mutlti commands can't be used in combination [CODE: -31]`, and `-n` is not a
  line-count flag at all.

### Why the picture runs at a few frames per second

This HarmonyOS line ships no screen recorder. On a HarmonyOS 7.0.0 phone there is
no `screenrecord` binary anywhere on the device, and `uitest` has no recording
subcommand (`uiRecord` records *operations*, not pixels). The only way to get
motion off the device is to capture stills in sequence and join them on the Host,
which is what this plugin does.

That sets the ceiling, and the number is worth knowing exactly. One
`snapshot_display` frame takes **0.4–0.7 s**, and the cost is the RenderService
round trip, not the pixels: a frame 480 px wide and one at the full 1216×2688
take almost the same time. Capturing smaller therefore buys no speed, only blur,
so the picture captures at the device's own resolution.

What does help is overlapping captures, because each is a separate process
waiting on the same service. The live picture keeps four captures in flight and
emits them in order, which on that phone turns 1.5 frames per second into about
**4–6**, depending on the link. A recording stays strictly sequential, because
its frames must land in the order they were taken.

The rate is measured, not assumed: a recording is played back at the rate its
frames actually arrived, so it lasts about as long as the time it recorded. It
moves in steps rather than smoothly, and that is a property of the device rather
than a setting this plugin can raise.

## Limits

- A recording downloads a video; it cannot be viewed in the conversation.
- Motion is a few frames per second, for the reason above.
- The control tree reflects the accessibility tree, so a drawn-only element
  without a semantic node will not appear in it.
- Exercised on a HarmonyOS device (`hdc` 3.2.0f, HarmonyOS 7.0.0) for device
  listing, screenshot, touch input, hierarchy dump, foreground mission listing,
  log reading, the live stream, and recording to a real H.264 mp4. Package
  install and uninstall and file transfer are covered only by the fake client,
  not yet by a physical device.

## Install

Install this directory through **Plugins** > **Add plugin**, or with
`plugin_manager` `install_bundle` and this path as the target. Replacing an
already-installed copy needs a restart to load the new module generation.

## Development

```sh
npm test          # 111 offline tests: tools, routes, framing, the panel, and a fake hdc
npm run test:schema   # tool and config schemas, checked with the installed harness
```

`npm run test:schema` needs the running DSH installation: the harness package is
inside `app.asar`, so the script runs under Electron's Node runtime with the
`DSH_NODE_EXECUTABLE` and `DSH_INSTALL_DIR` variables the session provides.
