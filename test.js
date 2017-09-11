"use strict";

var R = require('./lib');
var r = new R("RGAPI-c0590c2b-6b37-44c0-bf3d-dec766933649");

function doRequest() {
  r.request('br1', 'summoner', '/lol/league/v3/positions/by-summoner/3269809', function() {
    console.log("------");
    doRequest();
  });
}

doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
doRequest();
