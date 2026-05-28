## Version 2.0.3

* Remove legacy identity naming from public types, documentation, and tests.
* Log when the scanner connects to a device to resolve its stable device id.
* Change stable device-id retry backoff to 2x intervals capped at one hour.

## Version 2.0.0

* Add a testable `parseRealtimeData` parser entry point.
* Rename the primary scanner API to `IbsTh1Scanner` with `subscribe()` returning
  a `Subscription`, and keep `IBS_TH1` only as a deprecated constructor alias.
* Rename realtime fields to explicit units: `temperatureCelsius`,
  `humidityPercent`, and `batteryPercent`; probe types are now lowercase.
* Add `crc16(buffer)` as the public CRC helper.
* Keep scanner device-id cache persistence while making corrupt cache files
  safer.
* Avoid removing other Noble listeners when unsubscribing.
* Move `@abandonware/noble` to an optional peer dependency so parser users do
  not install the native BLE stack.
* Require Node.js 18 or newer for the modernized toolchain and package shape.
* Split hardware-dependent scanning samples from automated tests and expand
  unit coverage for parser, scanner lifecycle, device-id caching, and
  packaging.

## Version 1.2.0

* Change the language from JavaScript to TypeScript.
* Deleted some legacy code.
  * Type of data.proveType is changed from number to a descriptive string.
  * The unstable UUID-based callback field is no longer available.

## Version 1.1.0

* Support IBS-TH1 Plus.


## Version 1.0.5

* Since noble package is not maintained well, now this package depends on @abandonware/noble. Installation became easier.
* The behavior of the system became stable.
* The object passed to callback function became an instance of IBS_TH1.RealtimeData.
* Deprecate the unstable UUID-based identity field in IBS_TH1.RealtimeData.
* Reduce connections to IBS_TH1 devices to save their battery.
