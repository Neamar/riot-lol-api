# Riot Lol API

This module lets you query the Riot API for LeagueOfLegends data.

You'll need a developer key from https://developer.riotgames.com.

This module was developed for people that need to poll the Riot API with a *very high* throughput (with peaks above the standard production rate limit of 300 calls / second / region).

If you don't need this kind of performance, you'll probably be better with other modules -- have a look at [lol-js](https://www.npmjs.com/package/lol-js) for instance :)

## Installation
```
npm install --save riot-lol-api
```

## Usage
```js
var RiotRequest = require('riot-lol-api');
var rateLimits = null; // Don't pass anything to use development rate limits, otherwise pass an array with both your rate-limits value, e.g. [3000, 180000] for a standard production key.

var riotRequest = new RiotRequest('my_api_key', rateLimits);

riotRequest.request('euw', '/api/lol/euw/v1.4/summoner/by-name/graphistos', function(err, data) {});
```

The library will take care of rate limiting and automatically retry on 500 and 503.

It will also maintain a very high request concurrency, dynamically updating concurrency to ensure you remain a good citizen and don't get blacklisted.

Ensure that your network adapter can deal with the traffic!
If necessary, you can distribute the library across multiple servers -- I'm currently using it with a production key distributed on 4 servers sending > 35 millions calls a day.

## Caching
The third argument in the constructor lets you define a cache object. This object should expose two keys, `get` and `set`. The default implementation does no caching:

```js
var cache = {
  get: function(region, endpoint, cb) {
    // Try to read from cache,
    // Return cb(null, data) if data is already available in your cache.
    // If it's a cache-miss, you still need to call cb(null, null) for the request to proceed.
    // Do not just call cb(null)!
    cb(null, null);
  },
  set: function(region, endpoint, cacheStrategy, data) {
    // Use this function to store `data`, which is the result of the API call to `endpoint` on `region`.
  }
};
```

`cacheStrategy` is a value over which you have total control when you call `.request()`:


```js
riotRequest.request('euw', '/api/lol/EUW1/v1.4/summoner/by-name/graphistos', YOUR_CACHE_STRATEGY, function(err, data) {});
```

When unspecified, cacheStrategy will default to `false`, and your cache won't be used.
If the value is not falsy, the cache will be used and the value will be forwarded to you. The most common use case would be to send how long you want to store the data in cache, but this is completely up to you.

You may want to use a package like `lru-cache` to help you with caching -- note that you can plug any system you want (Redis, Riak, file system), just ensure you call `cb(null, data)`. If you send an error in the first argument, the library will forward this error directly to the callback specified in `.request()`.

You'll notice that the `set()` function has no callback, this is intentional. You can start async operations from here, but the system won't wait for your operation to complete before moving on to other requests.

In some situations, the `get()` function might be called more than once per endpoint. For performance, when a request is queued, it is checked instantly if it's in cache: if it isn't, it's added in a queue, and when the worker start that task he will ask the cache again in case the same request was already queued and has since then been cached.

## Logging
The library use `debug` for logging. To see logs, set this environment variable: `DEBUG=riot-lol-api:*`.

## Errors
Errors when trying to read the cache are forwarded directly to the requester.

HTTP errrors on the Riot API side will expose three properties:

* `.statusCode` containing the return code from the API (the most common one is 503. Note that the library is retrying by default all 5XX errors, so if you see it in your code it means that the error happened twice)
* `riotInternal` a flag set to true to help you distinguish network errors (fairly common) from more standard errors (e.g. from your cache)
* `extra`, an object exposing details about the request: endpoint, region, status code, whether the failure is due to a timeout... You may want to send this object directly to you error monitoring system.

Please remember that the library will automatically retry once when it receives a 500 and 503.

## Dealing with regions and platforms
For convenience, the library exposes a function `getPlatformFromRegion()` that takes a region as parameter (e.g "euw") and returns the associaed platform to use with the Riot API ("EUW1"). This can be useful for building URLs.

Additionally, there is also a `.REGIONS` property with an array of all valid Riot regions lowercased.
