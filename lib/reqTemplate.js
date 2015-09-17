"use strict";

var URI = require('swagger-router').URI;
var TAssembly = require('tassembly');
var url = require('url');
var expressionCompiler = require('template-expression-compiler');
require('core-js/shim');

var globalMethods = {
    default: function(val, defVal) {
        return val || defVal;
    },
    merge: function(destination, source) {
        destination = destination || {};
        source = source || {};

        if (typeof destination !== 'object' || typeof source !== 'object') {
            throw new Error('Illegal spec. Merge source and destination must be objects');
        }

        var result = Object.assign({}, destination);
        Object.keys(source).forEach(function(keyName) {
            if (result[keyName] === undefined) {
                result[keyName] = source[keyName];
            }
        });
        return result;
    }
};

/**
 * Creates a function that sets a value at the path
 * and initializes all objects/arrays along the path.
 *
 * @param {string} path the path within an object/array separated
 *        with dots {e.g. test.body.a.b.c}
 * @param {object} spec spec element that contains provided path
 * @returns {Function} the function to set a value at path
 *          and initialize object along the path if needed
 * @private
 */
function _setAtPath(path, spec) {
    var pathArr = path.split('.');
    var refArr = [];
    var subspec = spec;
    var code;

    for (var idx = 0; idx < pathArr.length; idx++) {
        var curRef = {};
        curRef.ref = Array.isArray(subspec) ? '[' + pathArr[idx] + ']' : '["' + pathArr[idx] + '"]';
        subspec = subspec[pathArr[idx]];
        curRef.initializer = Array.isArray(subspec) ? '[]' : '{}';
        refArr.push(curRef);
    }

    code = 'if (value !== undefined) {\n';
    for (var i = 1; i < refArr.length; i++) {
        var ref = refArr.slice(0, i).map(function(elem) {
            return elem.ref;
        }).join('');
        code += 'obj' + ref + ' = obj' + ref + ' || ' + refArr[i - 1].initializer + ';\n';
    }
    code += 'obj' + refArr.map(function(elem) {
        return elem.ref;
    }).join('') + ' = value;\n';
    code += '}';

    /* jslint evil: true */
    return new Function('obj', 'value', code);
}

function splitAndPrepareTAsseblyTemplate(templateSpec) {
    var result = [];
    var templateNest = 0;
    var startIndex = 0;
    var currentTemplate;
    for (var index = 0; index < templateSpec.length; index++) {
        if (templateSpec[index] === '{') {
            if (templateNest === 0) { // We are either entering a new template
                if (startIndex !== index) {
                    result.push(templateSpec.substring(startIndex, index));
                }
                startIndex = index + 1;
            } // Or entering an object literal
            templateNest++;
        } else if (templateSpec[index] === '}') {
            if (templateNest === 1) { // The current template is finished
                currentTemplate = templateSpec.substring(startIndex, index);
                result.push(['raw', expressionCompiler.parse(currentTemplate)]);
                startIndex = index + 1;
            } // Or and object literal finished
            templateNest--;
        }
    }
    if (startIndex !== index) {
        result.push(templateSpec.substring(startIndex));
    }
    if (templateNest > 0) {
        throw new Error('Illegal template, unbalanced curly braces');
    }
    return result;
}

/**
 * Compiles a template into a function
 *
 * @param templateSpec template string (e.g. '{$.request.body.a}')
 * @param reqPart part of the request to lookup local properties in (e.g. headers, body etc.)
 * @param setValue callback for a result of template evaluation
 * @returns {Function} a template resolver for the provided template
 */
function compileTemplate(templateSpec, setValue, reqPart) {
    var res;
    var template = splitAndPrepareTAsseblyTemplate(templateSpec);
    var callback = function(bit) {
        if (res === undefined) {
            res = bit;
        } else {
            res += '' + bit;
        }
    };
    var errorHandler = function() { return undefined; };

    var resolveTemplate = TAssembly.compile(template, {
        nestedTemplate: true,
        cb: callback,
        errorHandler: errorHandler
    });
    var options = {
        errorHandler: errorHandler,
        cb: callback,
        globals: {
            default: function(val, defVal) {
                return val || defVal;
            },
            merge: function(destination, source) {
                destination = destination || {};
                source = source || {};

                if (typeof destination !== 'object' || typeof source !== 'object') {
                    throw new Error('Illegal spec. Merge source and destination must be objects');
                }

                var result = Object.assign({}, destination);
                Object.keys(source).forEach(function(keyName) {
                    if (result[keyName] === undefined) {
                        result[keyName] = source[keyName];
                    }
                });
                return result;
            }
        }
    };

    return function(newReq, context) {
        var extendedContext = {
            rc: null,
            rm: context,
            m: context.request[reqPart],
            pms: [context.request[reqPart]],
            g: options.globals,
            options: options,
            cb: options.cb
        };
        extendedContext.rc = extendedContext;

        resolveTemplate(extendedContext);
        var value = res;
        res = undefined; // Unitialize res to prepare to the next request
        setValue(newReq, value);
    };
}

/**
 *  Constructs a list of resolvers for all templates in a request spec
 *
 * @param origSpec original full spec
 * @param subspec a request spec or subspec for a part of request
 * @param reqPart name of request part (e.g. headers, body, query)
 * @param path path to the current subspec within a full spec
 * @returns {Array} an array of template resolvers for every template found in the spec.
 *          Resolvers are functions with (newRequest, request) arguments
 *          that modify newRequest param.
 * @private
 */
function _createTemplateResolvers(origSpec, subspec, reqPart, path) {

    /**
     * Makes an array of resolvers for every template found within a template spec object.
     *
     * @param templateSpec A subspec of an original request spec.
     * @param templatePath A path to the current subspec
     * @returns {Array} and array of resolvers for each template found in the subspec
     */
    function makeResolvers(templateSpec, templatePath) {
        var setValue = _setAtPath(templatePath, origSpec);
        if (templateSpec instanceof Object) {
            return _createTemplateResolvers(origSpec, templateSpec, reqPart, templatePath);
        } else if (/\{[^}]+}/.test(templateSpec)) {
            return [compileTemplate(templateSpec, setValue, reqPart)];
        } else {
            return [function(newReq) {
                setValue(newReq, templateSpec);
            }];
        }
    }

    if (!path) {
        path = reqPart;
    }
    if (subspec instanceof Object) {
        return Object.keys(subspec).map(function(key) {
            return makeResolvers(subspec[key], path + '.' + key);
        }).reduce(function(arr1, arr2) {
            return arr1.concat(arr2);
        });
    } else {
        return makeResolvers(subspec, path);
    }
}

/**
 * Creates a template resolver functuons for URI part of the spec
 * @param {object} spec a root request spec object
 * @returns {Function} a template resolver which should be applied to resolve URI
 */
function createURIResolver(spec) {
    if (/^\{[^\{}]+}$/.test(spec.uri) || /\{\$\$?\..+}/.test(spec.uri)) {
        var tassemblyTemplate = splitAndPrepareTAsseblyTemplate(spec.uri);
        var resolver = compileTAssembly(tassemblyTemplate, 'params');
        return function(context) {
            var value = resolver(context);
            if (value.constructor !== URI) {
                value = new URI(value, {}, false);
            }
            return value;
        };
    } else if (/^(?:https?:\/\/)?\{[^\/]+}\//.test(spec.uri)) {
        // The host is templated - replace it with TAssembly and use URI.expand for path templates
        var hostTemplate = /^((?:https?:\/\/)?\{[^\/]+}\/)/.exec(spec.uri)[1];
        var hostTassembly = splitAndPrepareTAsseblyTemplate(hostTemplate);
        var hostResolver = compileTAssembly(hostTassembly, 'params');
        var path = spec.uri.substr(hostTemplate.length);
        var pathTemplate = new URI('/' + path, {}, true);
        return function(context) {
            var newHost = hostResolver(context);
            var newUri = pathTemplate.expand(context.request.params);
            newUri.urlObj = url.parse(newHost + path);
            return newUri;
        };
    } else {
        return (function(uri) {
            var uriTemplate = new URI(uri, {}, true);
            return function(context) {
                return uriTemplate.expand(context.request.params);
            }
        })(spec.uri);
    }
}

function compileTAssembly(template, reqPart) {
    var res;
    var callback = function(bit) {
        if (res === undefined) {
            res = bit;
        } else {
            res += '' + bit;
        }
    };
    var errorHandler = function() {
        return undefined;
    };

    var resolveTemplate = TAssembly.compile(template, {
        nestedTemplate: true,
        cb: callback,
        errorHandler: errorHandler
    });
    var options = {
        errorHandler: errorHandler,
        cb: callback
    };
    Object.assign(options, globalMethods);

    return function(context) {
        var extendedContext = {
            rc: null,
            rm: context,
            m: context.request[reqPart],
            pms: [context.request[reqPart]],
            g: options.globals,
            options: options,
            cb: options.cb
        };
        extendedContext.rc = extendedContext;

        resolveTemplate(extendedContext);
        var value = res;
        res = undefined; // Unitialize res to prepare to the next request
        return value;
    };
}

function replaceComplexTemplates(rootSpec, reqPart) {

    function doReplace(parentSpec, subSpec, path) {
        var replacementFunctions = {};
        if (subSpec instanceof Object) {
            Object.keys(subSpec).forEach(function(key) {
                replacementFunctions = Object.assign(replacementFunctions,
                    doReplace(subSpec, subSpec[key], path.concat([key])));
            });
        } else if (/\{[^}]+}/.test(subSpec)) {
            // There is a template, now we need to check it for special stuff we replace
            var tAssemblyTemplates = splitAndPrepareTAsseblyTemplate(subSpec);
            if (tAssemblyTemplates.length > 1 // This is a string with partial templates
                    || tAssemblyTemplates.some(function(partialTemplate) {
                return Array.isArray(partialTemplate)
                    && partialTemplate.length > 1
                    && /(?:[^\w-]|^)m[\.\[]/.test(partialTemplate[1]);
            })) {
                // Compile a function
                var resolver = compileTAssembly(tAssemblyTemplates, reqPart);
                // Replace the complex template with a function call
                parentSpec[path[path.length - 1]] = '$$.' + path.join('_') + '($)';
                // And add the function to our globals to make it resolvable
                replacementFunctions[path.join('_')] = resolver;
            } else {
                // If it's a simple and resolvable function - just remove the braces
                parentSpec[path[path.length - 1]] = subSpec.substring(1, subSpec.length - 1);
            }
        } else {
            // If it's not templated - wrap it into braces to let tassembly add it
            parentSpec[path[path.length - 1]] = "'" + subSpec + "'";
        }
        return replacementFunctions;
    }

    return doReplace(rootSpec, rootSpec[reqPart], [ reqPart ]);
}

/**
 * Creates and compiles a new Template object using the provided JSON spec
 *
 * @param spec  Request spec provided in a Swagger spec. This is a JSON object
 *              containing all request parts templated in the form of {a.b.c}.
 *              Only fields in the spec would be included in the resulting request,
 *              fields that couldn't be resolved from original request would be ignored.
 */
function Template(spec) {
    spec = Object.assign({}, spec);
   /* var self = this;
    self.resolvers = [];
    if (typeof spec === 'string') {
        self.resolvers.push(compileTemplate(spec, function(newReq, val) {
            newReq.val = val;
        }));

        self._eval = function(context) {
            var result = {};
            this.resolvers.forEach(function(resolver) {
                resolver(result, context);
            });
            return result.val;
        };
    } else {
        Object.keys(spec).forEach(function(reqPart) {
            var setValue;
            if (reqPart === 'uri') {
                self.resolvers.push(createURIResolver(spec));
            } else if (reqPart === 'method') {
                setValue = _setAtPath('method', spec);
                self.resolvers.push(function(newReq) {
                    setValue(newReq, spec.method);
                });
            } else if (spec[reqPart]) {
                self.resolvers = self.resolvers.concat(
                _createTemplateResolvers(spec, spec[reqPart], reqPart));
            }
        });

        self._eval = function(context) {
            var newReq = {method: context.request.method};
            this.resolvers.forEach(function(resolver) {
                resolver(newReq, context);
            });
            return newReq;
        };
    }*/
    var self = this;
    var globals = Object.assign({}, globalMethods);
    Object.keys(spec).forEach(function(reqPart) {
        if (reqPart === 'uri') {
            globals.uri = createURIResolver(spec);
            spec.uri = '$$.uri($)';
        } else if (reqPart === 'method') {
            var specMethod = spec.method;
            globals.method = function(context) {
                return specMethod || context.request.method || 'get';
            };
            spec.method = '$$.method($)';
        } else {
            Object.assign(globals, replaceComplexTemplates(spec, reqPart));
        }
    });

    var completeTAssemblyTemplate = expressionCompiler.parse(spec);
    var callback = function(bit) {
        if (res === undefined) {
            res = bit;
        } else {
            res += '' + bit;
        }
    };

    var resolver = TAssembly.compile([['raw', completeTAssemblyTemplate]], {
        globals: globals,
        cb: callback,
        errorHandler: function() { return undefined; }
    });
    var res;
    self._eval = function(context) {
        resolver(context);
        var value = res;
        res = undefined; // Unitialize res to prepare to the next request
        return value;
    }
}

/**
 * Evaluates the compiled template using the provided request
 *
 * @param {object} context a context object where to take data from
 * @returns {object} a new request object with all templates either substituted or dropped
 */
Template.prototype.eval = function(context) {
    return this._eval(context);
};

module.exports = Template;

var requestTemplate = {
    uri: '/{domain}/test',
    method: 'post',
    headers: {
        'name-with-dashes': '{name-with-dashes}',
        'global-header': '{$.request.params.domain}',
        'added-string-header': 'added-string-header'
    },
    query: {
        'simple': '{simple}',
        'added': 'addedValue',
        'global': '{$.request.headers.name-with-dashes}'
    },
    body: {
        'object': '{object}',
        'global': '{$.request.params.domain}',
        'added': 'addedValue',
        'nested': {
            'one': {
                'two': {
                    'tree': '{a.b.c}'
                }
            }
        },
        'field_name_with_underscore': '{field_name_with_underscore}',
        'additional_context_field': '{$.additional_context.field}',
        'string_templated': 'test {field_name_with_underscore}'
    }
};
var testRequest = {
    params: {
        'domain': 'testDomain'
    },
    method: 'get',
    headers: {
        'name-with-dashes': 'name-with-dashes-value',
        'removed-header': 'this-will-be-removed'
    },
    query: {
        'simple': 'simpleValue',
        'removed': 'this-will-be-removed'
    },
    body: {
        'object': {
            'testField': 'testValue'
        },
        'removed': {
            'field': 'this-will-be-removed'
        },
        'a': {
            'b': {
                'c': 'nestedValue'
            }
        },
        'field_name_with_underscore': 'field_value_with_underscore'
    }
};

var result = new Template(requestTemplate);
var time = new Date();
for(var i = 0; i < 100000; i++) {
result.eval({
        request: testRequest,
        additional_context: {
            field: 'additional_test_value'
        }
    });
}
console.log(new Date() - time);