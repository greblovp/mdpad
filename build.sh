#!/bin/zsh
# Builds MDPad.app into build/. Usage: ./build.sh [--install]
set -e
cd "$(dirname "$0")"

echo "› bundling editor"
(cd web && npm install --silent && npx esbuild src/editor.js --bundle --minify --format=iife --outfile=editor.js --log-level=warning)

APP=build/MDPad.app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources/web"

echo "› compiling"
swiftc -O -swift-version 5 -module-name MDPad -target arm64-apple-macos13.0 \
  Sources/*.swift -o "$APP/Contents/MacOS/MDPad" -framework AppKit -framework WebKit

cp Info.plist "$APP/Contents/"
cp web/index.html web/style.css web/editor.js web/node_modules/mermaid/dist/mermaid.min.js "$APP/Contents/Resources/web/"

echo "› icon"
if [ ! -f build/AppIcon.icns ]; then
  ICONSET=build/AppIcon.iconset
  mkdir -p "$ICONSET"
  swift make_icon.swift build/icon_1024.png
  for s in 16 32 128 256 512; do
    sips -z $s $s build/icon_1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
    sips -z $((s*2)) $((s*2)) build/icon_1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
  done
  iconutil -c icns "$ICONSET" -o build/AppIcon.icns
fi
cp build/AppIcon.icns "$APP/Contents/Resources/"

codesign --force --deep -s - "$APP"
echo "✓ $APP"

if [ "$1" = "--install" ]; then
  DEST=/Applications/MDPad.app
  if pgrep -x MDPad >/dev/null; then osascript -e "quit app \"MDPad\"" || true; for i in 1 2 3 4 5 6 7 8 9 10; do pgrep -x MDPad >/dev/null || break; sleep 0.5; done; fi
  rm -rf "$DEST"
  cp -R "$APP" "$DEST"
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$DEST"
  echo "✓ installed to $DEST"
fi
