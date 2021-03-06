// google-client.js
/*
 *  Copyright (c) 2017 James Leigh, Some Rights Reserved
 *
 *  Redistribution and use in source and binary forms, with or without
 *  modification, are permitted provided that the following conditions are met:
 *
 *  1. Redistributions of source code must retain the above copyright notice,
 *  this list of conditions and the following disclaimer.
 *
 *  2. Redistributions in binary form must reproduce the above copyright
 *  notice, this list of conditions and the following disclaimer in the
 *  documentation and/or other materials provided with the distribution.
 *
 *  3. Neither the name of the copyright holder nor the names of its
 *  contributors may be used to endorse or promote products derived from this
 *  software without specific prior written permission.
 *
 *  THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
 *  AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
 *  IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
 *  ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE
 *  LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
 *  CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
 *  SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
 *  INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
 *  CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
 *  ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
 *  POSSIBILITY OF SUCH DAMAGE.
 */

const _ = require('underscore');
const url = require('url');
const moment = require('moment-timezone');
const throttlePromise = require('./throttle.js');
const promiseText = require('./promise-text.js');
const logger = require('./logger.js');
const expect = require('chai').expect;

const historical = "http://www.google.com/finance/historical?q={symbol}&startdate={startdate}&enddate={enddate}&output=csv"
const match = "https://www.google.com/finance/match?matchtype=matchall&q={symbol}";
const info = "http://finance.google.com/finance/info?infotype=infoquoteall&q={symbols}";
const getprices = "http://www.google.com/finance/getprices?q={symbol}&x={exchange}&i={interval}&p=1d&f=d,o,h,l,c,v&df=cpct";

module.exports = function() {
    return {
        close() {},
        lookup: lookupSymbol.bind(this, _.memoize(throttlePromise(listSymbols, 2))),
        fundamental: queue(loadSecurity, 32),
        quote: queue(loadIntradayQuote, 32),
        intraday: loadIntradayTable.bind(this, throttlePromise(promiseText, 1)),
        day: loadTable.bind(this, throttlePromise(promiseText, 1))
    };
};

function loadIntradayTable(get, symbol, interval) {
    expect(symbol).to.be.a('string').and.match(/^\S+:\S+$/);
    var query = {
        symbol: symbol.substring(symbol.indexOf(':')+1),
        exchange: symbol.substring(0, symbol.indexOf(':')),
        interval: interval
    };
    var url = _.keys(query).reduce((url, key) => {
        return url.replace('{' + key + '}', encodeURIComponent(query[key]));
    }, getprices)
    return get(url)
        .then(parseCSV)
        .then(rows => rows.filter(row => row.length > 1).map(row => {
            if (row[0].indexOf('COLUMNS=') === 0) {
                row[0] = row[0].substring('COLUMNS='.length);
            }
            return row;
        }))
        .then(rows2objects);
}

function loadTable(get, symbol, begin, tz) {
    expect(symbol).to.be.a('string').and.match(/^\S+:\S+$/);
    var query = _.extend({
        symbol: symbol
    }, periods(begin, tz));
    var url = _.keys(query).reduce((url, key) => {
        return url.replace('{' + key + '}', encodeURIComponent(query[key]));
    }, historical)
    return get(url)
        .then(parseCSV)
        .then(rows2objects);
}

function periods(begin, tz) {
    expect(tz).to.be.a('string').and.match(/^\S+\/\S+$/);
    var mb = moment.tz(begin, tz);
    if (!mb.isValid()) throw Error("Invalid begin date " + begin);
    var start = mb.startOf('day');
    var end = moment().tz(tz).startOf('day');
    return {
        startdate: start.format('MMM D, Y'),
        enddate: end.format('MMM D, Y')
    };
}

function lookupSymbol(listSymbols, symbol) {
    return listSymbols(match.replace('{symbol}', encodeURIComponent(symbol)));
}

function listSymbols(url) {
    return promiseText(url).then(parseJSON).then(json => json.matches.map(datum => ({
        symbol: datum.t,
        e: datum.e,
        name: datum.n,
        id: datum.id
    })));
}

function parseJSON(text) {
    try {
        return JSON.parse(text);
    } catch (e) {
        return JSON.parse(text.replace('// [','['));
    }
}

function loadSecurity(symbols) {
    var url = info.replace('{symbols}', symbols.map(encodeURIComponent).join(','));
    return promiseText(url).then(parseJSON).then(json => json.map(datum => ({
        symbol: datum.t,
        e: datum.e,
        name: datum.name,
        id: datum.id,
        type: datum.type,
        hi52: datum.hi52,
        lo52: datum.lo52,
        eps: datum.eps,
        beta: datum.beta,
        inst_own: datum.inst_own,
        mc: datum.mc,
        shares: datum.shares
    }))).then(function(list){
        return list.reduce(function(hash, security){
            hash[security.e + ':' + security.symbol] = security;
            return hash;
        }, {});
    }).then(hash => symbols.map(symbol => hash[symbol]));
}

function loadIntradayQuote(symbols) {
    var url = info.replace('{symbols}', symbols.map(encodeURIComponent).join(','));
    return promiseText(url).then(parseJSON).then(list => {
        return list.reduce(function(hash, security){
            hash[security.e + ':' + security.t] = security;
            return hash;
        }, {});
    }).then(hash => symbols.map(symbol => hash[symbol]));
}

function queue(func, batchSize) {
    var context, promise = Promise.resolve();
    var queue = [], listeners = [];

    return function(items) {
        context = this;
        return new Promise(function(resolve, reject) {
            queue = queue.concat(items);
            listeners.push({resolve: resolve, reject: reject});
            promise = promise.then(function(){
                var taken = queue.splice(0, batchSize);
                var notifications = listeners.splice(0, batchSize);
                if (!taken.length) return undefined;
                return func.call(context, taken).then(function(result) {
                    for (var i=0; i<notifications.length; i++) {
                        notifications[i].resolve(result[i]);
                    }
                }, function(error) {
                    for (var i=0; i<notifications.length; i++) {
                        notifications[i].reject(error);
                    }
                });
            });
        });
    };
}

function parseCSV(text) {
    if (!text) return [];
    return _.compact(text.split(/\r?\n/)).map(function(line) {
        if (line.indexOf(',') < 0) return [line];
        var m;
        var row = [];
        var regex = /(?:,|^)(?:"([^"]*)"|([^",]*))/g;
        if (line.charAt(0) == ',') {
            row.push('');
        }
        while (m = regex.exec(line)) {
            var string = m[1] || m[2] || '';
            row.push(string.trim());
        }
        return row;
    });
}

function rows2objects(rows) {
    var headers = [];
    return rows.reduce(function(points, row){
        if (headers.length && headers.length == row.length) {
            points.push(_.object(headers, row));
        } else {
            headers = row;
        }
        return points;
    }, []);
}
