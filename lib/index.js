'use strict';

var async = require('async');
var superagent = require('superagent');
var rarity = require('rarity');
var log = require('debug')('riot-lol-api:request');
var regions = require('./regions.js');


var Agent = require('agentkeepalive').HttpsAgent;
var keepaliveAgent = new Agent();

/**
 * Create a new object for making request to the RiotAPI.
 * Use with new RiotRequest(apiKey, [rate][, cache])
 * Ratelimits will default to a development api key (very slow)
 * Cache must be an object exposing both get() and set() methods
 */
var RiotRequest = function(apiKey, cache, options) {
  if (!apiKey) {
    throw new Error('Missing Riot API key.');
  }

  if (!cache) {
    log('No cache specified.');
    cache = {
      get: function(platform, endpoint, cb) {
        cb(null, null);
      },
      set: function(platform, endpoint, cacheStrategy, data) { // eslint-disable-line no-unused-vars
        // Do nothing.
      }
    };
  }

  if (!cache.get || !cache.set) {
    throw new Error('Invalid cache object');
  }

  this.apiKey = apiKey;
  this.cache = cache;

  this.throttler = {};
  regions.PLATFORMS.forEach(p => this.throttler[p.toLowerCase()] = {});

  // Will contain all the queues (one per couple platform/method)
  this.requestQueues = {};

  // Populate options object
  if (!(options instanceof Object)) {
    options = {};
  }
  const defaultOptions = {
    defaultRetryPeriod: 10
  };

  this.options = Object.assign(defaultOptions, options);
};

RiotRequest.prototype.generateQueue = function generateQueue(platform, method) {
  var self = this;
  var secondaryLog = require('debug')('riot-lol-api:request:' + platform + ':' + method);

  var requestQueue;

  // Assume development key by default, this will be updated on the first request on this queue
  var defaultConcurrency = 20;
  var timeBeforeReset = 1000;
  var bucketStartedAt = new Date(0);
  var unthrottledConcurrency = defaultConcurrency;

  function readRateLimit(header) {
    return header.split(',').map(v => v.split(':'));
  }

  // Queue worker, loading endpoints from Riot and returning the body
  // This function also handles rate-limiting, retrying after the proper delay.
  // done(err, content, readFromCache)
  function queueWorker(task, done) {
    if (!task.endpoint) {
      return done(new Error('No API endpoint specified'));
    }

    // Strategy for fetching when not in cache
    var fetcher = function getFromRiot(cb) {
      // Do we need to reset concurrency?
      var now = new Date();
      if (now.getTime() - bucketStartedAt.getTime() > timeBeforeReset) {
        // Set to now for now, but we'll have to take server lag into account later
        bucketStartedAt = now;
        var throttleInformation = '';
        if (self.throttler[platform][method]) {
          throttleInformation = `[throttle: ${self.throttler[platform][method]}, real concurrency ≈ ${unthrottledConcurrency}]`;
        }
        secondaryLog(`Resetting queue concurrency to ${defaultConcurrency} (was ${requestQueue.concurrency} ${throttleInformation})`);
      }

      secondaryLog(`Loading from network ${platform}: ${task.endpoint} (c:${requestQueue.concurrency}/${defaultConcurrency}${requestQueue.length() > 0 ? ', p:' + requestQueue.length() : ''})`);

      superagent
        .get('https://' + platform + '.api.riotgames.com' + task.endpoint + (task.endpoint.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + self.apiKey)
        .agent(keepaliveAgent)
        .timeout(3500)
        .end(function(err, res) {
          if (res && res.headers && res.headers['x-app-rate-limit-count'] && res.headers['x-method-rate-limit']) {
            var appRateCount = readRateLimit(res.headers['x-app-rate-limit-count']);
            var methodRateCount = readRateLimit(res.headers['x-method-rate-limit-count']);

            var appRateLimit = readRateLimit(res.headers['x-app-rate-limit']);
            var methodRateLimit = readRateLimit(res.headers['x-method-rate-limit']);

            var limit = appRateLimit.concat(methodRateLimit);
            var count = appRateCount.concat(methodRateCount);

            var callsLeft = limit.map(function(limit, index) {
              return limit[0] - count[index][0];
            });

            var currentUnthrottledConcurrency = Math.max(
              1,
              Math.min.apply(Math, callsLeft)
            );
            unthrottledConcurrency = Math.min(currentUnthrottledConcurrency, unthrottledConcurrency);
            var availableConcurrency = Math.max(1, currentUnthrottledConcurrency - (self.throttler[platform][method] || 0));

            if (bucketStartedAt === now) {
              // Should be mostly static data, only update on reset
              defaultConcurrency = Math.min.apply(Math, limit.map(l => l[0]));
              timeBeforeReset = Math.min.apply(Math, limit.filter(l => parseInt(l[0]) === defaultConcurrency).map(l => l[1])) * 1000;
            }

            // Don't forget to take into account requests already in-flight!
            // (this will ensure that when concurrency reaches one, we don't have a lot of in-flight requests that would return 429)
            // (but not THIS particular request, that has already been done)
            availableConcurrency = Math.max(1, availableConcurrency - requestQueue.running() + 1);

            if (requestQueue.concurrency > availableConcurrency) {
              requestQueue.concurrency = availableConcurrency;
              // secondaryLog("New concurrency for " + platform + ": " + availableConcurrency);
            }

            if (bucketStartedAt === now) {
              // Did we just start a bucket? Then the real starting date is now, since there is otherwise a small delay with the server
              bucketStartedAt = new Date();

              // We can also reset concurrency to something higher, since we're now in of a new time bucket.
              requestQueue.concurrency = availableConcurrency;
              unthrottledConcurrency = defaultConcurrency;
            }
          }

          if (err && err.status === 429) {
            // Rate limited :(
            // We'll retry later.
            requestQueue.concurrency = 0;
            var retryAfter = (res.headers['retry-after'] || self.options.defaultRetryPeriod) * 1000;
            requestQueue.rateLimited = true;
            secondaryLog(`Rate limited, will retry in ${retryAfter} (pending requests: ${requestQueue.length() + 1})`);

            setTimeout(function() {
              secondaryLog('Restarting after rate limit');
              bucketStartedAt = new Date(Date.now() - timeBeforeReset - 1000);
              requestQueue.rateLimited = false;
              requestQueue.concurrency = 1;
              queueWorker(task, cb);
            }, retryAfter);
            return;
          }

          if (err && err.timeout) {
            err = new Error('Issues with the Riot API :( [TIMEOUT]');
            err.timeout = true;
          }

          // Mirror actual status code on the error
          if (err) {
            // 500 on Riot side, let's try again just in case this is temporary
            if ((err.status === 500 || err.status === 503) && !task.restartedAfter500) {
              task.restartedAfter500 = true;
              secondaryLog(`Got a ${err.status} on ${task.endpoint} will try again.`);
              setTimeout(function() {
                queueWorker(task, cb);
              }, 25);
              return;
            }

            err.statusCode = err.status;
            err.riotInternal = true;
            err.extra = {
              platform: platform,
              endpoint: task.endpoint,
              status: err.status,
              currentConcurrency: requestQueue.concurrency,
              defaultConcurrency: defaultConcurrency,
              timeout: err.timeout || false,
              restartedAfter500: !!task.restartedAfter500
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
        if (!task.cacheStrategy) {
          return cb(null, null);
        }

        self.cache.get(platform, task.endpoint, rarity.slice(2, cb));
      },
      function actOnCache(cachedData, cb) {
        if (cachedData) {
          secondaryLog('Read from cache ' + platform + ':' + task.endpoint);
          return cb(null, cachedData, true);
        }

        fetcher(cb);
      }
    ], done);
  }

  // Generate a new queue for this platform
  requestQueue = async.queue(queueWorker, defaultConcurrency);
  requestQueue.log = secondaryLog;
  return requestQueue;
};

RiotRequest.prototype.getQueue = function setThrottle(platform, method) {
  platform = platform.toLowerCase();
  method = method.toLowerCase();
  var queueName = platform + method;
  var requestQueues = this.requestQueues;

  if (!requestQueues[queueName]) {
    // We use one queue per platform per methode to manage all calls
    // However, for ease of use and abstraction, we provide a "high-level" function request() which will handle all the queuing process
    // Note though that for this reason, request() can take a long time to process if a lot of queries are already in the platform queue.
    // Cached requests are always guaranteed to reply fast however.
    log('Generating new queue for platform ' + platform.toUpperCase() + ' and method ' + method);
    requestQueues[queueName] = this.generateQueue(platform, method);
  }

  return requestQueues[queueName];
};


/**
 * Request a resource from Riot API.
 */
RiotRequest.prototype.request = function request(platform, method, endpoint, cacheStrategy, done) {
  platform = platform.toLowerCase();
  method = method.toLowerCase();

  var cache = this.cache;

  if (!done) {
    done = cacheStrategy;
    cacheStrategy = false;
  }

  var requestQueue = this.getQueue(platform, method);

  async.waterfall([
    function getFromCache(cb) {
      if (!cacheStrategy || requestQueue.running() < requestQueue.concurrency) {
        // Cache is disabled
        // or concurrency is higher than current job count,
        // which mean there will be a cache query as soon as the task is pushed
        return cb(null, null);
      }
      cache.get(platform, endpoint, rarity.slice(2, cb));
    },
    function actOnCache(cachedData, cb) {
      if (cachedData) {
        requestQueue.log('Read from pre-cache ' + platform + ':' + endpoint + ' due to high concurrency');
        return cb(null, cachedData, true);
      }

      requestQueue.push({
        endpoint: endpoint,
        cacheStrategy: cacheStrategy
      }, cb);
    },
    function saveToCache(data, readFromCache, cb) {
      if (!cacheStrategy || readFromCache) {
        return cb(null, data);
      }

      requestQueue.log('Storing in cache ' + platform + ':' + endpoint + ', strategy ' + cacheStrategy);
      // This could theoretically be improved by calling cb() before storing in cache, however doing this in this order ensure that synchronous cache (e.g. lru-cache) will store before we complete, minimizing the risk of cache-miss on future requests.
      cache.set(platform, endpoint, cacheStrategy, data);
      cb(null, data);
    }
  ], done);
};

RiotRequest.prototype.setThrottle = function setThrottle(platform, method, throttle) {
  if (!throttle) {
    throttle = method;
    method = platform;
    Object.values(this.throttler).forEach(t => t[method] = throttle);
  }
  else {
    this.throttler[platform.toLowerCase()][method] = throttle;
  }
};

RiotRequest.prototype.REGIONS = regions.REGIONS;
RiotRequest.prototype.PLATFORMS = regions.PLATFORMS;
RiotRequest.prototype.getPlatformFromRegion = regions;
RiotRequest.prototype.getClusterFromRegion = regions.getCluster;

module.exports = RiotRequest;
