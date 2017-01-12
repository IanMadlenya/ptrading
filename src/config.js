// config.js
/* 
 *  Copyright (c) 2016-2017 James Leigh, Some Rights Reserved
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
const fs = require('fs');
const path = require('path');
const process = require('process');
const commander = require('commander');
const options = commander.options;
const commander_emit = commander.Command.prototype.emit.bind(commander);

var session = {};
var listeners = [];
var defaults = _.extend({
    prefix: path.resolve(process.argv[1], '../..')
}, loadConfigFile(path.resolve(__dirname, '../etc/ptrading.json')));
var stored = _.extend({}, defaults, loadConfigFile(path.resolve(defaults.prefix, 'etc/ptrading.json')));

var config = module.exports = function(name, value) {
    if (_.isUndefined(value)) {
        var jpath = _.isArray(name) ? name : _.isUndefined(name) ? [] : name.split('.');
        return get(merge({}, session, config.opts(),
            readConfigFile(_.has(session, 'config') ? session.config : commander.config),
            stored
        ), jpath);
    } else {
        config.session(name, value);
    }
};

config.configFilename = function() {
    return config('config') || path.resolve(config('prefix'), 'etc/ptrading.json');
};

config.opts = function() {
    return options.reduce((result, opt) => {
        var name = opt.name();
        var prop = name.replace('-', '_');
        var key = name.split('-').reduce((str, word) => {
            return str + word[0].toUpperCase() + word.slice(1);
        });
        result[prop] = name === 'version' ? commander._version : commander[key];
        return result;
    }, {});
}

config.session = function(name, value) {
    var jpath = _.isArray(name) ? name : _.isUndefined(name) ? [] : name.split('.');
    if (_.isUndefined(value)) {
        return get(session, jpath);
    } else if (assign(session, jpath, value)) {
        listeners.forEach(listener => listener(name, value));
    }
};

config.store = function(name, value) {
    var jpath = _.isArray(name) ? name : name.split('.');
    if (assign(session, jpath, _.isUndefined(value) ? null : value)) {
        listeners.forEach(listener => listener(name, value));
    }
    var filename = config.configFilename();
    var json = loadConfigFile(filename);
    if (assign(json, jpath, value))
        writeConfigFile(filename, json);
};

config.unset = function(name) {
    var jpath = _.isArray(name) ? name : name.split('.');
    var value = get(defaults, jpath);
    if (assign(session, jpath, value || null)) {
        listeners.forEach(listener => listener(name, value || null));
    }
    if (jpath.length == 1 && config.opts()[_.first(jpath)])
        commander_emit(_.first(jpath), value);
    var filename = config.configFilename();
    var json = loadConfigFile(filename);
    if (unset(json, jpath))
        writeConfigFile(filename, json);
};

config.addListener = function(fn) {
    listeners.push(fn);
};

config.removeListener = function(fn) {
    var idx = listeners.indexOf(fn);
    if (idx >= 0)
        listeners.splice(idx, 1);
};

function get(object, jpath) {
    if (_.isEmpty(jpath)) return object;
    var initial = _.initial(jpath);
    var last = _.last(jpath);
    var cfg = get(object, initial);
    return _.property(last)(cfg);
};

function merge(obj) {
    var length = arguments.length;
    if (length < 2 || obj == null) return obj;
    for (var index = 1; index < length; index++) {
        var source = arguments[index],
        keys = _.allKeys(source),
        l = keys.length;
        for (var i = 0; i < l; i++) {
            var key = keys[i];
            if (obj[key] === void 0)
                obj[key] = source[key];
            else if (_.isObject(obj[key]) && !_.isArray(obj[key]))
                obj[key] = merge({}, obj[key], source[key]);
        }
    }
    return obj;
};

var readConfigFile = _.memoize(function(/* filenames */) {
    if (_.isEmpty(arguments)) return {};
    var filename = _.first(arguments);
    if (filename) return loadConfigFile(filename);
    return readConfigFile.apply(this, _.rest(arguments));
});

function loadConfigFile(filename) {
    try {
        fs.accessSync(filename, fs.R_OK);
        return JSON.parse(fs.readFileSync(filename, 'utf-8'));
    } catch(e) {
        return {};
    }
}

function writeConfigFile(filename, json) {
    var dirname = path.dirname(filename);
    try {
        fs.accessSync(dirname, fs.F_OK);
    } catch(e) {
        mkdirp(dirname);
    }
    fs.writeFileSync(filename, JSON.stringify(json, null, '  ') + '\n');
}

function mkdirp(dirname) {
    var parent = path.dirname(dirname);
    try {
        fs.accessSync(parent, fs.F_OK);
    } catch(e) {
        if (parent != dirname) mkdirp(parent);
    }
    fs.mkdirSync(dirname);
}

function assign(obj, path, value) {
    var prop = _.first(path);
    if (path.length == 1) {
        try {
            return obj[prop] != value;
        } finally {
            obj[prop] = value;
        }
    } else if (_.isObject(obj[prop])) {
        return assign(obj[prop], _.rest(path), value);
    } else {
        obj[prop] = {};
        return assign(obj[prop], _.rest(path), value);
    }
}

function unset(obj, path) {
    if (_.isUndefined(obj) || !path.length) {
        return false;
    } else if (path.length == 1) {
        if (!_.has(obj, path)) return false;
        delete obj[path];
        return true;
    } else {
        return unset(obj[_.first(path)], _.rest(path));
    }
}