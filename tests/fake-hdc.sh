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
      *snapshot_display*)
        printf 'snapshot ok\n'
        exit 0
        ;;
      *screenCap*)
        printf 'screenCap ok\n'
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
        printf '11-19 19:00:00.000  1234  1234 I A00000/App: started ok\n'
        printf '11-19 19:00:01.000  1234  1234 E A00000/App: CppCrash happened here\n'
        printf '11-19 19:00:02.000  1234  1234 I A00000/App: still fine\n'
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
