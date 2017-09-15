"use strict";

var R = require('./lib');
var r = new R("RGAPI-fab5f566-8006-4622-af8a-16fc8e353969");

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
