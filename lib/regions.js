'use strict';

var PLATFORMS = {
  'br': 'BR1',
  'eune': 'EUN1',
  'euw': 'EUW1',
  'kr': 'KR',
  'lan': 'LA1',
  'las': 'LA2',
  'na': 'NA1',
  'oce': 'OC1',
  'tr': 'TR1',
  'ru': 'RU',
  'jp': 'JP1',
  'pbe': 'PBE'
};


module.exports = function getPlatform(region) {
  return PLATFORMS[region.toLowerCase()];
};

module.exports.REGIONS = Object.keys(PLATFORMS);
module.exports.PLATFORMS = Object.keys(PLATFORMS).map(function(key) {
  return PLATFORMS[key];
});
