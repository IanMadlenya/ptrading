// quoting-functions.js
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
const statkit = require("statkit");
const Parser = require('./parser.js');
const common = require('./common-functions.js');
const config = require('./config.js');
const expect = require('chai').expect;

/**
 * These functions operate of an array of securities at the same point in time.
 */
module.exports = function(expr, name, args, temporal, quote, dataset, options) {
    if (functions[name])
        return functions[name].apply(this, [temporal, quote, dataset, options, expr].concat(args));
    else if (module.exports.has(name))
        return functions['symbol.exchange'].apply(this, [temporal, quote, dataset, options, expr]);
};

module.exports.has = function(name) {
    var exchanges = _.keys(config('exchanges'));
    if (functions[name]) return true;
    else if (!name || !~name.indexOf('.')) return false;
    else return _.contains(exchanges, name.substring(name.indexOf('.')+1));
};

var functions = module.exports.functions = {
    'symbol.exchange': _.extend((temporal, quote, dataset, options, expr) => {
        var args = Parser({
            constant(value) {
                return [value];
            },
            variable(name) {
                return [name];
            },
            expression(expr, name, args) {
                return [expr].concat(args.map(_.first));
            }
        }).parse(expr);
        if (!args || args.length != 2) throw Error("Unrecongized quote call: " + expr);
        var name = args[0].substring(0, args[0].indexOf('('));
        var expression = args[1];
        expect(name).to.match(/^\S+\.\w+$/);
        var begin = _.first(_.pluck(_.map(dataset, _.first), temporal).sort());
        var end = _.last(_.pluck(_.map(dataset, _.last), temporal).sort());
        var symbol = name.substring(0, name.lastIndexOf('.'));
        var exchange = name.substring(name.lastIndexOf('.')+1);
        var last = _.compose(_.last, _.values, _.last);
        return quote({
            symbol: symbol,
            exchange: exchange,
            variables: '',
            columns: temporal + ',' + expression,
            pad_begin: 1,
            begin: begin,
            end: end
        }).then(data => positions => {
            var idx = _.sortedIndex(data, last(positions), temporal);
            if (idx >= data.length || idx && data[idx][temporal] > last(positions)[temporal]) idx--;
            return data[idx][expression];
        });
    }, {
        args: "expression",
        description: "Retrieves external security data that is used in an expression."
    }),
    MAXCORREL: _.extend((temporal, quote, dataset, options, expr, duration, expression, criteria) => {
        var n = asPositiveInteger(duration, "MAXCORREL");
        var arg = Parser({
            constant(value) {
                return [value];
            },
            variable(name) {
                return [name];
            },
            expression(expr, name, args) {
                return [expr].concat(args.map(_.first));
            }
        }).parse(expr)[2];
        if (!arg) throw Error("Unrecongized call to MAXCORREL: " + expr);
        var filtered = dataset.filter(data => !_.isEmpty(data));
        if (filtered.length < 2) return positions => 0;
        var condition = parseCriteria(arg, criteria, options);
        var optionset = filtered.map(data => {
            var first = _.first(data);
            var last = _.last(data);
            return _.defaults({
                symbol: first.symbol,
                exchange: first.exchange,
                variables: '',
                columns: temporal + ',' + arg,
                pad_begin: n,
                begin: first.ending,
                end: last.ending,
                pad_end: 0,
                retain: null
            }, options);
        });
        return Promise.all(optionset.map(options => quote(options))).then(dataset => {
            return dataset.reduce((hash, data, i) => {
                var key = optionset[i].symbol + '.' + optionset[i].exchange;
                hash[key] = data;
                return hash;
            }, {});
        }).then(dataset => {
            return historic => {
                var positions = _.last(historic);
                if (_.size(positions) < 2) return 0;
                var matrix = _.keys(_.pick(positions, _.isObject)).map((symbol, i, keys) => {
                    if (i < keys.length -1 && !condition(positions[symbol])) return null;
                    var data = dataset[symbol];
                    if (!data) throw Error("Could not find dataset: " + symbol);
                    var end = _.sortedIndex(data, positions, temporal);
                    if (data[end] && data[end][temporal] == positions[temporal]) end++;
                    return _.pluck(data.slice(Math.max(end - n, 0), end), arg);
                });
                var last = matrix.pop();
                var correlations = _.compact(matrix).map(m => {
                    return statkit.corr(m, last);
                });
                if (!correlations.length) return 0;
                else return _.max(correlations);
            };
        });
    }, {
        args: "duration, expression, [criteria]",
        description: "Maximum correlation coefficient among other securities"
    })
};

function asPositiveInteger(calc, msg) {
    try {
        var n = calc();
        if (n > 0 && _.isFinite(n) && Math.round(n) == n) return n;
    } catch (e) {}
    throw Error("Expected a literal positive interger in " + msg + " not " + n);
}

function parseCriteria(columnName, criteria, options) {
    if (!criteria)
        return _.constant(true);
    if (_.isFunction(criteria))
        return parseCriteria(columnName, criteria(), options);
    if (!_.isString(criteria))
        return parseCriteria(columnName, criteria.toString(), options);
    if (_.contains(['<', '>', '=', '!'], criteria.charAt(0)))
        return parseCriteria(columnName, columnName + criteria, options);
    try {
        var expression = false;
        var parsed = Parser({
            constant(value) {
                return _.constant(value);
            },
            variable(name) {
                return context => _.has(context, name) ? context[name] : options[name];
            },
            expression(expr, name, args) {
                expression = true;
                return common(name, args, options);
            }
        }).parse(criteria);
        if (expression) return parsed;
    } catch(e) {} // not an expression, must be a value
    return context => context[columnName] == criteria;
}
