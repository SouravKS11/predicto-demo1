#!/bin/bash
# Runs inside the Android emulator job.
set -x
adb wait-for-device
adb shell settings put global window_animation_scale 0
adb shell settings put global transition_animation_scale 0
adb shell settings put global animator_duration_scale 0
for f in audit-apks/*.apk; do adb install -r -g "$f"; done
adb shell pm list packages | grep digitalcode13
# put the emulator inside the test market (Port of Spain, Trinidad)
timeout 20 adb emu geo fix -61.5089 10.6596
sleep 2
rm -rf audit; mkdir -p audit
# fetch the live site so the report records which version was tested
curl -s -m 20 https://dc13-delivery-demo.netlify.app/ -o audit/live-index.html || true
timeout 1500 node e2e/e2e.js 2>&1 | tee audit/run-log.txt
timeout 30 adb logcat -d -s AndroidRuntime:E ActivityManager:W > audit/logcat-errors.txt || true
exit 0
