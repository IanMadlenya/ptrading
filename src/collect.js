// collect.js
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
const moment = require('moment-timezone');
const List = require('./list.js');
const Parser = require('./parser.js');
const common = require('./common-functions.js');
const aggregate = require('./aggregate-functions.js');
const config = require('./config.js');
const logger = require('./logger.js');
const like = require('./like.js');
const expect = require('chai').use(like).expect;

module.exports = function(quote) {
    var temporal = 'DATETIME(ending)';
    var exchanges = _.keys(config('exchanges'));
    return _.extend(function(options) {
        expect(options).to.have.property('portfolio');
        var portfolio = getPortfolio(options);
        var columns = options.columns || 'symbol';
        var names = getColumnNames(columns);
        var retainColumns = getNeededColumns(exchanges, options.retain);
        var precedenceColumns = getNeededColumns(exchanges, options.precedence);
        var allColumns = _.uniq(_.compact(_.flatten([
            columns,
            'symbol',
            'exchange',
            'ending',
            temporal,
            retainColumns,
            precedenceColumns
        ], true))).join(',');
        var precedence = getPrecedence(options.precedence, precedenceColumns);
        return Promise.all(portfolio.map(security => {
            return quote(_.defaults({
                columns: allColumns
            }, security, options));
        })).then(dataset => {
            return promiseRetain(exchanges, quote, dataset, temporal, options).then(retain => {
                return collectDataset(dataset, temporal, names, retain, precedence);
            });
        });
    }, {
        close() {}
    });
};

function getPortfolio(options) {
    return options.portfolio.split(/\s*,\s*/).map(symbolExchange => {
        var m = symbolExchange.match(/^(\S+)\W(\w+)$/);
        if (!m) throw Error("Unexpected symbol/exchange: " + symbolExchange);
        return {
            symbol: m[1],
            exchange: m[2]
        };
    });
}

function getColumnNames(columns) {
    return _.keys(Parser().parseColumnsMap(columns));
}

function getNeededColumns(exchanges, expr) {
    if (!expr) return [];
    return _.uniq(_.flatten(_.values(Parser({
        constant(value) {
            return null;
        },
        variable(name) {
            return name;
        },
        expression(expr, name, args) {
            var external = isInstrument(exchanges, name);
            var order = name == 'DESC' || name == 'ASC';
            var fn = aggregate.functions[name];
            var agg = _.some(args, _.isArray);
            if (external) return [];
            else if (!order && !fn && !agg) return expr;
            else return _.flatten(_.compact(args), true);
        }
    }).parseColumnsMap(expr)), true));
}

function getPrecedence(expr, cached) {
    if (!expr) return [];
    else return _.values(Parser({
        constant(value) {
            return {};
        },
        variable(name) {
            return {by: name};
        },
        expression(expr, name, args) {
            if (name == 'DESC') return {desc: true, by: _.first(args).by};
            else if (name == 'ASC') return {desc: false, by:  _.first(args).by};
            else if (_.contains(cached, expr)) return {by: expr};
            else if (!aggregate.functions[name]) return {};
            else throw Error("Aggregate functions cannot be used here: " + expr);
        }
    }).parseColumnsMap(expr));
}

function collectDataset(dataset, temporal, columns, retain, precedence) {
    return reduceInterval(dataset, temporal, (result, points) => {
        var positions = precedence.reduceRight((points, o) => {
            var positions = o.by ? _.sortBy(points, o.by) : points;
            if (o.desc) positions.reverse();
            return positions;
        }, points);
        var accepted = positions.reduce((accepted, point) => {
            var pending = accepted.concat([point]);
            if (retain && retain(pending)) return pending;
            else return accepted;
        }, []);
        return result.concat(accepted);
    }, []).map(row => {
        return _.object(columns, columns.map(name => row[name]));
    });
}

function promiseRetain(exchanges, quote, dataset, temporal, options) {
    var expr = options.retain;
    var cached = getNeededColumns(exchanges, expr);
    var external = promiseExternal.bind(this, quote, dataset, temporal);
    if (!expr) return Promise.resolve(_.constant(true));
    else return Promise.resolve(Parser({
        constant(value) {
            return _.extend(positions => value, {
                expression: value
            });
        },
        variable(name) {
            return _.extend(_.compose(_.property(name), _.last), {
                expression: name
            });
        },
        expression(expr, name, args) {
            if (_.contains(cached, expr)) return _.extend(_.compose(_.property(expr), _.last), {
                expression: expr
            });
            return Promise.all(args).then(args => {
                var fn = common(name, args, options) ||
                    aggregate(name, args, quote, dataset, options);
                var instrument = isInstrument(exchanges, name);
                if (fn) return fn;
                else if (instrument) return external(name, _.first(args).expression);
                else return () => {
                    throw Error("Only common and aggregate functions can be used here: " + expr);
                };
            }).then(fn => _.extend(fn, {expression: expr}));
        }
    }).parse(expr));
}

function isInstrument(exchanges, name) {
    if (!name || !~name.indexOf('.')) return false;
    else return _.contains(exchanges, name.substring(name.indexOf('.')+1));
}

function reduceInterval(data, temporal, cb, memo) {
    var lists = data.map(ar => List.from(ar));
    while (lists.some(list => list.length)) {
        var ending = _.first(_.compact(_.pluck(lists.map(list => list.first()), temporal)).sort());
        var points = _.compact(lists.map(list => {
            if (list.length && list.first()[temporal] == ending) return list.shift();
        }));
        memo = cb(memo, points);
    }
    return memo;
}

function promiseExternal(quote, dataset, temporal, name, expr) {
    expect(name).to.match(/^\S+\.\w+$/);
    var begin = _.first(_.pluck(_.map(dataset, _.first), temporal).sort());
    var end = _.last(_.pluck(_.map(dataset, _.last), temporal).sort());
    var symbol = name.substring(0, name.lastIndexOf('.'));
    var exchange = name.substring(name.lastIndexOf('.')+1);
    return quote({
        symbol: symbol,
        exchange: exchange,
        columns: temporal + ',' + expr,
        pad_begin: 1,
        begin: begin,
        end: end
    }).then(data => positions => {
        var idx = _.sortedIndex(data, _.last(positions), temporal);
        if (idx >= data.length || idx && data[idx][temporal] > _.last(positions)[temporal]) idx--;
        return data[idx][expr];
    });
}