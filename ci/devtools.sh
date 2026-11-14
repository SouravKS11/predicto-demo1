#!/usr/bin/env bash
set -u
mkdir -p shots
# Second pass: debug builds (same web code, WebView debuggable) driven over DevTools:
# native bridge and plugins, customer browse -> store -> basket -> checkout, Android back button.
for app in customer courier store admin; do
  pkg="com.digitalcode13.delivery.$app"
  adb uninstall "$pkg" > /dev/null 2>&1
  adb install -r -g "apks-test/$app.apk" > "shots/$app-test-install.txt" 2>&1
  adb shell am start -W -n "$pkg/com.digitalcode13.delivery.MainActivity" > /dev/null 2>&1
  sleep 20
  timeout 150 node ci/cdp.mjs "$app" "$pkg" > "shots/$app-cdp.json" 2> "shots/$app-cdp-err.txt"
  adb exec-out screencap -p > "shots/$app-cdp.png"
  if [ "$app" = "customer" ]; then
    adb shell input keyevent 4; sleep 2; adb shell input keyevent 4; sleep 2; adb shell input keyevent 4; sleep 3
    adb shell dumpsys activity activities | grep -m1 -i "mResumedActivity\|topResumedActivity" > "shots/customer-after-back.txt" 2>&1
  fi
  adb shell am force-stop "$pkg"
done
