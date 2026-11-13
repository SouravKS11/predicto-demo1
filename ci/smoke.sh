#!/usr/bin/env bash
# Installs each APK on the emulator, opens it and saves a screenshot after it has loaded.
set -u
mkdir -p shots
for app in customer courier store admin; do
  apk="apks/DC13-$(echo ${app:0:1} | tr a-z A-Z)${app:1}.apk"
  pkg="com.digitalcode13.delivery.$app"
  adb install -r -g "$apk" > "shots/$app-install.txt" 2>&1
  adb logcat -c
  adb shell am start -W -n "$pkg/com.digitalcode13.delivery.MainActivity" > "shots/$app-start.txt" 2>&1
  sleep 8
  adb exec-out screencap -p > "shots/$app-early.png"
  sleep 17
  adb exec-out screencap -p > "shots/$app.png"
  adb logcat -d -s AndroidRuntime:E Capacitor:* chromium:* Console:* > "shots/$app-log.txt" 2>&1
  adb logcat -d -b crash > "shots/$app-crash.txt" 2>&1
  adb logcat -d | grep -iE "$pkg|ActivityManager|ActivityTaskManager|Capacitor|WindowManager" | tail -150 > "shots/$app-full.txt" 2>&1
  adb shell pidof "$pkg" > "shots/$app-alive.txt" 2>&1 || echo "not running" > "shots/$app-alive.txt"
  adb shell am force-stop "$pkg"
done
