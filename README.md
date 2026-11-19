# dsh-plugin-hdc

HarmonyOS device tools for DeepSeek Harness, over `hdc`.

The plugin registers a family of `hdc_*` tools, so a HarmonyOS device can be
driven from the conversation: see the screen, tap, read the control tree, install
an app, read logs, move files, and record the screen.

## Requirements

- The HarmonyOS `hdc` client. DevEco Studio ships one at
  `sdk/default/openharmony/toolchains/hdc`; the HarmonyOS command-line tools work
  too. The plugin searches those locations first, then `PATH`.
- A connected device with USB debugging enabled, or a running emulator.
- For `hdc_screenshot` only: a model that declares image input, the same
  requirement `read_image` has.

If `hdc` lives somewhere unusual, set `hdcPath` in the plugin configuration to
its absolute path.

## Tools

| Tool | What it does |
|---|---|
| `hdc_devices` | List attached connect keys. Every other tool takes one as `device`. |
| `hdc_screenshot` | Capture the screen and return the image itself. `save_path` also keeps a PNG. |
| `hdc_input` | `click`, `doubleClick`, `longClick`, `swipe`, `drag`, `fling`, `text`, `key` via `uitest uiInput`. |
| `hdc_ui_tree` | `uitest dumpLayout`, reported as type, text, bounds, and the center point to tap. |
| `hdc_app` | `install`, `uninstall`, `start`, `stop`, `current`, `list`. |
| `hdc_log` | `hilog -x`, filtered by keyword or by crash markers. |
| `hdc_file` | `file send`, `file recv`, or an arbitrary device `shell` command. |
| `hdc_record` | `screenrecord` into a local `.mp4` of bounded length. |

Each tool finds the client and the device on its own, so no setup call is
needed. With several devices attached, pass `device`; with exactly one, omit it.

## Configuration

| Key | Meaning |
|---|---|
| `hdcPath` | Absolute path of the `hdc` executable. Omit to use the default search. |
| `downloadDir` | Directory for received files. Defaults to the session directory. |

Both settings are optional strings. A value of another type is rejected when the
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
- **Screenshot capture tries two commands.** `snapshot_display` is preferred and
  `uitest screenCap` is the fallback, because which exists varies by version.
- **Remote scratch files are cleaned up.** Temporary files under
  `/data/local/tmp` are removed on every exit path, including a failed capture,
  and the removal is awaited before the call returns.
- **Logs are bounded by `hilog -z`.** `-z N` reads the last N lines and exits.
  It cannot be combined with `-x`: hilog rejects that pair with
  `Mutlti commands can't be used in combination [CODE: -31]`, and `-n` is not a
  line-count flag at all.

## Limits

- Screen recording downloads a video; it cannot be viewed in the conversation.
- The control tree reflects the accessibility tree, so a drawn-only element
  without a semantic node will not appear in it.
- Exercised on a HarmonyOS device (`hdc` 3.2.0f) for device listing, screenshot,
  touch input, hierarchy dump, foreground mission listing, and log reading.
  Package install and uninstall, file transfer, and screen recording are covered
  only by the fake client, not yet by a physical device.

## Install

Install this directory through **Plugins** > **Add plugin**, or with
`plugin_manager` `install_bundle` and this path as the target. Replacing an
already-installed copy needs a restart to load the new module generation.

## Development

```sh
npm test          # 36 offline tests against a fake hdc
npm run test:schema   # tool and config schemas, checked with the installed harness
```

`npm run test:schema` needs the running DSH installation: the harness package is
inside `app.asar`, so the script runs under Electron's Node runtime with the
`DSH_NODE_EXECUTABLE` and `DSH_INSTALL_DIR` variables the session provides.
