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
  'pbe': 'PBE',
  'americas': 'AMERICAS',
  'europe': 'EUROPE',
  'asia': 'ASIA'
};

var CLUSTERS = {
  'na': 'America',
  'br': 'America',
  'lan': 'America',
  'las': 'America',
  'oce': 'America',
  'kr': 'Asia',
  'jp': 'Asia',
  'eune':'Europe',
  'euw': 'Europe',
  'tr': 'Europe',
  'ru': 'Europe'
}


module.exports = function getPlatform(region) {
  return PLATFORMS[region.toLowerCase()];
};

module.exports.getCluster = function(region) {
  return CLUSTERS[region.toLowerCase()];
}

module.exports.REGIONS = Object.keys(PLATFORMS);
module.exports.PLATFORMS = Object.keys(PLATFORMS).map(function(key) {
  return PLATFORMS[key];
});
