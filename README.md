# DC13 Delivery OS: Android apps

Four Android apps built with Capacitor from the DC13 web portals. Every push builds signed test APKs,
opens each one on an Android emulator and saves the APKs (`apks/`) and screenshots (`shots/`) to this branch.

| App | Package | Content |
|---|---|---|
| DC13 (customer) | com.digitalcode13.delivery.customer | customer shop |
| DC13 Courier | com.digitalcode13.delivery.courier | courier app |
| DC13 Store | com.digitalcode13.delivery.store | store dashboard (owner, manager, staff by login) |
| DC13 Admin | com.digitalcode13.delivery.admin | super admin console |

The APKs are signed with a test key (`android/app/dc13-test.keystore`) for internal installs only.
Play Store releases are signed with the client's own upload key.
