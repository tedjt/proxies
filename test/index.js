var assert = require('assert');
var should = require('should');
var ms = require('ms');
var Proxies = require('..');
var ProxyIPChecker = require('proxies-proxyipchecker');
var proxynova = require('proxynova');
var Scraper = require('scraper');

describe('proxies', function () {
  this.timeout(120000); // sourcing and testing can take a while

  before(function (done) {
    var self = this;
    Scraper(function (err, scraper) {
      if (err) return done(err);
      self.proxyipchecker = ProxyIPChecker(scraper);
      done();
    });
  });

  it('should be able to sort proxies accurately', function() {
    var proxies = Proxies();
    proxies.proxies = testData();
    var toTest = proxies.testSort().splice(0, 50);
    toTest.should.eql([
      'http://190.7.157.90:8080',
      'http://190.39.85.152:8080',
      'http://190.7.157.92:8080',
      'http://190.78.61.203:8080',
      'http://190.39.169.53:8080',
      'http://190.78.79.100:8080',
      'http://190.72.159.228:8080'
    ]);
  });

  it('should be able to filter and sort proxies accurately', function() {
    var proxies = Proxies();
    proxies.proxies = testData();
    var filtered = proxies.filter({test: {date: new Date(1392490321683)}}).splice(0, 50);
    filtered.should.eql([
      'http://190.7.157.90:8080',
      "http://190.39.85.152:8080",
      'http://190.7.157.92:8080'
    ]);
    // notify of failure
    proxies.update('http://190.7.157.90:8080', false);
    filtered = proxies.filter({test: {date: new Date(1392490321683)}}).splice(0, 50);
    filtered.should.eql([
      "http://190.39.85.152:8080",
      'http://190.7.157.92:8080',
      'http://190.7.157.90:8080',
    ]);

    // blacklist - permanent
    proxies.blacklist('http://190.7.157.92:8080', true);
    filtered = proxies.filter({test: {date: new Date(1392490321683)}}).splice(0, 50);
    filtered.should.eql([
      "http://190.39.85.152:8080",
      'http://190.7.157.90:8080',
    ]);

    // blacklist - future half a second
    proxies.blacklist('http://190.7.157.92:8080', 500, 1392490321683);
    filtered = proxies.filter({test: {date: new Date(1392490321683)}}).splice(0, 50);
    filtered.should.eql([
      "http://190.39.85.152:8080",
      'http://190.7.157.90:8080',
    ]);

    // ensure it reappers in a half second
    filtered = proxies.filter({test: {date: new Date(1392490321683 + 600)}}).splice(0, 50);
    filtered.should.eql([
      "http://190.39.85.152:8080",
      'http://190.7.157.92:8080',
      'http://190.7.157.90:8080',
    ]);

  });

  it('should be able to get a working proxy', function (done) {
    var proxies = Proxies()
      .testEvery(ms('10s'))
      .source(proxynova)
      .source(this.proxyipchecker);

    var f = proxies;
    proxies.get(function (err, proxies) {
      if (err) return done(err);
      console.log('%j', proxies);
      assert(Array.isArray(proxies));
      assert(proxies.length > 0);
      console.log('%j', f.proxies);
      done();
    });
  });

  it('should execute next on timeout expiration', function (done) {
    var proxies = Proxies()
      .testEvery(ms('1m'))
      .source(proxynova)
      .source(this.proxyipchecker);

    var f = proxies;
    proxies.get({timeout: 20}, function (err, proxies) {
      if (err) return done(err);
      console.log('%j', proxies);
      assert(proxies.length === 0);
      done();
    });
  });
});

function testData() {
  return {
    // untested
    "http://190.78.61.203:8080":{
      "created":1392490312878,
      "lastTested":false,
      "lastSuccessful":false,
      "latency":null
    },
    // tested but failed
    "http://190.78.79.100:8080":{
      "created":1392490312878,
      "lastTested":1392490313497,
      "lastSuccessful":false,
      "latency":null
    },
    // older tested but failed
    "http://190.72.159.228:8080":{
      "created":1392490312878,
      "lastTested":1392490320683,
      "lastSuccessful":false,
      "latency":null
    },
    // succeful low latency
    "http://190.7.157.90:8080":{
      "created":1392490312878,
      "lastTested":1392490320683,
      "lastSuccessful":1392490320683,
      "latency":7800
    },
    // succesfull high latency
    "http://190.39.85.152:8080":{
      "created":1392490312878,
      "lastTested":1392490321683,
      "lastSuccessful":1392490321683,
      "latency":8800
    },
    // succeful low latency with failure (tested > succesful)
    "http://190.7.157.92:8080":{
      "created":1392490312878,
      "lastTested":1392490320883,
      "lastSuccessful":1392490320683,
      "latency":600
    },
    // untested two
    "http://190.39.169.53:8080":{
      "created":1392490312878,
      "lastTested":false,
      "lastSuccessful":false,
      "latency":null
    }
  };
}
