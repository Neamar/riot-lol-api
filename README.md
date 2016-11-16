# RiotRequester

This module lets you query the Riot API for LeagueOfLegends data.

You'll need a developer key from https://developer.riotgames.com.

This module was developed for people that need to poll the Riot API with a *very high* throughput (with peaks above the standard production rate limit of 300 calls / second / region).

If you don't need this kind of performance, you'll probably be better with other modules -- have a look at [lol-js](https://www.npmjs.com/package/lol-js) for instance :)

## Installation
```
npm install --save riot-lol-api
```

## Usage
```
var RiotRequest = require('riot-lol-api');
var rateLimits = null; // Don't pass anything to use development rate limits, otherwise pass an array with both your rate-limits value, e.g. [3000, 180000] for a standard production key.

var riotRequest = new RiotRequest('my_api_key', rateLimits);

riotRequest.request('euw', ''/api/lol/EUW1/v1.4/summoner/by-name/graphistos', function(err, data) {});
```

The library will take care of rate limiting and automatically retry on 500 and 503.

It will also maintain a very high request concurrency, while still ensuring that you always get at most one "429 Rate Limited" response.

Ensure that your network adapter can deal with the traffic!

## Caching
The third argument in the constructor let you define a cache object. This object should expose two keys, `get` and `set`. The default implementation does no caching:

```js
var cache = {
  get: function(region, endpoint, cacheStrategy, cb) {
    // Try to read from cache,
    // Return cb(null, data) if data is already available in your cache.
    // If it's a cache-miss, you still need to call cb(null, null) for the request to proceed.
    // Note this function might be called more than once per endpoint (if the time spent in queue is too long)
    cb(null, null);
  },
  set: function(region, endpoint, cacheStrategy, data) {
    // Use this function to store `data`, which is the result of the API call to `endpoint` on `region`.
  }
};
```
