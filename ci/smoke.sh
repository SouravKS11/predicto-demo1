#!/usr/bin/env bash
# Installs each APK on the emulator, opens it and saves screenshots and logs.
mkdir -p shots
T() { timeout 40 "$@"; }
adb wait-for-device
for app in courier customer store admin; do
  cap="$(echo ${app:0:1} | tr a-z A-Z)${app:1}"
  apk="apks/DC13-$cap.apk"
  pkg="com.digitalcode13.delivery.$app"
  echo "== $app" >> shots/progress.txt
  T adb install -r -g "$apk" > "shots/$app-install.txt" 2>&1
  T adb logcat -c
  T adb shell am start -W -n "$pkg/com.digitalcode13.delivery.MainActivity" > "shots/$app-start.txt" 2>&1
  sleep 8
  T adb exec-out screencap -p > "shots/$app-early.png"
  sleep 17
  T adb exec-out screencap -p > "shots/$app.png"
  T adb logcat -d > "shots/$app-logcat.txt" 2>&1
  (T adb shell pidof "$pkg" || echo "not running") > "shots/$app-alive.txt" 2>&1
  T adb shell am force-stop "$pkg"
  echo "   done" >> shots/progress.txt
done

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
