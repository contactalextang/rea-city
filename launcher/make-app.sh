#!/bin/bash
# 用法：launcher/make-app.sh <图标PNG(建议1024x1024)> [输出目录，默认 ~/Desktop]
# 生成 "REA City.app"：双击即构建/启动本地服务器并用 Chrome 独立窗口打开游戏。
set -euo pipefail
ICON_PNG="${1:?需要图标 PNG 路径}"
OUT_DIR="${2:-$HOME/Desktop}"
PROJECT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$OUT_DIR/REA City.app"
WORK="$(mktemp -d)"

# 1) PNG → icns
ICONSET="$WORK/icon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  d=$((s*2)); sips -z $d $d "$ICON_PNG" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$WORK/icon.icns"

# 2) 组装 .app
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cp "$WORK/icon.icns" "$APP/Contents/Resources/icon.icns"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>REA City</string>
  <key>CFBundleDisplayName</key><string>REA City</string>
  <key>CFBundleIdentifier</key><string>dev.alextang.reacity</string>
  <key>CFBundleVersion</key><string>1.0</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>LSUIElement</key><true/>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
</dict></plist>
PLIST
cat > "$APP/Contents/MacOS/launch" <<LAUNCH
#!/bin/bash
# REA City 启动器：确保本地服务器在跑，然后用 Chrome 独立窗口打开
PROJECT="$PROJECT"
PORT=4173
URL="http://127.0.0.1:\$PORT/"
export PATH="\$HOME/.local/node22/bin:\$HOME/.local/node20/bin:/opt/homebrew/bin:/usr/local/bin:\$PATH"
cd "\$PROJECT" || { osascript -e 'display alert "REA City" message "找不到项目目录：'"\$PROJECT"'"'; exit 1; }
# 源码比上次构建新（或还没构建）→ 重新构建；preview 直接读 dist/，服务已在跑时也要检查，否则一直是旧版
if [ ! -f dist/index.html ] || [ -n "\$(find src index.html dev public vite.config.ts -newer dist/index.html 2>/dev/null | head -1)" ]; then
  npx vite build >/tmp/rea-build.log 2>&1 || { osascript -e 'display alert "REA City" message "构建失败，详见 /tmp/rea-build.log"'; exit 1; }
fi
if ! curl -s -o /dev/null "\$URL"; then
  nohup npx vite preview --port \$PORT --strictPort --host 127.0.0.1 >/tmp/rea-preview.log 2>&1 &
  for i in \$(seq 1 60); do curl -s -o /dev/null "\$URL" && break; sleep 0.25; done
fi
if [ -d "/Applications/Google Chrome.app" ]; then
  # Chrome 应用模式：无标签栏/地址栏的独立窗口
  open -na "Google Chrome" --args --app="\$URL" --window-size=1600,1000 --window-position=80,60
else
  open "\$URL"
fi
LAUNCH
chmod +x "$APP/Contents/MacOS/launch"
touch "$APP"   # 让 Finder 刷新图标缓存
rm -rf "$WORK"
echo "已生成：$APP"
