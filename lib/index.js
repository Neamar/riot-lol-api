"use strict";

var async = require("async");
var superagent = require("superagent");
var rarity = require("rarity");
var log = require("debug")("riot-lol-api:request");
var regions = require('./regions.js');


var Agent = require('agentkeepalive').HttpsAgent;
var keepaliveAgent = new Agent();

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
      get: function(region, endpoint, cb) {
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
  var defaultLongConcurrency = this.rateLimits[1];
  var defaultConcurrencyPadding = defaultConcurrency < 50 ? 0.2 * defaultConcurrency : 0.05 * defaultConcurrency;

  // Queue worker, loading endpoints from Riot and returning the body
  // This function also handles rate-limiting, retrying after the proper delay.
  // done(err, content, readFromCache)
  function queueWorker(task, done) {
    if(!task.region) {
      throw new Error("Undefined region.");
    }

    // Strategy for fetching when not in cache
    var fetcher = function getFromRiot(cb) {
      // Do we need to reset concurrency?
      var now = new Date();
      if(now.getTime() - requestQueue.lastNetworkCall.getTime() > 10150) {
        requestQueue.concurrency = defaultConcurrency;
        secondaryLog("Resetting queue concurrency to " + defaultConcurrency);
      }
      requestQueue.lastNetworkCall = now;

      secondaryLog("Loading from network " + task.region + ":" + task.endpoint);

      superagent
        .get("https://" + task.region + ".api.riotgames.com" + task.endpoint + (task.endpoint.indexOf("?") === -1 ? "?" : "&") + "api_key=" + self.apiKey)
        .agent(keepaliveAgent)
        .timeout(3500)
        .end(function(err, res) {
          if(res && res.headers && res.headers['x-app-rate-limit-count']) {
            var rateInfo = res.headers['x-app-rate-limit-count'].split(',');
            rateInfo[0] = rateInfo[0].split(':');
            rateInfo[1] = rateInfo[1].split(':');

            // Concurrency is always at least 1
            // (in which case we'll get a Rate-Limited 429 with a header explaining how long we should wait)
            // and can't be higher than the defaultConcurrency minus calls already made
            // (plus a padding to account for parallel requests already in-flight)
            // For a dev key, padding is 20%, so we'll do 8 requests THEN set the concurrency to 1 when approaching the limit
            var availableConcurrency = Math.max(
              1,
              Math.min(
                defaultConcurrency - rateInfo[0][0] - defaultConcurrencyPadding,
                defaultLongConcurrency - rateInfo[1][0]
              )
            );

            if(requestQueue.concurrency !== availableConcurrency) {
              requestQueue.concurrency = availableConcurrency;
              // secondaryLog("New concurrency for " + task.region + ": " + availableConcurrency);
            }
          }

          if(err && err.status === 429) {
            // Rate limited :(
            // We'll retry later.
            requestQueue.concurrency = 1;
            var retryAfter = (res.headers['retry-after'] || 2) * 1000;
            secondaryLog("Rate limited, will retry in " + retryAfter + " (pending requests: " + (requestQueue.length() + 1) + ")");

            setTimeout(function() {
              secondaryLog("Restarting after rate limit");
              requestQueue.concurrency = defaultConcurrency;
              queueWorker(task, cb);
            }, retryAfter);
            return;
          }

          if(err && err.timeout) {
            err = new Error("Issues with the Riot API :( [TIMEOUT]");
            err.timeout = true;
          }

          // Mirror actual status code on the error
          if(err) {
            // 500 on Riot side, let's try again just in case this is temporary
            if((err.status === 500 || err.status === 503) && !task.restartedAfter500) {
              task.restartedAfter500 = true;
              secondaryLog("Got a " + err.status + " on " + task.endpoint + ", will try again.");
              setTimeout(function() {
                queueWorker(task, cb);
              }, 25);
              return;
            }

            err.statusCode = err.status;
            err.riotInternal = true;
            err.extra = {
              region: task.region,
              endpoint: task.endpoint,
              status: err.status,
              currentConcurrency: requestQueue.concurrency,
              defaultConcurrency: defaultConcurrency,
              defaultLongConcurrency: defaultLongConcurrency,
              timeout: err.timeout || false,
              restartedAfter500: task.restartedAfter500
            };
          }


          cb(err, res && res.body, false);
        });
    };

    // Try to read from cache first
    // We potentially already checked in cache once,
    // however we may be in a situation where the same request was queued twice
    // thus resulting in a cache miss.
    // Also, our internal caching layer should be much faster than a real request anyway.
    async.waterfall([
      function getFromCache(cb) {
        if(!task.cacheStrategy) {
          return cb(null, null);
        }

        self.cache.get(region, task.endpoint, rarity.slice(2, cb));
      },
      function actOnCache(cachedData, cb) {
        if(cachedData) {
          secondaryLog("Read from cache " + region + ":" + task.endpoint);
          return cb(null, cachedData, true);
        }

        fetcher(cb);
      }
    ], done);
  }

  // Generate a new queue for this region
  requestQueue = async.queue(queueWorker, defaultConcurrency);
  requestQueue.log = secondaryLog;
  requestQueue.lastNetworkCall = new Date();
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

  var requestQueue = requestQueues[region];

  async.waterfall([
    function getFromCache(cb) {
      if(!cacheStrategy || requestQueue.running() < requestQueue.concurrency) {
        // Cache is disabled
        // or concurrency is higher than current job count,
        // which mean there will be a cache query as soon as the task is pushed
        return cb(null, null);
      }
      cache.get(region, endpoint, rarity.slice(2, cb));
    },
    function actOnCache(cachedData, cb) {
      if(cachedData) {
        requestQueue.log("Read from pre-cache " + region + ":" + endpoint + " due to high concurrency");
        return cb(null, cachedData, true);
      }

      requestQueue.push({
        region: region,
        endpoint: endpoint,
        cacheStrategy: cacheStrategy
      }, cb);
    },
    function saveToCache(data, readFromCache, cb) {
      if(!cacheStrategy || readFromCache) {
        return cb(null, data);
      }

      requestQueue.log("Storing in cache " + region + ":" + endpoint + ", strategy " + cacheStrategy);
      // This could theoretically be improved by calling cb() before storing in cache, however doing this in this order ensure that synchronous cache (e.g. lru-cache) will store before we complete, minimizing the risk of cache-miss on future requests.
      cache.set(region, endpoint, cacheStrategy, data);
      cb(null, data);
    }
  ], done);
};


RiotRequest.prototype.REGIONS = regions.REGIONS;
RiotRequest.prototype.getPlatformFromRegion = regions;

module.exports = RiotRequest;
