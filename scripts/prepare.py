#!/usr/bin/env python3
"""
Prepares the Android project for the four DC13 apps from the finished web builds.

    python3 scripts/prepare.py            (run from apps/mobile, after the web apps are built)

Each app is a product flavor of one Android project:
    customer  <- apps/web/dist/shop        com.digitalcode13.delivery.customer
    courier   <- apps/web/dist/courier     com.digitalcode13.delivery.courier
    store     <- apps/web/dist/partner     com.digitalcode13.delivery.store
    admin     <- apps/superadmin/dist      com.digitalcode13.delivery.admin

For a white-label client, change BRAND below (names, package prefix, colours) and run again.
"""
import json, os, re, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
MOBILE = os.path.dirname(HERE)
APPS = os.path.dirname(MOBILE)
ANDROID = os.path.join(MOBILE, "android", "app")

BRAND = {
    "prefix": "com.digitalcode13.delivery",
    "version_code": 3,
    "version_name": "2.1",
}
# payment pages that open inside the customer app (the customer comes straight back into the app)
PAYMENT_HOSTS = ["checkout.stripe.com", "*.stripe.com", "*.paypal.com", "*.mercadopago.com", "*.mercadopago.com.mx", "*.mercadolibre.com",
                 "pay.conekta.com", "*.conekta.com", "*.openpay.mx", "ipg.monri.com", "ipgtest.monri.com", "secure.cardcom.solutions", "*.cardcom.solutions"]

FLAVORS = {
    "customer": {"name": "DC13", "web": os.path.join(APPS, "web", "dist", "shop"), "bg": "#ff5101", "mark": "#ffffff", "dot": "#ffffff", "pay": True},
    "courier":  {"name": "DC13 Courier", "web": os.path.join(APPS, "web", "dist", "courier"), "bg": "#157347", "mark": "#ffffff", "dot": "#ffd84d"},
    "store":    {"name": "DC13 Store", "web": os.path.join(APPS, "web", "dist", "partner"), "bg": "#16120f", "mark": "#ffffff", "dot": "#ff5101"},
    "admin":    {"name": "DC13 Admin", "web": os.path.join(APPS, "superadmin", "dist"), "bg": "#2b2f8f", "mark": "#ffffff", "dot": "#9fb3ff"},
}

MARK = '<path d="M9 21.5c2 1.6 4.4 2.5 7 2.5a9 9 0 0 0 0-18" fill="none" stroke="{mark}" stroke-width="3.2" stroke-linecap="round"/><circle cx="11" cy="12.5" r="2.4" fill="{dot}"/>'
DENSITY = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}


def svg_full(f):      # legacy square icon with rounded corners
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="{f["bg"]}"/>{MARK.format(**f)}</svg>'

def svg_round(f):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="{f["bg"]}"/>{MARK.format(**f)}</svg>'

def svg_fg(f):        # adaptive foreground: mark inside the 66% safe zone of a 108dp canvas
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="-7 -7 46 46">{MARK.format(**f)}</svg>'

def svg_splash(f):
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">{MARK.format(**f)}</svg>'


def render(jobs):
    """jobs: list of (svg, size, out_path). Rendered with the pre-installed Chromium (Playwright)."""
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        for svg, size, out in jobs:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            pg.set_viewport_size({"width": size, "height": size})
            pg.set_content(f'<html><body style="margin:0;background:transparent">{svg.replace("<svg ", f"<svg width=\"{size}\" height=\"{size}\" ", 1)}</body></html>')
            pg.screenshot(path=out, omit_background=True, clip={"x": 0, "y": 0, "width": size, "height": size})
        b.close()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)


def main():
    for k, f in FLAVORS.items():
        if not os.path.isfile(os.path.join(f["web"], "index.html")):
            sys.exit(f"Build the web app for {k} first: {f['web']} has no index.html")

    # ---- shared (main) sources: the web files and config live in each flavor instead ----
    main_assets = os.path.join(ANDROID, "src", "main", "assets")
    shutil.rmtree(os.path.join(main_assets, "public"), ignore_errors=True)
    if os.path.exists(os.path.join(main_assets, "capacitor.config.json")):
        os.remove(os.path.join(main_assets, "capacitor.config.json"))
    res = os.path.join(ANDROID, "src", "main", "res")
    for d in os.listdir(res):            # the template's Capacitor splash images
        if d.startswith("drawable") and os.path.exists(os.path.join(res, d, "splash.png")):
            os.remove(os.path.join(res, d, "splash.png"))
            if d != "drawable" and not os.listdir(os.path.join(res, d)):
                os.rmdir(os.path.join(res, d))
    write(os.path.join(res, "drawable", "splash.xml"),
          '<?xml version="1.0" encoding="utf-8"?>\n<layer-list xmlns:android="http://schemas.android.com/apk/res/android">\n'
          '  <item android:drawable="@color/splash_bg"/>\n  <item android:width="120dp" android:height="120dp" android:gravity="center" android:drawable="@drawable/splash_logo"/>\n</layer-list>\n')
    write(os.path.join(res, "values", "colors.xml"),
          '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="splash_bg">#FFFFFF</color>\n'
          '  <color name="colorPrimary">#FF5101</color>\n  <color name="colorPrimaryDark">#C73B00</color>\n  <color name="colorAccent">#FF5101</color>\n</resources>\n')
    styles = os.path.join(res, "values", "styles.xml")
    s = open(styles).read()
    if "windowSplashScreenBackground" not in s:
        s = s.replace('<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        <item name="android:background">@drawable/splash</item>',
                      '<style name="AppTheme.NoActionBarLaunch" parent="Theme.SplashScreen">\n        <item name="android:background">@drawable/splash</item>\n'
                      '        <item name="windowSplashScreenBackground">@color/splash_bg</item>\n        <item name="postSplashScreenTheme">@style/AppTheme.NoActionBar</item>')
        write(styles, s)
    strings = os.path.join(res, "values", "strings.xml")
    st = open(strings).read()
    if "capacitor_background_geolocation_notification_channel_name" not in st:
        st = st.replace("</resources>", '    <string name="capacitor_background_geolocation_notification_channel_name">Location while online</string>\n</resources>')
        write(strings, st)

    manifest = os.path.join(ANDROID, "src", "main", "AndroidManifest.xml")
    m = open(manifest).read()
    for perm in ["ACCESS_COARSE_LOCATION", "ACCESS_FINE_LOCATION", "CAMERA", "WAKE_LOCK", "VIBRATE", "POST_NOTIFICATIONS"]:
        line = f'    <uses-permission android:name="android.permission.{perm}" />'
        if line not in m:
            m = m.replace('    <uses-permission android:name="android.permission.INTERNET" />', '    <uses-permission android:name="android.permission.INTERNET" />\n' + line)
    if 'android:usesCleartextTraffic' not in m:
        m = m.replace('android:supportsRtl="true"', 'android:supportsRtl="true"\n        android:usesCleartextTraffic="false"')
    write(manifest, m)

    # ---- each flavor ----
    jobs = []
    for k, f in FLAVORS.items():
        src = os.path.join(ANDROID, "src", k)
        pub = os.path.join(src, "assets", "public")
        shutil.rmtree(pub, ignore_errors=True)
        shutil.copytree(f["web"], pub, ignore=shutil.ignore_patterns("sw.js", "manifest.webmanifest"))
        cfg = {
            "appId": f'{BRAND["prefix"]}.{k}', "appName": f["name"], "webDir": "public",
            "server": {"androidScheme": "https", "hostname": "localhost"},
            "android": {"allowMixedContent": False, "captureInput": True, "webContentsDebuggingEnabled": False},
            "plugins": {
                "SplashScreen": {"launchAutoHide": True, "launchShowDuration": 2500, "backgroundColor": f["bg"], "showSpinner": False},
                "PushNotifications": {"presentationOptions": ["badge", "sound", "alert"]},
            },
        }
        if f.get("pay"):
            cfg["server"]["allowNavigation"] = PAYMENT_HOSTS
        write(os.path.join(src, "assets", "capacitor.config.json"), json.dumps(cfg, indent=2) + "\n")
        r = os.path.join(src, "res")
        write(os.path.join(r, "values", "strings.xml"),
              f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <string name="app_name">{f["name"]}</string>\n  <string name="title_activity_main">{f["name"]}</string>\n</resources>\n')
        write(os.path.join(r, "values", "colors.xml"),
              f'<?xml version="1.0" encoding="utf-8"?>\n<resources>\n  <color name="splash_bg">{f["bg"]}</color>\n  <color name="ic_launcher_background">{f["bg"]}</color>\n</resources>\n')
        for dens, x in DENSITY.items():
            jobs.append((svg_full(f), int(48 * x), os.path.join(r, f"mipmap-{dens}", "ic_launcher.png")))
            jobs.append((svg_round(f), int(48 * x), os.path.join(r, f"mipmap-{dens}", "ic_launcher_round.png")))
            jobs.append((svg_fg(f), int(108 * x), os.path.join(r, f"mipmap-{dens}", "ic_launcher_foreground.png")))
        jobs.append((svg_splash(f), 480, os.path.join(r, "drawable", "splash_logo.png")))
        jobs.append((svg_full(f), 512, os.path.join(MOBILE, "store-listing", f"{k}-icon-512.png")))
    # the main colour resource is defined per flavor
    bg_main = os.path.join(res, "values", "ic_launcher_background.xml")
    if os.path.exists(bg_main):
        os.remove(bg_main)
    render(jobs)

    # ---- gradle: one flavor per app, test signing ----
    gradle = os.path.join(ANDROID, "build.gradle")
    g = open(gradle).read()
    # the version always follows BRAND, so a new run produces an update that installs over the old app
    g = re.sub(r'        versionCode \d+\n        versionName "[^"]*"', f'        versionCode {BRAND["version_code"]}\n        versionName "{BRAND["version_name"]}"', g)
    if "productFlavors" not in g:
        flavors = "\n".join(f'        {k} {{ dimension "app"; applicationId "{BRAND["prefix"]}.{k}" }}' for k in FLAVORS)
        g = g.replace("    buildTypes {", f'''    signingConfigs {{
        // Test key for internal APKs only. Play Store releases are signed with the client's own upload key.
        test {{
            storeFile file("dc13-test.keystore")
            storePassword "dc13test"
            keyAlias "dc13"
            keyPassword "dc13test"
        }}
    }}
    flavorDimensions = ["app"]
    productFlavors {{
{flavors}
    }}
    buildTypes {{''', 1)
        g = g.replace("            minifyEnabled false\n", "            minifyEnabled false\n            signingConfig signingConfigs.test\n", 1)
        g = g.replace('''try {
    def servicesJSON = file('google-services.json')
    if (servicesJSON.text) {
        apply plugin: 'com.google.gms.google-services'
    }
} catch(Exception e) {
    logger.info("google-services.json not found, google-services plugin not applied. Push Notifications won't work")
}''', '''// Firebase (push when the app is closed): add google-services.json to app/ or app/src/<flavor>/
def servicesFiles = [file('google-services.json')] + ["customer", "courier", "store", "admin"].collect { file("src/${it}/google-services.json") }
if (servicesFiles.any { it.exists() }) {
    apply plugin: 'com.google.gms.google-services'
} else {
    logger.info("google-services.json not found, google-services plugin not applied. Push Notifications won't work")
}''')
    write(gradle, g)
    print("prepared:", ", ".join(f'{k} ({FLAVORS[k]["name"]})' for k in FLAVORS))


if __name__ == "__main__":
    main()
