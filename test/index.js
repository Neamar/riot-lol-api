"use strict";

var assert = require("assert");
var async = require("async");
var nock = require("nock");

var RiotRequest = require('../lib/index.js');

describe("Riot queue", function() {
  describe("Constructor", function() {
    it("should throw when missing Riot api key", function() {
      assert.throws(
        function() {
          /* jshint -W031 */
          new RiotRequest();
        },
        /missing riot api/i);
    });

    it("should throw when passing invalid rate limit parameters", function() {
      assert.throws(
        function() {
          /* jshint -W031 */
          new RiotRequest("fake", "not an array");
        },
        /rate-limit must be an array/i);
    });

    it("should throw when passing invalid rate limit parameters", function() {
      assert.throws(
        function() {
          /* jshint -W031 */
          new RiotRequest("fake", [15]);
        },
        /rate-limit must be an array of length 2/i);
    });

    it("should default to development key when rate limit is unspecifed", function() {
      var riotRequest = new RiotRequest("fake");
      assert.equal(riotRequest.rateLimits[0], 10);
      assert.equal(riotRequest.rateLimits[1], 500);
    });
  });

  describe("Requester without cache", function() {
    var riotRequest = new RiotRequest("fake_key", [100, 100]);

    it("should return results on valid reply from Riot's server", function(done) {
      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply({}, {ok: true});

      riotRequest.request('EUW', '/fake', false, function(err, res) {
        if(err) {
          return done(err);
        }

        assert.equal(res.ok, true);
        done();
      });
    });

    it("should retry automatically after a 500", function(done) {
      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(500, {ok: false});

      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(200, {ok: true});

      riotRequest.request('EUW', '/fake', false, function(err, res) {
        if(err) {
          return done(err);
        }

        assert.equal(res.ok, true);
        done();
      });
    });

    it("should fail after a second 500", function(done) {
      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(500, {ok: false});

      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(500, {ok: true});

      riotRequest.request('EUW', '/fake', false, function(err) {
        if(!err) {
          return done(new Error("Expected an error to occur."));
        }

        assert.equal(err.statusCode, 500);
        assert.equal(err.riotInternal, true);
        assert.equal(err.extra.endpoint, '/fake');
        done();
      });
    });

    it("should retry automatically after a 429", function(done) {
      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(429, {ok: false}, {'retry-after': '0.01'});

      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(200, {ok: true});

      riotRequest.request('EUW', '/fake', false, function(err, res) {
        if(err) {
          return done(err);
        }

        assert.equal(res.ok, true);
        done();
      });
    });

    it("should honor rate limits", function(done) {
      // Only one concurrent request at a time
      var riotRequest = new RiotRequest("fake_key", [1, 1]);

      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(200, {ok: "part1"});

      // Second call will return a 500
      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(404, {ok: false});

      async.parallel([
        function firstCall(cb) {
          riotRequest.request('EUW', '/fake', false, function(err, res) {
            if(err) {
              return cb(err);
            }

            assert.equal(res.ok, "part1");

            // Ensure the second calls works
            nock.cleanAll();
            nock('https://euw.api.pvp.net')
              .get('/fake')
              .query(true)
              .reply(200, {ok: "part2"});

            cb();
          });
        },
        function secondCall(cb) {
          riotRequest.request('EUW', '/fake', false, function(err, res) {
            if(err) {
              return cb(err);
            }

            assert.equal(res.ok, "part2");
            cb();
          });
        }
      ], done);
    });

    it("should allow for multiple calls in parallel", function(done) {
      // Up to 5 concurrent requests at a time
      var riotRequest = new RiotRequest("fake_key", [5, 5]);

      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(200, {ok: "part1"});

      // Second call will return a 500
      nock('https://euw.api.pvp.net')
        .get('/fake')
        .query(true)
        .reply(200, {ok: "part2"});

      async.parallel([
        function firstCall(cb) {
          riotRequest.request('EUW', '/fake', false, function(err, res) {
            if(err) {
              return cb(err);
            }

            assert.equal(res.ok, "part1");

            // Ensure the second calls fails it it hasn't already suceeded
            nock.cleanAll();
            nock('https://euw.api.pvp.net')
              .get('/fake')
              .query(true)
              .reply(404, {ok: false});

            cb();
          });
        },
        function secondCall(cb) {
          riotRequest.request('EUW', '/fake', false, function(err, res) {
            if(err) {
              return cb(err);
            }

            assert.equal(res.ok, "part2");
            cb();
          });
        }
      ], done);
    });
  });

  describe("Requester with cache", function() {
    it("should let user specify its own cache function", function(done) {
      var riotRequest = new RiotRequest("fake", null, {
        get: function(region, endpoint, cb) {
          cb(null, "cached_value");
        },
        set: function(region, endpoint, cacheStrategy, data) {
          // jshint unused:false
          // Do nothing.
        }
      });

      riotRequest.request('EUW', '/cacheable', 150, function(err, data) {
        assert.ifError(err);
        assert.equal(data, "cached_value");

        done();
      });
    });

    it("should call the setter function on the cache object", function(done) {
      var defaultPayload = {ok: true};
      nock('https://euw.api.pvp.net')
        .get('/cacheable')
        .query(true)
        .reply({}, defaultPayload);

      var requiredCacheStrategy = 150;
      var riotRequest = new RiotRequest("fake", null, {
        get: function(region, endpoint, cb) {
          cb(null, null);
        },
        set: function(region, endpoint, cacheStrategy, data) {
          assert.deepEqual(data, defaultPayload);
          assert.equal(requiredCacheStrategy, cacheStrategy);
          process.nextTick(done);
        }
      });

      riotRequest.request('EUW', '/cacheable', requiredCacheStrategy, function(err) {
        assert.ifError(err);
      });
    });

    it("should not call the setter function when reading from cache", function(done) {
      var requiredCacheStrategy = 150;
      var riotRequest = new RiotRequest("fake", null, {
        get: function(region, endpoint, cb) {
          cb(null, {cache: true});
        },
        set: function(region, endpoint, cacheStrategy, data) {
          // jshint unused:false
          throw new Error("Should not be called");
        }
      });

      riotRequest.request('EUW', '/cacheable', requiredCacheStrategy, function(err, data) {
        assert.ifError(err);
        assert.deepEqual(data, {cache: true});

        done();
      });
    });

    it("should not call the getter function when cache is disabled", function(done) {
      nock('https://euw.api.pvp.net')
        .get('/cacheable')
        .query(true)
        .reply(200, {ok: true});

      var riotRequest = new RiotRequest("fake", null, {
        get: function(region, endpoint, cb) {
          // jshint unused:false
          throw new Error("get() should not be called!");
        },
        set: function(region, endpoint, cacheStrategy, data) {
          // jshint unused:false
          throw new Error("set() should not be called!");
        }
      });

      riotRequest.request('EUW', '/cacheable', false, function(err, data) {
        assert.ifError(err);
        assert.deepEqual(data, {ok: true});

        done();
      });
    });

    it("should use the pre-cache when throttled", function(done) {
      // This is delayed to ensure the queue is throttled
      nock('https://euw.api.pvp.net')
        .get('/pending')
        .query(true)
        .delayBody(1000)
        .reply(200, {ok: true});

      nock('https://euw.api.pvp.net')
        .get('/cacheable')
        .query(true)
        .reply(200, {ok: true});

      var riotRequest = new RiotRequest("fake", [1, 1], {
        get: function(region, endpoint, cb) {
          // jshint unused:false
          if(endpoint === "/cacheable") {
            return cb(null, {cache: true});
          }
          throw new Error("get() should not be called for " + endpoint);
        },
        set: function(region, endpoint, cacheStrategy, data) {
          // jshint unused:false
          throw new Error("set() should not be called!");
        }
      });

      // Throttle the queue
      riotRequest.request('EUW', '/pending', false, function() {});

      setTimeout(function() {
        // And then ensure pre-cache works
        riotRequest.request('EUW', '/cacheable', true, function(err, data) {
          assert.ifError(err);
          assert.deepEqual(data, {cache: true});

          done();
        });
      }, 10);
    });
  });

  describe("Regions", function() {
    it("should be exposed on riotRequest", function() {
      var riotRequest = new RiotRequest("fake");
      assert.ok(riotRequest.REGIONS.indexOf('euw') !== -1);
    });
  });

  describe("Platforms", function() {
    it("should be available on riotRequest", function() {
      var riotRequest = new RiotRequest("fake");
      assert.ok(riotRequest.getPlatformFromRegion('euw'), 'EUW1');
    });

    it("should be available on riotRequest with any casing", function() {
      var riotRequest = new RiotRequest("fake");
      assert.ok(riotRequest.getPlatformFromRegion('EUW'), 'EUW1');
    });
  });
});
