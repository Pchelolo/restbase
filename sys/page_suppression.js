"use strict";

var P   = require('bluebird');
var URI = require('swagger-router').URI;
var rbUtil = require('../lib/rbUtil.js');
var uuid = require('cassandra-uuid').TimeUuid;

/**
 * Revision suppression check service.
 *
 * @param {Object} options service options.
 * @constructor
 */
function PageSuppressionService(options) {
    this.options = options;
    this.log = options.log || function() { };
}

/**
 * The name of the suppression table
 * @type {string}
 * @const
 */
PageSuppressionService.prototype.tableName = 'page_suppressions';

/**
 * Returns the suppression table URI for a given domain
 * @param {string} domain the domain
 * @returns {URI} suppression table URI
 */
PageSuppressionService.prototype.tableURI = function(domain) {
    return new URI([domain, 'sys', 'table', this.tableName, '']);
};
/**
 * Suppression table schema
 *
 * @type {Object}
 * @const
 */
PageSuppressionService.prototype.tableSchema = function() {
    return {
        table: this.tableName,
        version: 1,
        attributes: {
            title: 'string',
            rev: 'int',
            sha1hidden: 'boolean',
            texthidden: 'boolean',
            userhidden: 'boolean',
            commenthidden: 'boolean',
            page_deleted: 'timeuuid'
        },
        index: [
            { attribute: 'title', type: 'hash' },
            { attribute: 'rev', type: 'range', order: 'desc' },
            { attribute: 'page_deleted', type: 'static' }
        ]
    };
};

PageSuppressionService.prototype.getRestriction = function(restbase, req) {
    var self = this;
    var rp = req.params;
    var  attributes =  { title: rp.title };
    if (rp.revision) {
        attributes.rev = rp.revision;
    }
    return restbase.get({
        uri: self.tableURI(rp.domain),
        body: {
            table: self.tableName,
            attributes: attributes,
            limit: 1
        }
    })
    .catch({ status: 404 }, function() { return { status: 200 }; });
};

PageSuppressionService.prototype.storeRestriction = function(restbase, req) {
    var self = this;
    var rp = req.params;
    var restrictions = req.body;
    if (restrictions && restrictions.length) {
        return restbase.put({
            uri: self.tableURI(rp.domain),
            body: {
                table: self.tableName,
                attributes: {
                    title: rp.title,
                    rev: rp.revision,
                    sha1hidden: restrictions.indexOf('sha1hidden') >= 0,
                    texthidden: restrictions.indexOf('texthidden') >= 0,
                    userhidden: restrictions.indexOf('userhidden') >= 0,
                    commenthidden: restrictions.indexOf('commenthidden') >= 0
                }
            }
        });
    }
    return P.resolve({ status: 200 });
};

PageSuppressionService.prototype.storePageDeletion = function(restbase, req) {
    var self = this;
    var rp = req.params;
    return self.getRestriction(restbase, req)
    .then(function(res) {
        var restriction = res.body && res.body.items && res.body.items.length && res.body.items[0];
        if (restriction) {
            restriction.page_deleted = restriction.page_deleted || [];
            restriction.page_deleted.push(rp.tid);
        } else {
            restriction = {
                title: rp.title,
                rev: rp.revision,
                sha1hidden: false,
                texthidden: false,
                userhidden: false,
                commenthidden: false,
                page_deleted: rp.tid
            };
        }
        return restbase.put({
            uri: self.tableURI(rp.domain),
            body: {
                table: self.tableName,
                attributes: restriction
            }
        });
    });
};


module.exports = function(options) {
    var am = new PageSuppressionService(options);
    return {
        spec: {
            paths: {
                '/restriction/{title}{/revision}': {
                    get: {
                        operationId: 'getRestriction'
                    },
                    put: {
                        operationId: 'storeRestriction'
                    }
                },
                '/deletion/{title}/{revision}/{tid}': {
                    put: {
                        operationId: 'storePageDeletion'
                    }
                }
            }
        },
        operations: {
            getRestriction: am.getRestriction.bind(am),
            storeRestriction: am.storeRestriction.bind(am),
            storePageDeletion: am.storePageDeletion.bind(am)
        },
        resources: [
            {
                uri: '/{domain}/sys/table/' + am.tableName,
                body: am.tableSchema()
            }
        ]
    };
};

