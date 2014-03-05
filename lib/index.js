var Batch = require('batch');
var debug = require('debug')('proxies');
var defaults = require('defaults');
var Emitter = require('events').EventEmitter;
var inherit = require('util').inherits;
var ms = require('ms');
var request = require('request');

/**
 * Expose `Proxies`.
 */

module.exports = Proxies;

/**
 * Initialize a `Proxies` instance.
 */

var DEFAULT_FILTER_OPTIONS = {
  maxAge: ms('1h'),
  maxLatency: 30000
};

function Proxies (options) {
  if (!(this instanceof Proxies)) return new Proxies(options);
  this.options = defaults(options, {
    refresh: ms('1m'),
    timeout: ms('20s'),
    limit: 100,
    concurrency: 10
  });

  this.sources = [];
  this.proxies = {};

  this.ready = false;
  this.refreshing = false;

  this.refreshTimer = null;
  this.resetRefreshTimer();

  this.tester = function () {
    return { method: 'GET', url: 'https://google.com' };
  };
}

/**
 * Inherit from `Emitter`.
 */

inherit(Proxies, Emitter);

/**
 * Add a source `fn` of proxy urls.
 *
 * @param {Function} fn
 * @return {Proxies}
 */

Proxies.prototype.source = function (fn) {
  this.sources.push(fn);
  return this;
};

/**
 * Set the proxy testEvery refresh time.
 *
 * @param {Number} refresh
 * @return {Proxies}
 */

Proxies.prototype.testEvery = function (refresh) {
  this.options.refresh = refresh;
  this.resetRefreshTimer();
  return this;
};

/**
 * Set the test `fn` for sources.
 *
 * @param {Function} fn
 * @return {Sources}
 */

Proxies.prototype.test = function (fn) {
  this.tester = fn;
  return this;
};

/**
 * Add a proxy.
 *
 * @param {String} proxy
 * @returns {Proxies}
 */

Proxies.prototype.add = function (proxy) {
  if (proxy in this.proxies) {
    debug('proxy %s already exists', proxy);
  } else {
    this.proxies[proxy] = {
      created: Date.now(),
      lastTested: false,
      lastSuccessful: false,
      latency: null,
      blacklist: false
    };
  }
  return this;
};

/**
 * Reset the new refresh timer.
 *
 * @return {Proxies}
 */

Proxies.prototype.resetRefreshTimer = function () {
  if (this.refreshTimer) clearInterval(this.refreshTimer);
  this.refreshTimer = setInterval(this.refresh.bind(this), this.options.refresh);
  return this;
};

/**
 * Refresh the proxies.
 * @param {Function} callback
 * @return {Proxies}
 */
Proxies.prototype.refresh = function (callback) {
  var self = this;
  if (this.refreshing) return;
  this.refreshing = true;
  this.refreshProxies(function (err) {
    self.refreshing = false;
    if (callback) callback(err);
  });
  return this;
};

/**
 * Refresh all the sources, and then test all the proxies.
 *
 * @param {Function} callback
 * @return {Proxies}
 */

Proxies.prototype.refreshProxies = function (callback) {
  var self = this;
  debug('refreshing sources ..');

  // only refresh sources if we have less than 5 working proxies
  var whitelist = self.filter({ maxAge: ms('1h'), latency: 15000 });
  var refreshSrcFn = this.refreshSources;
  if (whitelist.length > 4 && whitelist[0].lastSuccessful >= whitelist[0].lastTested) {
    // create a dummy refresh sources
    debug('skipping refresh of proxies since we have %d good ones', whitelist.length);
    refreshSrcFn = function(callback) {
      callback(null);
    };
  }
  refreshSrcFn.bind(this)(function (err) {
    if (err) {
      debug('error refreshing sources %s', err);
      if (callback) callback(err);
    } else {
      debug('refreshed sources, testing proxies ..');
      self.testProxies(function (err) {
        if (err) {
          debug('error testing proxies %s', err);
          if (callback) return callback(err);
        } else {
          debug('finished testing proxies');
          //var whitelist = self.filter({ maxAge: ms('1h'), latency: 30000 });
          //debug('whitelist post filter has length: %d', whitelist.length);
          //whitelist = whitelist.splice(0, self.options.limit);
          //self.trim(whitelist);
          if (callback) callback();
        }
      });
    }
  });
  return this;
};

/**
 * Refresh proxy sources.
 *
 * @param {Function} callback
 * @return {Sources}
 */

Proxies.prototype.refreshSources = function (callback) {
  var self = this;
  var batch = new Batch();
  batch.concurrency(this.options.concurrency);
  var add = this.add.bind(this);
  this.sources.forEach(function (source) {
    batch.push(function (done) {
      debug('request source %s ..', source.name);
      source(function (err, proxies) {
        if (err) {
          debug('source %s error %s', source.name, err);
          self.emit('source fetch error', err);
        }
        else {
          proxies.forEach(add);
          self.emit('source fetch', proxies);
        }
        done();
      });
    });
  });
  batch.end(callback);
  return this;
};

/**
 * Test sources.
 *
 * @param {Function} callback
 * @return {Sources}
 */

Proxies.prototype.testProxies = function (callback) {
  var self = this;
  var batch = new Batch();
  batch.concurrency(this.options.concurrency);
  // we don't always test all - just the most promising
  var toTest = self.testSort().splice(0, 50);
  toTest.forEach(function (proxy) {
    var memo = self.proxies[proxy];
    batch.push(function (done) {
      debug('testing proxy %s ..', proxy);
      var options = self.tester();
      options.proxy = proxy;
      options.timeout = self.options.timeout;
      var start = Date.now();
      request(options, function (err, res) {
        memo.lastTested = Date.now();
        if (err) {
          debug('proxy %s test error %s', proxy, err);
          self.emit('proxy test failure', proxy);
        } else if (Math.floor(res.statusCode / 100) !== 2) {
          debug('proxy %s bad status %d', proxy, res.statusCode);
          self.emit('proxy status failure', proxy);
        } else {
          memo.lastSuccessful = Date.now();
          memo.latency = Date.now() - start;
          debug('proxy %s test successful in %s ms', proxy, memo.latency);
          self.emit('proxy test success', proxy, memo);
          // we have a proxy now so we're ready
          self.ready = true;
          // we wait to emit ready until the end of the batch
          //self.emit('ready');
        }
        done();
      });
    });
  });
  batch.end(function(err) {
    if (self.ready) {
      self.emit('ready');
      callback(err);
    } else {
      debug('Proxies not ready attempting to test more');
      var now = Date.now();
      var untested = Object.keys(self.proxies).filter(function(p) {
        var memo = self.proxies[p];
        return  !memo.lastTested || (now - memo.lastTested > 60000);
      });
      if (untested.length) {
        debug('Proxies not ready testing more candidates: %d', untested.length);
        self.testProxies(callback);
      } else {
        callback(null);
      }
    }
  });
  return this;
};

/**
 * Trim the proxies by the whitelist
 *
 * @param {Array|String} whitelist
 */

Proxies.prototype.trim = function (whitelist) {
  var self = this;
  var map = {};
  whitelist.forEach(function (proxy) { map[proxy] = true; });
  var all = Object.keys(this.proxies);
  debug('trimming proxies, keeping %d / %d proxies ..', whitelist.length, all.length);
  all.forEach(function (proxy) {
    if (!(proxy in map)) {
      delete proxies[proxy];
      debug('deleted proxy %s', proxy);
    }
  });
  debug('trimmed proxies, %d left', Object.keys(this.proxies).length);
};

/**
 * Filter the proxy keys by `maxAge` and `maxLatency` and
 * sort by latency.
 * @param {Object} options
 * @return {Array|String}
 */

Proxies.prototype.filter = function (options) {
  var self = this;
  options = defaults(options, DEFAULT_FILTER_OPTIONS);
  var now = Date.now();
  if (options.test && options.test.date) {
    now = options.test.date;
  }

  debug('filtering proxies with %d', Object.getOwnPropertyNames(this.proxies).length);
  var results = Object.keys(this.proxies)
    .filter(function(proxy) { //blacklist
      if (options.test && options.test.date) {
        return !isBlacklisted(self.proxies[proxy], options.test.date);
      }
      return !isBlacklisted(self.proxies[proxy]);
    });
  debug('after filtering blacklisted with %d', results.length);
  results = results
    .filter(function (proxy) { // filter out not successful
      var memo = self.proxies[proxy];
      if (!memo.lastSuccessful) return false;
      return (now - memo.lastSuccessful) <= options.maxAge;
    });
  debug('after filtering unsuccessful with %d', results.length);
  results = results
    .filter(function (proxy) { // filter out bad latency
      var memo = self.proxies[proxy];
      if (!memo.latency) return false;
      return memo.latency < options.maxLatency;
    });
  debug('after filtering latency with %d', results.length);
  return results
    .sort(function (p1, p2) { // sort by latency
      var memo1 = self.proxies[p1];
      var memo2 = self.proxies[p2];
      // if we've had a failure since we last tested
      // return the other one
      if (memo1.lastSuccessful < memo1.lastTested) return 1;
      if (memo2.lastSuccessful < memo2.lastTested) return -1;
      // sort by latency
      if (memo1.latency === memo2.latency) return 0;
      else if (memo1.latency < memo2.latency) return -1;
      else return 1;
    });
};

/**
 *  sort all proxies we've seen according to latency and success.
 */
Proxies.prototype.testSort = function () {
  var self = this;
  return Object.keys(this.proxies).sort(function (p1, p2) {
    var memo1 = self.proxies[p1];
    var memo2 = self.proxies[p2];

    // blacklist - if either is blacklisted use the other one
    if (isBlacklisted(memo1)) return 1;
    if (isBlacklisted(memo2)) return -1;

    var success1 = memo1.lastTested && memo1.lastSuccessful;
    var success2 = memo2.lastTested && memo2.lastSuccessful;
    if (success1 && success2) {
      // if we've had a failure since we last tested
      // return the other one
      if (memo1.lastSuccessful < memo1.lastTested) return 1;
      if (memo2.lastSuccessful < memo2.lastTested) return -1;
      // both were successful sort by latency
      if (memo1.latency === memo2.latency) return 0;
      else if (memo1.latency < memo2.latency) return -1;
      else return 1;
    } else if (success1) {
      return -1;
    } else if (success2) {
      return 1;
    } else if (memo1.lastTested && memo2.lastTested) {
      // both were tested and failed sort by time since tested
      // favoring older ones.
      return memo1.lastTested - memo2.lastTested;
    } else if (memo2.lastTested) {
      // prefer memo1 since it is untested
      return -1;
    } else if (memo1.lastTested) {
      return 1;
    } else {
      // neither has been tested - don't know
      return 0;
    }
  });
};

// let users notify us of failed proxy calls so we can prefer others.
Proxies.prototype.update = function(proxy, successful) {
  var memo = this.proxies[proxy];
  if (memo) {
    memo.lastTested = Date.now();
    if (successful) {
      memo.lastSuccessful = memo.lastTested;
    }
  }
};

// let users notify us of failed proxy calls so we can prefer others.
Proxies.prototype.blacklist = function(proxy, time, testNow) {
  var memo = this.proxies[proxy];
  if (memo) {
    if (time === true) {
      // permanently banned
      memo.blacklist = true;
    } else if (time > 0) {
      // some time in the future;
      var now = testNow || Date.now();
      memo.blacklist = now + time;
    }
  }
};

/**
 * Get the proxies sorted by latency.
 *
 * @param {Object} options
 * @return {Array|String}
 */

Proxies.prototype.get = function (options, callback) {
  var self = this;
  if (typeof options === 'function') {
    callback = options;
    options = {};
  }

  var callbackExecuted = false;
  var timeout;
  if (this.ready) process.nextTick(next);
  else {
    if (options.timeout) {
      timeout = setTimeout(next, options.timeout);
    }
    this.once('ready', next);
  }

  function next () {
    if (!callbackExecuted) {
      clearTimeout(timeout);
      callbackExecuted = true;
      callback(null, self.filter(options));
    }
  }
};

function isBlacklisted(memo, testTime) {
  if (memo.blacklist === true) {
    // permanently blacklisted
    return true;
  } else if (typeof memo.blacklist === 'number' &&
    (new Date(memo.blacklist)) > (testTime || Date.now()) ) {
    // blacklisted for the future
    return true;
  }
  return false;
}
