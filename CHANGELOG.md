## Version 1.2.0

* Change the language from JavaScript to TypeScript.
* Deleted some legacy code.
  * Type of data.proveType is changed from number to a descriptive string.
  * data.uuid is no longer available. Please use data.address instead.

## Version 1.1.0

* Support IBS-TH1 Plus.


## Version 1.0.5

* Since noble package is not maintained well, now this package depends on @abandonware/noble. Installation became easier.
* The behavior of the system became stable.
* The object passed to callback function became an instance of IBS_TH1.RealtimeData.
* Deprecate IBS_TH1.RealtimeData.uuid field because that field is not stable enough. When we change bettery of IBS_TH1 device it changes. Users should use IBS_TH1.RealtimeData.address field that is stable over time.
* Reduce connections to IBS_TH1 devices to save their battery.
