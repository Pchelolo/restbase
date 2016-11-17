'use strict';


const P = require('bluebird');
const HyperSwitch = require('hyperswitch');
const uuid = require('cassandra-uuid').TimeUuid;
const mwUtil = require('../lib/mwUtil');
const URI = HyperSwitch.URI;
const HTTPError = HyperSwitch.HTTPError;

const spec = HyperSwitch.utils.loadSpec(`${__dirname}/feed.yaml`);

const DEFAULT_TTL = 3600;

const FEED_URIS = {
    tfa: { uri: ['v1', 'page', 'featured'], date: true },
    mostread: { uri: ['v1', 'page', 'most-read'], date: true },
    image: { uri: ['v1', 'media', 'image', 'featured'], date: true },
    news: { uri: ['v1', 'page', 'news'], date: false }
};

// TODO: need a way to dynamically derive this
const CONTENT_TYPE = 'application/json; charset=utf-8; ' +
    'profile="https://www.mediawiki.org/wiki/Specs/aggregated-feed/0.5.0"';

/**
 * Checks whether the date is today or in the past in UTC-0 timezone
 *
 * @param {Date} date a date to check
 * @return {boolean} true if the date is in the past
 */
function isHistoric(date) {
    const now = new Date();
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    return date < today;
}

/**
 * Safely builds the Date from request parameters
 *
 * @param {Object} rp request parameters object
 * @return {Date} the requested date.
 */
function getDateSafe(rp) {
    try {
        return new Date(Date.UTC(rp.yyyy, rp.mm - 1, rp.dd));
    } catch (err) {
        throw new HTTPError({
            status: 400,
            body: {
                type: 'bad_request',
                description: 'wrong date format specified'
            }
        });
    }
}

/**
 * Converts the date to the bucket key, key the records in the format YYYY-MM-DD
 *
 * @param {Date} date the date to convert
 * @return {string}
 */
function toKey(date) {
    return date.toISOString().split('T').shift();
}

function constructBody(result) {
    const body = {};
    Object.keys(result).forEach((key) => {
        if (result[key].body && Object.keys(result[key].body).length) {
            body[key] = result[key].body;
        }
    });
    return body;
}

/**
 * Verifies that the date parameter is in proper format.
 *
 * @param {Object} req the request to check
 */
function verifyParams(req) {
    const rp = req.params;

    if (!/^2\d\d\d$/.test(rp.yyyy)) {
        throw new HTTPError({
            status: 400,
            body: {
                type: 'bad_request',
                description: 'Invalid yyyy parameter'
            }
        });
    }

    if (!/^\d\d$/.test(rp.mm) || rp.mm === '00' || rp.mm > '12') {
        throw new HTTPError({
            status: 400,
            body: {
                type: 'bad_request',
                description: 'Invalid mm parameter'
            }
        });
    }

    if (!/^\d\d$/.test(rp.dd) || rp.dd === '00' || rp.dd > '31') {
        throw new HTTPError({
            status: 400,
            body: {
                type: 'bad_request',
                description: 'Invalid dd parameter'
            }
        });
    }
}

class Feed {
    constructor(options) {
        this.options = options;
    }

    _makeFeedRequests(parts, hyper, rp, dateArr) {
        const props = {};
        parts.forEach((part) => {
            const def = FEED_URIS[part];
            const uriArray = [this.options.host, rp.domain].concat(def.uri);
            if (def.date) {
                Array.prototype.push.apply(uriArray, dateArr);
            }
            props[part] = hyper.get({
                uri: uriArray.join('/'),
                query: { aggregated: true }
            });
        });
        return P.props(props);
    }

    _assembleResult(result, dateArr) {
        // assemble the final response to be returned
        return {
            status: 200,
            headers: {
                'cache-control': this.options.feed_cache_control,
                // mimic MCS' ETag value
                etag: `${dateArr.join('')}/${uuid.now().toString()}`,
                'content-type': CONTENT_TYPE
            },
            body: constructBody(result)
        };
    }

    aggregated(hyper, req) {
        verifyParams(req);
        const rp = req.params;
        const date = getDateSafe(rp);
        const dateKey = toKey(date);
        const dateArr = dateKey.split('-');
        const populateSummaries = (res) => {
            function fetchSummary(uri) {
                return hyper.get({ uri })
                .then((res) => {
                    res.body.normalizedtitle = res.body.title;
                    res.body.title = res.body.title.replace(/ /g, '_');
                    return res.body;
                })
                // Swallow the error, no need to fail the whole feed
                // request because of one failed summary fetch
                .catchReturn(undefined);
            }

            // TODO: this is temporary code to increase the size of the TFA thumbnail
            if (res.body.tfa && res.body.tfa.$merge && res.body.tfa.$merge.length) {
                const summaryURI = res.body.tfa.$merge[0];
                const title = decodeURIComponent(
                    summaryURI.substr(summaryURI.lastIndexOf('/') + 1));
                const highQualityThumbRequest = hyper.get({
                    method: 'post',
                    uri: new URI([rp.domain, 'sys', 'action', 'query']),
                    body: {
                        prop: 'pageimages',
                        piprop: 'thumbnail',
                        pithumbsize: 640,
                        titles: title
                    }
                });
                return P.join(
                    mwUtil.hydrateResponse(res, fetchSummary),
                    highQualityThumbRequest
                ).then((result) => {
                    const thumbRes = result[1].body;
                    if (thumbRes.items && thumbRes.items.length && thumbRes.items[0].thumbnail) {
                        const newThumb = thumbRes.items[0].thumbnail;
                        newThumb.source = newThumb.source.replace(/^http:/, 'https:');
                        result[0].body.tfa.thumbnail = newThumb;
                    }
                    return result[0];
                });
                // TODO: End of temp code.
            } else {
                return mwUtil.hydrateResponse(res, fetchSummary);
            }
        };
        const getContent = (bucket, forwardCacheControl) => {
            const request = {
                uri: new URI([rp.domain, 'sys', 'key_value', bucket, dateKey])
            };
            if (forwardCacheControl && req.headers && req.headers['cache-control']) {
                request.headers = {
                    'cache-control': req.headers['cache-control']
                };
            }
            return hyper.get(request);
        };
        const storeContent = (res, bucket) => {
            return hyper.put({
                uri: new URI([rp.domain, 'sys', 'key_value', bucket, dateKey]),
                headers: res.headers,
                body: res.body
            });
        };
        const getCurrentContent = () => {
            return getContent('feed.aggregated', true)
            .catch({ status: 404 }, () =>
                // it's a cache miss, so we need to request all
                // of the components and store them
                this._makeFeedRequests(Object.keys(FEED_URIS), hyper, rp, dateArr)
                .then((result) => this._assembleResult(result, dateArr))
                .tap((res) => {
                    // Store async
                    P.join(
                        storeContent(res, 'feed.aggregated'),
                        storeContent(res, 'feed.aggregated.historic')
                    );
                }));
        };
        const getHistoricContent = () => {
            return getContent('feed.aggregated.historic')
            .catch({ status: 404 }, () =>
                // it's a cache miss, so we need to request all
                // of the components and store them (but don't request news)
                this._makeFeedRequests([ 'tfa', 'mostread', 'image' ], hyper, rp, dateArr)
                .then((result) => this._assembleResult(result, dateArr))
                .tap((res) => {
                    // Store async
                    storeContent(res, 'feed.aggregated.historic');
                })
            );
        };
        const contentRequest = isHistoric(date) ? getHistoricContent() : getCurrentContent();
        return contentRequest.then(populateSummaries);
    }
}


module.exports = (options) => {
    options.ttl = options.ttl || DEFAULT_TTL;
    options.feed_cache_control = options.feed_cache_control || 's-maxage=30, max-age=15';
    if (!options.host) {
        throw new Error('feed module: host option missing');
    }

    const feed = new Feed(options);

    return {
        spec,
        operations: {
            aggregatedFeed: feed.aggregated.bind(feed)
        },
        resources: [
            {
                uri: '/{domain}/sys/key_value/feed.aggregated',
                body: {
                    version: 2,
                    valueType: 'json',
                    retention_policy: {
                        type: 'ttl',
                        ttl: options.ttl
                    }
                }
            },
            {
                uri: '/{domain}/sys/key_value/feed.aggregated.historic',
                body: {
                    version: 1,
                    valueType: 'json'
                }
            }
        ]
    };
};
