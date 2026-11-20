#!/bin/sh
# A stand-in for `hdc` that answers the calls the tools make, so the whole
# pipeline (device selection, capture, file pull, image attachment) can be
# exercised without a HarmonyOS device.
#
#   DSH_HDC_FAKE_MODE=device|empty  (default: device)

set -u

mode="${DSH_HDC_FAKE_MODE:-device}"
scratch="${DSH_HDC_FAKE_DIR:-/tmp/dsh-hdc-fake}"
mkdir -p "$scratch" 2>/dev/null

# Global options arrive before the component command.
if [ "$#" -gt 0 ] && [ "$1" = "-t" ]; then
  shift 2
fi

write_png() {
  # A verified 2x2 PNG, so the attachment service accepts it as a real image.
  printf '%s' 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAEklEQVR4nGM4oaGhUXGCAUIBACIeBQHssus+AAAAAElFTkSuQmCC' | base64 -d > "$1"
}

write_frame() {
  count="${1:-3}"
  i=0
  while [ "$i" -lt "$count" ]; do
    # A banner line first, as the real device prints one around the loop; the
    # parser must drop it rather than treat it as a frame header.
    [ "$i" -eq 0 ] && printf 'Welcome to hdc shell\n'
    printf 'FRAME %s\n' "$(jpeg_bytes | wc -c | tr -d ' ')"
    jpeg_bytes
    i=$((i+1))
  done
}

jpeg_bytes() {
  printf '%s' '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5soooroMD/9k=' | base64 -d
}

# Every invocation is appended to a log when a caller asks for one, so a test can
# count how many times a path spawns the client. Without it the only observable
# is the final answer, which cannot tell one call from three.
if [ -n "${DSH_HDC_FAKE_LOG:-}" ]; then
  printf '%s %s\n' "${1:-}" "$*" >> "$DSH_HDC_FAKE_LOG"
fi

case "${1:-}" in
  list)
    if [ "$mode" = "empty" ]; then
      printf '[Empty]\n'
    else
      printf 'FakePhone123\n'
    fi
    exit 0
    ;;
  file)
    # file recv <remote> <local>  |  file send <local> <remote>  |  file recv ...
    remote="$3"
    local="$4"
    case "$remote" in
      *.png)
        write_png "$local"
        if [ -s "$local" ]; then printf 'FileTransfer finish, Size:%s\n' "$(wc -c < "$local" | tr -d ' ')"; exit 0; fi
        printf '[Fail]File transfer failed\n'
        exit 1
        ;;
      *.jpeg|*.jpg)
        jpeg_bytes > "$local"
        if [ -s "$local" ]; then printf 'FileTransfer finish, Size:%s\n' "$(wc -c < "$local" | tr -d ' ')"; exit 0; fi
        printf '[Fail]File transfer failed\n'
        exit 1
        ;;
      *.json)
        # A layout document with three node kinds the tools must tell apart: a
        # labeled control, an icon button with no text/id/description, and a
        # plain container that carries no type at all.
        printf '%s\n' '{"attributes":{"bounds":"[0,0][1260,2720]","type":"Column"},"children":[{"attributes":{"bounds":"[84,1127][1172,1295]","type":"Button","text":"Next","clickable":"true"},"children":[]},{"attributes":{"bounds":"[1100,40][1200,140]","type":"Image","clickable":"true"},"children":[]},{"attributes":{"bounds":"[0,0][1260,200]","text":""},"children":[]}]}' > "$local"
        printf 'FileTransfer finish\n'
        exit 0
        ;;
      *)
        printf 'fake remote content\n' > "$local"
        printf 'FileTransfer finish\n'
        exit 0
        ;;
    esac
    ;;
  shell)
    shift
    command="$*"
    case "$command" in
      # The frame loop is how the live picture and a recording read the screen.
      # It has to answer the real protocol — a `FRAME <bytes>` line and then
      # exactly those bytes — because the Host splits on the declared length,
      # not on a delimiter. A bare "ok" here would pass a broken parser.
      *dsh_frames*)
        write_frame "${DSH_HDC_FAKE_FRAMES:-3}"
        exit 0
        ;;
      *snapshot_display*)
        # Mirror the real client: it validates the output suffix and refuses
        # anything but `.jpeg`, printing exactly this pair of lines. A caller
        # that asks for `.png` must fail here rather than pass against a fake
        # that accepts any name.
        case "$command" in
          *.jpeg*|*.jpg*)
            printf '\nsuccess: snapshot display 0 , write to jpeg, width: 2, height: 2\n'
            exit 0
            ;;
        esac
        printf 'fileType: \nerror: fileName invalid, suffix must be .jpeg\nerror: filename invalid!\n'
        exit 1
        ;;
      *screenCap*)
        # Mirror the real client: it ignores the suffix and always writes PNG.
        printf 'ScreenCap saved\n'
        exit 0
        ;;
      uitest\ uiInput*)
        printf 'uitest ok\n'
        exit 0
        ;;
      *dumpLayout*)
        printf 'dump ok\n'
        exit 0
        ;;
      *hilog*)
        # Mirror the real client: -x and -z are mutually exclusive, and -n is
        # not a line-count flag at all. A tool that sends either must fail here
        # rather than pass against a fake that accepts anything.
        case "$command" in
          *"-x"*"-z"*|*"-z"*"-x"*)
            printf "Mutlti commands can't be used in combination [CODE: -31]\n"
            exit 1
            ;;
          *" -n "*)
            printf '[Fail]invalid argument: -n is not a line-count flag\n'
            exit 1
            ;;
        esac
        printf '11-19 19:00:00.000  1234  1234 I A00000/App: started ok\n'
        printf '11-19 19:00:01.000  1234  1234 E A00000/App: CppCrash happened here\n'
        printf '11-19 19:00:02.000  1234  1234 I A00000/App: still fine\n'
        printf '11-19 19:00:03.000   597  2492 I C02DA0/hiview/FaultLeakDetectorManager: OnForegroundChanged: cn.example.app\n'
        exit 0
        ;;
      *aa\ start*|*aa\ force-stop*|*aa\ dump*)
        printf 'aa ok\n'
        exit 0
        ;;
      *bm\ dump*)
        printf 'com.example.app\n'
        exit 0
        ;;
      *screenrecord*)
        printf 'record ok\n'
        exit 0
        ;;
      *rm\ -f*)
        exit 0
        ;;
      *)
        printf 'shell ok: %s\n' "$command"
        exit 0
        ;;
    esac
    ;;
  install)
    printf 'install bundle successfully.\n'
    exit 0
    ;;
  uninstall)
    printf 'uninstall bundle successfully.\n'
    exit 0
    ;;
  *)
    printf '[Fail]Unknown command\n'
    exit 1
    ;;
esac
