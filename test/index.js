'use strict';

var assert = require('assert');
var async = require('async');
var nock = require('nock');

var RiotRequest = require('../lib/index.js');

describe('Riot queue', function() {
  describe('Constructor', function() {
    it('should throw when missing Riot api key', function() {
      assert.throws(
        function() {
          /* jshint -W031 */
          new RiotRequest();
        },
        /missing riot api/i);
    });

    it('should throw when using invalid cache', function() {
      assert.throws(
        function() {
          /* jshint -W031 */
          new RiotRequest(123, [1]);
        },
        /invalid cache object/i);
    });

    it('should set up default options when not specified', function() {
      let rr = new RiotRequest(123);
      assert.equal(rr.options.defaultRetryPeriod, 10);
    });

    it('should use specified options', function() {
      let rr = new RiotRequest(123, false, {defaultRetryPeriod: 2});
      assert.equal(rr.options.defaultRetryPeriod, 2);
    });
  });

  describe('Requester without cache', function() {
    var riotRequest = new RiotRequest('fake_key');

    it("should return results on valid reply from Riot's server", function(done) {
      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply({}, {ok: true});

      riotRequest.request('EUW1', 'test', '/fake', false, function(err, res) {
        if (err) {
          return done(err);
        }

        assert.equal(res.ok, true);
        done();
      });
    });

    it('should retry automatically after a 500', function(done) {
      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(500, {ok: false});

      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(200, {ok: true});

      riotRequest.request('EUW1', 'test', '/fake', false, function(err, res) {
        if (err) {
          return done(err);
        }

        assert.equal(res.ok, true);
        done();
      });
    });

    it('should fail after a second 500', function(done) {
      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(500, {ok: false});

      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(500, {ok: true});

      riotRequest.request('EUW1', 'test', '/fake', false, function(err) {
        if (!err) {
          return done(new Error('Expected an error to occur.'));
        }

        assert.equal(err.statusCode, 500);
        assert.equal(err.riotInternal, true);
        assert.equal(err.extra.endpoint, '/fake');
        done();
      });
    });

    it('should retry automatically after a 429', function(done) {
      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(429, {ok: false}, {'retry-after': '0.01'});

      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(200, {ok: true});

      riotRequest.request('EUW1', 'test', '/fake', false, function(err, res) {
        if (err) {
          return done(err);
        }

        assert.equal(res.ok, true);
        done();
      });
    });

    describe('Rate limiting', function() {
      it('should honor rate limits', function(done) {
        // Only one concurrent request at a time
        var riotRequest = new RiotRequest('fake_key');

        nock('https://euw1.api.riotgames.com')
          .get('/fake')
          .query(true)
          .reply(200, {ok: 'bar'}, {
            'x-app-rate-limit-count': '1:1',
            'x-app-rate-limit': '1:1',
            'x-method-rate-limit-count': '1:1',
            'x-method-rate-limit': '1:1'
          });

        riotRequest.request('EUW1', 'test', '/fake', false, function(err, res) {
          assert.ifError(err);

          assert.equal(res.ok, 'bar');

          assert.equal(riotRequest.requestQueues.euw1test.concurrency, 1);
          done();
        });
      });

      it('should honor app rate limits', function(done) {
        var riotRequest = new RiotRequest('fake_key');

        nock('https://euw1.api.riotgames.com')
          .get('/fake')
          .query(true)
          .reply(200, {ok: 'bar'}, {
            'x-app-rate-limit-count': '3:1',
            'x-app-rate-limit': '10:1',
            'x-method-rate-limit-count': '1:1',
            'x-method-rate-limit': '100:1'
          });

        riotRequest.request('EUW1', 'test', '/fake', false, function(err) {
          assert.ifError(err);

          // 10 - 3
          assert.equal(riotRequest.requestQueues.euw1test.concurrency, 7);
          done();
        });
      });

      it('should honor method rate limits', function(done) {
        var riotRequest = new RiotRequest('fake_key');

        nock('https://euw1.api.riotgames.com')
          .get('/fake')
          .query(true)
          .reply(200, {ok: 'bar'}, {
            'x-app-rate-limit-count': '1:1',
            'x-app-rate-limit': '100:1',
            'x-method-rate-limit-count': '5:1',
            'x-method-rate-limit': '30:1'
          });

        riotRequest.request('EUW1', 'test', '/fake', false, function(err) {
          assert.ifError(err);

          // 30 - 5
          assert.equal(riotRequest.requestQueues.euw1test.concurrency, 25);
          done();
        });
      });

      it('should honor secondary rate limits', function(done) {
        var riotRequest = new RiotRequest('fake_key');

        nock('https://euw1.api.riotgames.com')
          .get('/fake')
          .query(true)
          .reply(200, {ok: 'bar'}, {
            'x-app-rate-limit-count': '1:10,1:600',
            'x-app-rate-limit': '1000:10,420000:600',
            'x-method-rate-limit-count': '1:10,1000:600',
            'x-method-rate-limit': '1000:10,1200:600'
          });

        riotRequest.request('EUW1', 'test', '/fake', false, function(err) {
          assert.ifError(err);

          // 1200 - 1000
          assert.equal(riotRequest.requestQueues.euw1test.concurrency, 200);
          done();
        });
      });
    });

    it('should allow for multiple calls in parallel', function(done) {
      var riotRequest = new RiotRequest('fake_key');

      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(200, {ok: 'part1'});

      nock('https://euw1.api.riotgames.com')
        .get('/fake')
        .query(true)
        .reply(200, {ok: 'part2'});

      // Run in parallel
      async.parallel([
        function firstCall(cb) {
          riotRequest.request('EUW1', 'test', '/fake', false, function(err, res) {
            if (err) {
              return cb(err);
            }

            assert.equal(res.ok, 'part1');

            // Ensure the second calls fails it it hasn't already suceeded
            nock.cleanAll();
            nock('https://euw.api.riotgames.com')
              .get('/fake')
              .query(true)
              .reply(404, {ok: false});

            cb();
          });
        },
        function secondCall(cb) {
          riotRequest.request('EUW1', 'test', '/fake', false, function(err, res) {
            if (err) {
              return cb(err);
            }

            assert.equal(res.ok, 'part2');
            cb();
          });
        }
      ], done);
    });
  });

  describe('Requester with cache', function() {
    it('should let user specify its own cache function', function(done) {
      var riotRequest = new RiotRequest('fake', {
        get: function(region, endpoint, cb) {
          cb(null, 'cached_value');
        },
        set: function(region, endpoint, cacheStrategy, data) { // eslint-disable-line no-unused-vars
          // Do nothing.
        }
      });

      riotRequest.request('EUW1', 'test', '/cacheable', 150, function(err, data) {
        assert.ifError(err);
        assert.equal(data, 'cached_value');

        done();
      });
    });

    it('should call the setter function on the cache object', function(done) {
      var defaultPayload = {ok: true};
      nock('https://euw1.api.riotgames.com')
        .get('/cacheable')
        .query(true)
        .reply({}, defaultPayload);

      var requiredCacheStrategy = 150;
      var riotRequest = new RiotRequest('fake', {
        get: function(region, endpoint, cb) {
          cb(null, null);
        },
        set: function(region, endpoint, cacheStrategy, data) {
          assert.deepEqual(data, defaultPayload);
          assert.equal(requiredCacheStrategy, cacheStrategy);
          process.nextTick(done);
        }
      });

      riotRequest.request('EUW1', 'test', '/cacheable', requiredCacheStrategy, function(err) {
        assert.ifError(err);
      });
    });

    it('should not call the setter function when reading from cache', function(done) {
      var requiredCacheStrategy = 150;
      var riotRequest = new RiotRequest('fake', {
        get: function(region, endpoint, cb) {
          cb(null, {cache: true});
        },
        set: function(region, endpoint, cacheStrategy, data) { // eslint-disable-line no-unused-vars
          throw new Error('Should not be called');
        }
      });

      riotRequest.request('EUW1', 'test', '/cacheable', requiredCacheStrategy, function(err, data) {
        assert.ifError(err);
        assert.deepEqual(data, {cache: true});

        done();
      });
    });

    it('should not call the getter function when cache is disabled', function(done) {
      nock('https://euw1.api.riotgames.com')
        .get('/cacheable')
        .query(true)
        .reply(200, {ok: true});

      var riotRequest = new RiotRequest('fake', {
        get: function(region, endpoint, cb) { // eslint-disable-line no-unused-vars
          throw new Error('get() should not be called!');
        },
        set: function(region, endpoint, cacheStrategy, data) { // eslint-disable-line no-unused-vars
          throw new Error('set() should not be called!');
        }
      });

      riotRequest.request('EUW1', 'test', '/cacheable', false, function(err, data) {
        assert.ifError(err);
        assert.deepEqual(data, {ok: true});

        done();
      });
    });

    it('should use the pre-cache when rate limited', function(done) {
      // Set rate limit to 1
      nock('https://euw1.api.riotgames.com')
        .get('/throttle')
        .query(true)
        .reply(200, {ok: true}, {
          'x-app-rate-limit-count': '1:1',
          'x-app-rate-limit': '1:1',
          'x-method-rate-limit-count': '1:1',
          'x-method-rate-limit': '1:1'
        });

      // This is delayed to ensure the queue is throttled
      nock('https://euw1.api.riotgames.com')
        .get('/pending')
        .query(true)
        .delayBody(1000)
        .reply(200, {ok: true});

      nock('https://euw1.api.riotgames.com')
        .get('/cacheable')
        .query(true)
        .reply(200, {ok: true});

      var riotRequest = new RiotRequest('fake', {
        get: function(region, endpoint, cb) {
          if (endpoint === '/cacheable') {
            return cb(null, {cache: true});
          }
          throw new Error('get() should not be called for ' + endpoint);
        },
        set: function(region, endpoint, cacheStrategy, data) { // eslint-disable-line no-unused-vars
          throw new Error('set() should not be called!');
        }
      });

      // Throttle the queue
      riotRequest.request('EUW1', 'test', '/throttle', function() {
        assert.equal(riotRequest.requestQueues.euw1test.concurrency, 1);
        // This request will take one full second to complete, and since the concurrency is 1, the next request won't start.
        riotRequest.request('EUW1', 'test', '/pending', false, function() {});

        setTimeout(function() {
          // And then ensure pre-cache works
          riotRequest.request('EUW1', 'test', '/cacheable', true, function(err, data) {
            assert.ifError(err);
            assert.deepEqual(data, {cache: true});

            done();
          });
        }, 10);
      });
    });

    it('should decrease concurrency when throttler is set for a single platform', function(done) {
      // Set rate limit to 100
      nock('https://euw1.api.riotgames.com')
        .get('/throttle')
        .query(true)
        .reply(200, {ok: true}, {
          'x-app-rate-limit-count': '1:1',
          'x-app-rate-limit': '200:1',
          'x-method-rate-limit-count': '1:1',
          'x-method-rate-limit': '100:1'
        });
      // Set throttler to 50
      var riotRequest = new RiotRequest('fake');
      riotRequest.setThrottle('EUW1', 'test', 50);

      riotRequest.request('EUW1', 'test', '/throttle', function() {
        // Queue concurrency should be real value minus manual throttle
        assert.equal(riotRequest.requestQueues.euw1test.concurrency, 100 - 50 - 1);
        done();
      });
    });

    it('should decrease concurrency when throttler is set for all platforms', function(done) {
      // Set rate limit to 100
      nock('https://euw1.api.riotgames.com')
        .get('/throttle')
        .query(true)
        .reply(200, {ok: true}, {
          'x-app-rate-limit-count': '1:1',
          'x-app-rate-limit': '200:1',
          'x-method-rate-limit-count': '1:1',
          'x-method-rate-limit': '100:1'
        });
      // Set throttler to 50
      var riotRequest = new RiotRequest('fake');
      riotRequest.setThrottle('test', 50);

      riotRequest.request('EUW1', 'test', '/throttle', function() {
        // Queue concurrency should be real value minus manual throttle
        assert.equal(riotRequest.requestQueues.euw1test.concurrency, 100 - 50 - 1);
        done();
      });
    });
  });

  describe('Regions', function() {
    it('should be exposed on riotRequest', function() {
      var riotRequest = new RiotRequest('fake');
      assert.ok(riotRequest.REGIONS.indexOf('euw') !== -1);
    });
  });

  describe('Platforms', function() {
    it('should be exposed on riotRequest', function() {
      var riotRequest = new RiotRequest('fake');
      assert.ok(riotRequest.PLATFORMS.indexOf('EUW1') !== -1);
    });

    it('should be available on riotRequest', function() {
      var riotRequest = new RiotRequest('fake');
      assert.ok(riotRequest.getPlatformFromRegion('euw'), 'EUW1');
    });

    it('should be available on riotRequest with any casing', function() {
      var riotRequest = new RiotRequest('fake');
      assert.ok(riotRequest.getPlatformFromRegion('EUW'), 'EUW1');
    });
  });
});
