#!/bin/sh
# install.sh: copy the mod and its core into Herdr (mods/omniloop). Herdr hot-reloads it.
# Pass HERDR_APP_HOME explicitly: a test window's home, or ~/.config/herdr-app for the real one.
set -e
cd "$(dirname "$0")/.."
[ -n "$HERDR_APP_HOME" ] || { echo "set HERDR_APP_HOME (e.g. ~/.config/herdr-app)"; exit 1; }
DEST="$HERDR_APP_HOME/mods/omniloop"
mkdir -p "$DEST/core"
cp mod/main.js mod/mod.json "$DEST/"
mkdir -p "$DEST/help" && cp help/*.js "$DEST/help/"   # herdr-help, copied in by ~/repos/herdr-help/sync.sh
cp core/*.js "$DEST/core/"
printf 'export const BIN = %s;\n' "\"$(pwd)/bin\"" > "$DEST/config.js"
echo "installed to $DEST"
herdr-app check "$DEST"
# The loop tab bar: a copy of Herdr's tab bar that lists a loop's sessions. A layout uses it by naming
# "loop-tabs" in place of "tabs" in its tab bar block.
TABS="$HERDR_APP_HOME/mods/loop-tabs"
mkdir -p "$TABS/core"
cp mod-tabs/main.js mod-tabs/mod.json "$TABS/"
cp core/*.js "$TABS/core/"
echo "installed to $TABS"
herdr-app check "$TABS"
# The full-page picker (keys.json: "mod.open:omniloop-picker"). config.js tells it where the omniloop command is.
PICK="$HERDR_APP_HOME/mods/omniloop-picker"
mkdir -p "$PICK/core"
cp mod-picker/main.js mod-picker/mod.json "$PICK/"
mkdir -p "$PICK/help" && cp help/*.js "$PICK/help/"
cp core/*.js "$PICK/core/"
printf 'export const BIN = %s;\n' "\"$(pwd)/bin\"" > "$PICK/config.js"
echo "installed to $PICK"
herdr-app check "$PICK"
# The pane header mod (layouts name "loop-pane"), and the optional loop-status mod (installed, but the loops layout does not use it).
for m in pane status; do
  D="$HERDR_APP_HOME/mods/loop-$m"
  mkdir -p "$D/core"
  cp "mod-$m/main.js" "mod-$m/mod.json" "$D/"
  cp core/*.js "$D/core/"
  echo "installed to $D"
  herdr-app check "$D"
done
# The docked Omniloop panel (layouts dock it as a block {"content": {"mod": "omniloop-panel", "props": {"dock": true}}}).
PANEL="$HERDR_APP_HOME/mods/omniloop-panel"
mkdir -p "$PANEL/core"
cp mod-panel/main.js mod-panel/mod.json "$PANEL/"
mkdir -p "$PANEL/help" && cp help/*.js "$PANEL/help/"   # the ? controls (herdr-help)
cp core/*.js "$PANEL/core/"
printf 'export const BIN = %s;\n' "\"$(pwd)/bin\"" > "$PANEL/config.js"
echo "installed to $PANEL"
herdr-app check "$PANEL"
