# DC13 Delivery: Android test apps

Three Android apps for client testing of the DC13 Delivery test environment
(https://dc13-delivery-demo.netlify.app). Each app opens directly on its role:

| App | Package | Opens on |
|---|---|---|
| DC13 Customer | com.digitalcode13.delivery.customer | Order food (#/eat) |
| DC13 Driver | com.digitalcode13.delivery.driver | Courier app (#/drive) |
| DC13 Merchant | com.digitalcode13.delivery.merchant | Restaurant dashboard (#/partner) |

Built by GitHub Actions on every push to this branch; the signed APKs are saved in `apks/`.
The signing key in `app/` is a test-only key for these internal builds. Do not use it for a Play Store release.
