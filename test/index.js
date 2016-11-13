"use strict";

var assert = require("assert");
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
  });

  describe("Requester with cache", function() {
    it("should let user specify its own cache function", function(done) {
      var riotRequest = new RiotRequest("fake", null, {
        get: function(region, endpoint, cacheStrategy, cb) {
          cb(null, cacheStrategy);
        },
        set: function(region, endpoint, cacheStrategy, data) {
          // jshint unused:false
          // Do nothing.
        }
      });

      var cacheStrategy = 150;
      riotRequest.request('EUW', '/cacheable', cacheStrategy, function(err, data) {
        assert.ifError(err);
        assert.equal(data, cacheStrategy);

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
        get: function(region, endpoint, cacheStrategy, cb) {
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
        get: function(region, endpoint, cacheStrategy, cb) {
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
  });
});
