"use strict";

var assert = require("assert");
var nock = require("nock");
var async = require("async");

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

  it.skip("should cache results when cacheable=true", function(done) {
    nock('https://euw.api.pvp.net')
      .get('/cacheable')
      .query(true)
      .reply(200, {ok: 'first time'});

    nock('https://euw.api.pvp.net')
      .get('/cacheable')
      .query(true)
      .reply(200, {ok: 'second time'});

    async.waterfall([
      function(cb) {
        // Should fetch resource the first time
        riotRequest.request('EUW', '/cacheable', true, function(err, res) {
          if(err) {
            return cb(err);
          }

          assert.equal(res.ok, 'first time');
          cb();
        });
      },
      function(cb) {
        // Should reuse cached value and not call the second nock request
        riotRequest.request('EUW', '/cacheable', true, function(err, res) {
          if(err) {
            return cb(err);
          }

          assert.equal(res.ok, 'first time');
          cb();
        });
      },
      function(cb) {
        // Witch cacheable=false however, should do a new call
        riotRequest.request('EUW', '/cacheable', false, function(err, res) {
          if(err) {
            return cb(err);
          }

          assert.equal(res.ok, 'second time');
          cb();
        });
      }
    ], done);
  });
});
