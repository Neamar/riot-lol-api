"use strict";

var async = require("async");
var supertest = require("supertest");
var rarity = require("rarity");
var log = require("debug")("riot-lol-api:request");


/**
 * Create a new object for making request to the RiotAPI.
 * Use with new RiotRequest(apiKey, [rate][, cache])
 * Ratelimits will default to a development api key (very slow)
 * Cache must be an object exposing both get() and set() methods
 */
var RiotRequest = function(apiKey, rateLimits, cache) {
  if(!apiKey) {
    throw new Error("Missing Riot API key.");
  }

  if(!rateLimits) {
    log("No rate limit specified, assuming development key.");
    rateLimits = [10, 500];
  }

  if(!rateLimits.length || rateLimits.length !== 2) {
    throw new Error("Rate-limit must be an array of length 2.");
  }

  if(!cache) {
    log("No cache specified.");
    cache = {
      get: function(region, endpoint, cacheStrategy, cb) {
        cb(null, null);
      },
      set: function(region, endpoint, cacheStrategy, data) {
        // jshint unused:false
        // Do nothing.
      }
    };
  }


  this.apiKey = apiKey;
  this.cache = cache;
  this.rateLimits = rateLimits;

  // Will contain all the queues (one per region)
  this.requestQueues = {};
};

RiotRequest.prototype.generateQueue = function generateQueue(region) {
  var self = this;
  var secondaryLog = require("debug")("riot-lol-api:request:" + region);

  var requestQueue;

  // When using production key, make call in a faster way
  var defaultConcurrency = this.rateLimits[0];
  var defaultLongConcurrency =  this.rateLimits[1];

  var resetterTimeout;
  var resetterFunction = function() {
    // Function to reset the concurrency when the queue had been idle a long time
    requestQueue.concurrency = defaultConcurrency;
    secondaryLog("Resetting concurrency to " + defaultConcurrency);
  };

  // Queue worker, loading endpoints from Riot and returning the body
  // This function also handles rate-limiting, retrying after the proper delay.
  function queueWorker(task, done) {
    secondaryLog("Loading " + task.endpoint);
    if(!task.region) {
      throw new Error("Undefined region.");
    }

    // Strategy for fetching when not in cache
    var fetcher = function getFromRiot(cb) {

      supertest("https://" + task.region + ".api.pvp.net")
        .get(task.endpoint + (task.endpoint.indexOf("?") === -1 ? "?" : "&") + "api_key=" + "config.apiKey")
        .timeout(2500)
        .expect(200)
        .end(function(err, res) {
          if(res && res.headers && res.headers['x-rate-limit-count']) {
            var rateInfo = res.headers['x-rate-limit-count'].split(',');
            rateInfo[0] = rateInfo[0].split(':');
            rateInfo[1] = rateInfo[1].split(':');

            // Concurrency is always at least 1
            // (in which case we'll get a Rate-Limited 429 with a header explaining how long we should wait)
            // and can't be higher than the defaultConcurrency minus calls already made
            // (plus a 20% padding to account for parallel requests)
            // So for a dev key, we'll do 8 requests THEN set the concurrency to 1 when approaching the limit
            var availableConcurrency = Math.max(
              1,
              Math.min(
                defaultConcurrency - rateInfo[0][0] - (0.2 * defaultConcurrency),
                defaultLongConcurrency - rateInfo[1][0]
              )
            );

            if(requestQueue.concurrency !== availableConcurrency) {
              requestQueue.concurrency = availableConcurrency;
              // secondaryLog("New concurrency for " + task.region + ": " + availableConcurrency);
            }
          }
          if(err && res && res.statusCode === 429) {
            // Rate limited :(
            // We'll retry later.
            requestQueue.concurrency = 1;
            var retryAfter = (res.headers['retry-after'] || 2) * 1000;
            secondaryLog("Rate limited, will retry in " + retryAfter + " (pending requests: " + (requestQueue.length() + 1) + ")");


            // Ensure that we don't reset while being rate limited
            clearTimeout(resetterTimeout);
            setTimeout(function() {
              secondaryLog("Restarting after rate limit");
              requestQueue.concurrency = defaultConcurrency;
              queueWorker(task, cb);
            }, retryAfter);
            return;
          }

          if(err && err.timeout) {
            err = new Error("Issues with the Riot API :( [TIMEOUT]");
          }

          // Mirror actual status code on the error
          if(err && res && res.statusCode) {
            err.statusCode = res.statusCode;

            // 500 on Riot side, let's try again just in case this is temporary
            if((res.statusCode === 500 || res.statusCode === 503) && !task.restartedAfter500) {
              task.restartedAfter500 = true;
              secondaryLog("Got a " + res.statusCode + " on " + task.endpoint + ", will try again.");
              setTimeout(function() {
                queueWorker(task, cb);
              }, 25);
              return;
            }
          }

          cb(err, res && res.body);

          // Ensure that if no one uses the queue, we don't get stuck with a concurrency of 1
          clearTimeout(resetterTimeout);
          resetterTimeout = setTimeout(resetterFunction, 10500);
        });
    };

    // Try to read from cache first
    // We already checked in cache once, however we may be in a situation where the same request was queued twice
    // thus resulting in a cache miss.
    // Also, our internal caching layer should be much faster than a real request anyway.
    async.waterfall([
      function getFromCache(cb) {
        self.cache.get(region, task.endpoint, task.cacheStrategy, rarity.slice(2, cb));
      },
      function actOnCache(cachedData, cb) {
        if(cachedData) {
          return done(null, cachedData);
        }

        fetcher(cb);
      }
    ], done);
  }

  // Generate a new queue for this region
  requestQueue = async.queue(queueWorker, defaultConcurrency);

  return requestQueue;
};


/**
 * Request a resource from Riot API.
 */
RiotRequest.prototype.request = function request(region, endpoint, cacheStrategy, done) {
  region = region.toLowerCase();
  var requestQueues = this.requestQueues;
  var cache = this.cache;

  if(!done) {
    done = cacheStrategy;
    cacheStrategy = false;
  }

  if(!requestQueues[region]) {
    // We use one queue per region to manage all calls
    // However, for ease of use and abstraction, we provide a "high-level" function request() which will handle all the queuing process
    // Note though that for this reason, request() can take a long time to process if a lot of queries are already in the region queue.
    // Cached requests are always guaranteed to reply fast however.
    log("Generating new queue for region " + region.toUpperCase());
    requestQueues[region] = this.generateQueue(region);
  }

  async.waterfall([
    function getFromCache(cb) {
      cache.get(region, endpoint, cacheStrategy, rarity.slice(2, cb));
    },
    function actOnCache(cachedData, cb) {
      if(cachedData) {
        log("Read " + region + ":" + endpoint + " from cache");
        // Skip everything else (we don't want to store the value again in cache)
        return done(null, cachedData);
      }

      requestQueues[region].push({
        region: region,
        endpoint: endpoint,
        cacheStrategy: cacheStrategy
      }, cb);
    },
    function saveToCache(data, cb) {
      log("Storing " + region + ":" + endpoint + " to cache");
      cache.set(region, endpoint, cacheStrategy, data);
      cb(null, data);
    }
  ], done);
};


module.exports = RiotRequest;
