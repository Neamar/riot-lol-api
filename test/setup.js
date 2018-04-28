'use strict';
var nock = require('nock');

beforeEach(function cleanNock() {
  nock.cleanAll();
});
