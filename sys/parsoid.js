'use strict';

/*
 * Simple wrapper for Parsoid
 */

const P = require('bluebird');
const HyperSwitch = require('hyperswitch');
const URI = HyperSwitch.URI;
const HTTPError = HyperSwitch.HTTPError;

const uuid   = require('cassandra-uuid').TimeUuid;
const mwUtil = require('../lib/mwUtil');

const spec = HyperSwitch.utils.loadSpec(`${__dirname}/parsoid.yaml`);

// Temporary work-around for Parsoid issue
// https://phabricator.wikimedia.org/T93715
function normalizeHtml(html) {
    return html && html.toString &&
    html.toString()
    .replace(/ about="[^"]+"(?=[/> ])|<meta property="mw:TimeUuid"[^>]+>/g, '');
}
function sameHtml(a, b) {
    return normalizeHtml(a) === normalizeHtml(b);
}

/**
 * Makes sure we have a meta tag for the tid in our output
 * @param  {string} html original HTML content
 * @param  {string} tid  the tid to insert
 * @return {string}      modified html
 */
function insertTidMeta(html, tid) {
    if (!/<meta property="mw:TimeUuid" [^>]+>/.test(html)) {
        return html.replace(/(<head [^>]+>)/,
            `$1<meta property="mw:TimeUuid" content="${tid}"/>`);
    }
    return html;
}

function extractTidMeta(html) {
    // Fall back to an inline meta tag in the HTML
    const tidMatch = new RegExp('<meta\\s+(?:content="([^"]+)"\\s+)?' +
            'property="mw:TimeUuid"(?:\\s+content="([^"]+)")?\\s*\\/?>')
    .exec(html);
    return tidMatch && (tidMatch[1] || tidMatch[2]);
}

/**
 *  Checks whether the content has been modified since the timestamp
 *  in `if-unmodified-since` header of the request
 * @param  {Object} req the request
 * @param  {Object} res the response
 * @return {boolean}    true if content has beed modified
 */
function isModifiedSince(req, res) {
    try {
        if (req.headers['if-unmodified-since']) {
            const jobTime = Date.parse(req.headers['if-unmodified-since']);
            const revInfo = mwUtil.parseETag(res.headers.etag);
            return revInfo && uuid.fromString(revInfo.tid).getDate() >= jobTime;
        }
    } catch (e) {
        // Ignore errors from date parsing
    }
    return false;
}

/** HTML resource_change event emission
 * @param   {HyperSwitch}   hyper           the hyperswitch router object
 * @param   {Object}        req             the request
 * @param   {boolean}       [newContent]    whether this is the newest revision
 * @return  {Object}                        update response
 */
function _dependenciesUpdate(hyper, req, newContent = true) {
    const rp = req.params;
    return mwUtil.getSiteInfo(hyper, req)
    .then((siteInfo) => {
        const baseUri = siteInfo.baseUri.replace(/^https?:/, '');
        const publicURI = `${baseUri}/page/html/${encodeURIComponent(rp.title)}`;
        const body = [ { meta: { uri: `${publicURI}/${rp.revision}` } } ];
        if (newContent) {
            body.push({ meta: { uri: publicURI } });
        }
        return hyper.post({
            uri: new URI([rp.domain, 'sys', 'events', '']),
            body
        }).catch((e) => {
            hyper.logger.log('warn/bg-updates', e);
        });
    });
}

function compileReRenderBlacklist(blacklist) {
    const result = {};
    blacklist = blacklist || {};
    Object.keys(blacklist).forEach((domain) => {
        result[domain] = mwUtil.constructRegex(blacklist[domain]);
    });
    return result;
}

class ParsoidService {
    constructor(options) {
        this.options = options = options || {};
        this.parsoidHost = options.parsoidHost;

        this._blacklist = compileReRenderBlacklist(options.rerenderBlacklist);

        // Set up operations
        this.operations = {
            getPageBundle: this.pagebundle.bind(this),
            // Revision retrieval per format
            getWikitext: this.getFormat.bind(this, 'wikitext'),
            getHtml: this.getFormat.bind(this, 'html'),
            getDataParsoid: this.getFormat.bind(this, 'data-parsoid'),
            getLintErrors: this.getLintErrors.bind(this),
            // Transforms
            transformHtmlToHtml: this.makeTransform('html', 'html'),
            transformHtmlToWikitext: this.makeTransform('html', 'wikitext'),
            transformWikitextToHtml: this.makeTransform('wikitext', 'html'),
            transformWikitextToLint: this.makeTransform('wikitext', 'lint'),
            transformChangesToWikitext: this.makeTransform('changes', 'wikitext')
        };
    }

    /**
     * Get the URI of a bucket for the latest Parsoid content.
     * @param {string} domain the domain name.
     * @param {string} title the article title.
     * @return {HyperSwitch.URI}
     */
    getLatestBucketURI(domain, title) {
        return new URI([
            domain, 'sys', 'key_value', 'parsoid', title
        ]);
    }

    /**
     * Get the URI of a bucket for stashing Parsoid content. Used both for stashing
     * original HTML/Data-Parsoid for normal edits as well as for stashing transforms.
     *
     * @param {string} domain the domain name.
     * @param {string} title the article title.
     * @param {number} revision the revision of the article.
     * @param {string} tid the TID of the content.
     * @return {HyperSwitch.URI}
     */
    getStashBucketURI(domain, title, revision, tid) {
        return new URI([
            domain, 'sys', 'key_value', 'parsoid-stash', `${title}:${revision}:${tid}`
        ]);
    }

    getOldLatestBucketURI(domain, format, title, revision, tid) {
        const path = [domain, 'sys', 'parsoid_bucket', format, title];
        if (revision) {
            path.push(revision);
            if (tid) {
                path.push(tid);
            }
        }
        return new URI(path);
    }

    /**
     * Get full content from the stash bucket.
     * @param {HyperSwitch} hyper the hyper object to route requests
     * @param {string} domain the domain name
     * @param {string} title the article title
     * @param {number} revision the article revision
     * @param {string} tid the render TID
     * @return {Promise<Object>} the promise resolving to full stashed Parsoid
     * response or a stashed transform
     * @private
     */
    _getStashedContent(hyper, domain, title, revision, tid) {
        return hyper.get({
            uri: this.getStashBucketURI(domain, title, revision, tid)
        })
        .then((res) => {
            res = JSON.parse(res.body.toString('utf8'));
            res.revid = revision;
            return res;
        });
    }

    _saveParsoidResultToFallback(hyper, req, parsoidResp) {
        const rp = req.params;
        const dataParsoidResponse = parsoidResp.body['data-parsoid'];
        const htmlResponse = parsoidResp.body.html;
        const tid = mwUtil.parseETag(htmlResponse.headers.etag).tid;
        return hyper.put({
            uri: this.getStashBucketURI(rp.domain, rp.title, rp.revision, tid),
            // Note. The headers we are storing here are for the whole pagebundle response.
            // The individual components of the pagebundle contain their own headers that
            // which are used to generate actual responses.
            headers: {
                'x-store-etag': htmlResponse.headers.etag,
                'content-type': 'application/octet-stream',
                'x-store-content-type': 'application/json'
            },
            body: Buffer.from(JSON.stringify({
                'data-parsoid': dataParsoidResponse,
                html: htmlResponse
            }))
        });
    }

    /**
     * Saves the Parsoid pagebundle result to the latest bucket.
     * // TODO: Optimization opportunity. We look what's in the
     * // latest bucket yet again and make the store request a no-op if
     * // it's not really the latest content, but we have already looked into
     * // the latest bucket, thus we can somehow pass the data over here
     * // so that we don't do several checks.
     * @param {HyperSwitch} hyper the hyper object for request routing
     * @param {string} domain the domain name
     * @param {string} title the page title
     * @param {Object} parsoidResp the response received from Parsoid.
     * @return {Promise<Object>}
     */
    saveParsoidResultToLatest(hyper, domain, title, parsoidResp) {
        const dataParsoidResponse = parsoidResp.body['data-parsoid'];
        const htmlResponse = parsoidResp.body.html;
        return hyper.get({ uri: this.getLatestBucketURI(domain, title) })
        .then((existingRes) => {
            // TODO: This is a race condition and we're doing a write after read
            // in a distributed concurrent environment. For revisions this should
            // not be a big problem, but once(if) we start supporting lightweight transactions
            // in the storage component, we might want to rethink this.
            const existingRev = mwUtil.parseETag(existingRes.headers.etag).rev;
            const newRev = mwUtil.parseETag(parsoidResp.headers.etag).rev;
            if (Number.parseInt(newRev, 10) >= Number.parseInt(existingRev, 10)) {
                throw new HTTPError({ status: 412 });
            }
            return existingRes;
        })
        .catch({ status: 404 }, { status: 412 }, () => hyper.put({
            uri: this.getLatestBucketURI(domain, title),
            // Note. The headers we are storing here are for the whole pagebundle response.
            // The individual components of the pagebundle contain their own headers that
            // which are used to generate actual responses.
            headers: {
                'x-store-etag': htmlResponse.headers.etag,
                'content-type': 'application/octet-stream',
                'x-store-content-type': 'application/json'
            },
            body: Buffer.from(JSON.stringify({
                'data-parsoid': dataParsoidResponse,
                html: htmlResponse
            }))
        }));
    }

    stashTransform(hyper, req, transformPromise) {
        // A stash has been requested. We need to store the wikitext sent by
        // the client together with the page bundle returned by Parsoid, so it
        // can be later reused when transforming back from HTML to wikitext
        // cf https://phabricator.wikimedia.org/T114548
        const rp = req.params;
        const tid = uuid.now().toString();
        const etag = mwUtil.makeETag(rp.revision, tid, 'stash');
        const wtType = req.original && req.original.headers['content-type'] || 'text/plain';
        return transformPromise.then((original) => hyper.put({
            uri: this.getStashBucketURI(rp.domain, rp.title, rp.revision, tid),
            headers: {
                'x-store-etag': etag,
                'content-type': 'application/octet-stream',
                'x-store-content-type': 'application/json'
            },
            body: Buffer.from(JSON.stringify({
                'data-parsoid': original.body['data-parsoid'],
                wikitext: {
                    headers: { 'content-type': wtType },
                    body: req.body.wikitext
                },
                html: original.body.html
            }))
        })
        // Add the ETag to the original response so it can be propagated back to the client
        .then(() => {
            original.body.html.headers.etag = etag;
            return original;
        }));
    }

    /**
     * Returns the content with fallback to the stash. Revision and TID are optional.
     * If only 'title' is provided, only 'latest' bucket is checked.
     * If 'title' and 'revision' are provided, first the 'latest' bucket is checked.
     *  Then, the stored revision is compared, if they do not equal, 404 is returned
     *  as we can not check the stash with no tid provided.
     *  If all the 'title', 'revision' and 'tid' are provided,
     *  we check the latest bucket first, and then the stash bucket.
     * @param {HyperSwitch} hyper the hyper object to rout requests
     * @param {string} domain the domain name
     * @param {string} title the article title
     * @param {number} [revision] the article revision
     * @param {string} [tid] the render TID
     * @return {Promise<Object>} the promise that resolves to full stashed Parsoid response
     * @private
     */
    _getContentWithFallback(hyper, domain, title, revision, tid) {
        // TODO: This is temporary until we finish up the switch.
        // The new buckets store both data-parsoid and html together,
        // while the old buckets were storing them separately. To simplify
        // the rest of the code and make switching the fallback easier,
        // we make 2 requests here and emulate the new behaviour.
        const grabContentFromOldLatestBucket = () =>
            P.props({
                html: hyper.get({
                    uri: this.getOldLatestBucketURI(domain, 'html', title, revision, tid)
                })
                .then(mwUtil.decodeBody),
                'data-parsoid': hyper.get({
                    uri: this.getOldLatestBucketURI(domain, 'data-parsoid', title, revision, tid)
                })
            })
            .then((res) => {
                return {
                    status: 200,
                    headers: res.html.headers,
                    body: {
                        html: res.html,
                        'data-parsoid': res['data-parsoid'],
                        revid: mwUtil.parseETag(res.html.headers.etag).rev
                    }
                };
            });

        if (!revision && !tid) {
            return hyper.get({ uri: this.getLatestBucketURI(domain, title) })
            .then((res) => {
                res.body = JSON.parse(res.body.toString('utf8'));
                return res;
            })
            .catch({ status: 404 }, () =>
                grabContentFromOldLatestBucket()
                .tap((res) => {
                    this.saveParsoidResultToLatest(hyper, domain, title, res)
                    .catch((e) => hyper.logger.log('parsoid/copyover', {
                        msg: 'Failed to copy latest Parsoid data',
                        e
                    }));
                }));
        } else if (!tid) {
            return hyper.get({ uri: this.getLatestBucketURI(domain, title) })
            .then((res) => {
                const resEtag = mwUtil.parseETag(res.headers.etag);
                if (revision !== resEtag.rev) {
                    throw new HTTPError({ status: 404 });
                }
                res.body = JSON.parse(res.body.toString('utf8'));
                return res;
            })
            .catch({ status: 404 }, grabContentFromOldLatestBucket);
        } else {
            return hyper.get({
                uri: this.getStashBucketURI(domain, title, revision, tid)
            })
            .then((res) => {
                res.body = JSON.parse(res.body.toString('utf8'));
                return res;
            })
            .catch({ status: 404 }, () =>
                hyper.get({ uri: this.getLatestBucketURI(domain, title) })
                .then((res) => {
                    const resEtag = mwUtil.parseETag(res.headers.etag);
                    if (revision !== resEtag.rev || tid !== resEtag.tid) {
                        throw new HTTPError({ status: 404 });
                    }
                    res.body = JSON.parse(res.body.toString('utf8'));
                    return res;
                })
            )
            .catch({ status: 404 }, grabContentFromOldLatestBucket);
        }
    }

    pagebundle(hyper, req) {
        const rp = req.params;
        const domain = rp.domain;
        const newReq = Object.assign({}, req);
        newReq.method = newReq.method || 'get';
        const path = (newReq.method === 'get') ? 'page' : 'transform/wikitext/to';
        newReq.uri = `${this.parsoidHost}/${domain}/v3/${path}/pagebundle/` +
            `${encodeURIComponent(rp.title)}/${rp.revision}`;
        return hyper.request(newReq);
    }

    /**
     * Generate content and store it in the latest bucket if the content is indeed
     * newer then the original content we have fetched.
     * @param {HyperSwitch} hyper the hyper object for request routing
     * @param {Object} req the original request
     * @param {Object} currentContentRes the pagebundle received from latest or fallback bucket.
     * @return {Promise<Object>}
     */
    generateAndSave(hyper, req, currentContentRes) {
        // Try to generate HTML on the fly by calling Parsoid
        const rp = req.params;
        return this.getRevisionInfo(hyper, req)
        .then((revInfo) => {
            rp.revision = revInfo.rev;
        })
        .then(() => {
            const pageBundleUri = new URI([rp.domain, 'sys', 'parsoid', 'pagebundle',
                rp.title, rp.revision]);

            const parsoidReq =  hyper.get({ uri: pageBundleUri });

            return P.join(parsoidReq, mwUtil.decodeBody(currentContentRes))
            .spread((res, currentContentRes) => {
                const tid  = uuid.now().toString();
                const etag = mwUtil.makeETag(rp.revision, tid);
                res.body.html.body = insertTidMeta(res.body.html.body, tid);
                res.body.html.headers.etag = res.headers.etag = etag;

                if (currentContentRes &&
                        currentContentRes.status === 200 &&
                        sameHtml(res.body.html.body, currentContentRes.body.html.body) &&
                        currentContentRes.body.html.headers['content-type'] ===
                                res.body.html.headers['content-type']) {
                    // New render is the same as the previous one, no need to store it.
                    hyper.metrics.increment('sys_parsoid_generateAndSave.unchanged_rev_render');
                    return currentContentRes;
                } else if (res.status === 200) {
                    let newContent = false;
                    return this.saveParsoidResultToLatest(hyper, rp.domain, rp.title, res)
                    .then((saveRes) => {
                        if (saveRes.status === 201) {
                            newContent = true;
                        }
                        // Extract redirect target, if any
                        const redirectTarget = mwUtil.extractRedirect(res.body.html.body);
                        if (redirectTarget) {
                            // This revision is actually a redirect. Pass redirect target
                            // to caller, and let it rewrite the location header.
                            res.status = 302;
                            res.headers.location = encodeURIComponent(redirectTarget)
                                .replace(/%23/, '#');
                        }
                    })
                    .then(() => {
                        const dependencyUpdate = _dependenciesUpdate(hyper, req, newContent);
                        if (mwUtil.isNoCacheRequest(req)) {
                            // Finish background updates before returning
                            return dependencyUpdate.thenReturn(res);
                        } else {
                            return res;
                        }
                    });
                } else {
                    return res;
                }
            });
        });
    }

    /**
     * Internal check to see if it's okay to re-render a particular title in
     * response to a no-cache request.
     *
     * TODO: Remove this temporary code once
     * https://phabricator.wikimedia.org/T120171 and
     * https://phabricator.wikimedia.org/T120972 are resolved / resource
     * consumption for these articles has been reduced to a reasonable level.
     * @param  {Request} req    the request being processed
     * @return {boolean}        Whether re-rendering this title is okay.
     */
    _okayToRerender(req) {
        if (mwUtil.isNoCacheRequest(req) && this._blacklist[req.params.domain]) {
            return !this._blacklist[req.params.domain].test(req.params.title);
        }
        return true;
    }

    getFormat(format, hyper, req) {
        const rp = req.params;
        const generateContent = (storageRes) => {
            if (!rp.tid && (storageRes.status === 404 || storageRes.status === 200)) {
                return this.generateAndSave(hyper, req, storageRes);
            } else {
                // Don't generate content if there's some other error.
                throw storageRes;
            }
        };

        if (!this._okayToRerender(req)) {
            // Still update the revision metadata.
            return this.getRevisionInfo(hyper, req)
            .then(() => {
                throw new HTTPError({
                    status: 403,
                    body: {
                        type: 'bad_request#rerenders_disabled',
                        description: 'Rerenders for this article are blacklisted in the config.'
                    }
                });
            });
        }

        let contentReq =
            this._getContentWithFallback(hyper, rp.domain, rp.title, rp.revision, rp.tid);

        if (mwUtil.isNoCacheRequest(req)) {
            // Check content generation either way
            contentReq = contentReq.then((res) => {
                if (isModifiedSince(req, res)) { // Already up to date, nothing to do.
                    throw new HTTPError({
                        status: 412,
                        body: {
                            type: 'precondition_failed',
                            detail: 'The precondition failed'
                        }
                    });
                }
                return generateContent(res);
            }, generateContent);
        } else {
            // Only (possibly) generate content if there was an error
            contentReq = contentReq.catch(generateContent);
        }
        return contentReq
        .then((res) => {
            if (req.query.stash) {
                return this._saveParsoidResultToFallback(hyper, req, res)
                .thenReturn(res);
            }
            return res;
        })
        .then((res) => {
            const etag = res.headers.etag;
            // Chop off the correct format to return.
            res = Object.assign({ status: res.status }, res.body[format]);
            res.headers.etag = etag;
            mwUtil.normalizeContentType(res);
            res.headers = res.headers || {};
            if (req.query.stash) {
                // The stash is used by clients that want further support
                // for transforming the content. If the content is stored in caches,
                // subsequent requests might not even reach RESTBase and the stash
                // will expire, thus no-cache.
                res.headers['cache-control'] = 'no-cache';
            } else if (this.options.response_cache_control) {
                res.headers['cache-control'] = this.options.response_cache_control;
            }
            if (/^null$/.test(res.headers.etag)) {
                hyper.logger.log('error/parsoid/response_etag_missing', {
                    msg: 'Detected a null etag in the response!'
                });
            }

            return res;
        });
    }

    transformRevision(hyper, req, from, to) {
        const rp = req.params;

        const etag = req.headers && mwUtil.parseETag(req.headers['if-match']);
        // Prefer the If-Match header
        let tid = etag && etag.tid;

        if (from === 'html') {
            if (req.body && req.body.html) {
                // Fall back to an inline meta tag in the HTML
                const htmlTid = extractTidMeta(req.body.html);
                if (tid && htmlTid && htmlTid !== tid) {
                    hyper.logger.log('error/parsoid/etag_mismatch', {
                        msg: 'Client-supplied etag did not match mw:TimeUuid!'
                    });
                } else if (!tid) {
                    tid = htmlTid;
                    hyper.logger.log('warn/parsoid/etag', {
                        msg: 'Client did not supply etag, fallback to mw:TimeUuid meta element'
                    });
                }
            }
            if (!tid) {
                throw new HTTPError({
                    status: 400,
                    body: {
                        type: 'bad_request',
                        description: 'No or invalid If-Match header supplied, ' +
                            'or missing mw:TimeUuid meta element in the supplied HTML.'
                    }
                });
            }
        }

        let contentPromise;
        if (from === 'wikitext') {
            // For transforming from wikitext Parsoid currently doesn't use the original
            // content. It could be used for optimizing the template expansions. See T98995
            // Note: when resurrecting sending the original content to Parsoid we should
            // account for the possibility that it's not in storage, so contentPromise might
            // reject with 404. In this case we would just not provide it.
            contentPromise = P.resolve(undefined);
        } else {
            if (etag && etag.suffix === 'stash' && from === 'html' && to === 'wikitext') {
                contentPromise = this._getStashedContent(hyper, rp.domain,
                    rp.title, rp.revision, tid);
            } else {
                contentPromise = this._getOriginalContent(hyper, req, rp.revision, tid);
            }
            contentPromise = contentPromise
            .tap((original) => {
                // Check if parsoid metadata is present as it's required by parsoid.
                if (!original['data-parsoid'].body ||
                    original['data-parsoid'].body.constructor !== Object ||
                    !original['data-parsoid'].body.ids) {
                    throw new HTTPError({
                        status: 400,
                        body: {
                            type: 'bad_request',
                            description: 'The page/revision has no associated Parsoid data'
                        }
                    });
                }
            });
        }
        return contentPromise.then((original) => {
            const path = [rp.domain, 'sys', 'parsoid', 'transform', from, 'to', to];
            if (rp.title) {
                path.push(rp.title);
                if (rp.revision) {
                    path.push(rp.revision);
                }
            }
            const newReq = {
                uri: new URI(path),
                params: req.params,
                headers: {
                    'content-type': 'application/json',
                    'user-agent': req['user-agent']
                },
                body: {
                    original,
                    [from]: req.body[from],
                    scrub_wikitext: req.body.scrub_wikitext,
                    body_only: req.body.body_only,
                    stash: req.body.stash
                }
            };
            return this.callParsoidTransform(hyper, newReq, from, to);
        });

    }

    callParsoidTransform(hyper, req, from, to) {
        const rp = req.params;
        let parsoidTo = to;
        if (to === 'html') {
            // Retrieve pagebundle whenever we want HTML
            parsoidTo = 'pagebundle';
            req.headers.accept = req.headers.accept && req.headers.accept
                .replace(/\/HTML\//i, '/pagebundle/')
                .replace(/text\/html/, 'application/json');
        }
        let parsoidFrom = from;
        if (from === 'html' && req.body.original) {
            parsoidFrom = 'pagebundle';
        }
        const parsoidExtras = [];
        if (rp.title) {
            parsoidExtras.push(rp.title);
        } else {
            // Fake title to avoid Parsoid error: <400/No title or wikitext was provided>
            parsoidExtras.push('Main_Page');
        }
        if (rp.revision && rp.revision !== '0') {
            parsoidExtras.push(rp.revision);
        }
        let parsoidExtraPath = parsoidExtras.map(encodeURIComponent).join('/');
        if (parsoidExtraPath) {
            parsoidExtraPath = `/${parsoidExtraPath}`;
        }

        const parsoidReq = {
            uri: `${this.parsoidHost}/${rp.domain}/v3/transform/` +
                `${parsoidFrom}/to/${parsoidTo}${parsoidExtraPath}`,
            headers: {
                'content-type': 'application/json',
                'user-agent': req['user-agent'],
                'content-language': req.headers['content-language'],
                accept: req.headers.accept
            },
            body: req.body
        };

        const transformPromise = hyper.post(parsoidReq);
        if (req.body.stash && from === 'wikitext' && to === 'html') {
            return this.stashTransform(hyper, req, transformPromise);
        }
        return transformPromise;

    }

    getLintErrors(hyper, req) {
        const rp = req.params;
        let path = `${this.parsoidHost}/${rp.domain}/v3/transform/` +
            `wikitext/to/lint/${encodeURIComponent(rp.title)}`;
        if (rp.revision) {
            path += `/${rp.revision}`;
        }
        return hyper.post({ uri: path });
    }

    makeTransform(from, to) {
        return (hyper, req) => {
            const rp = req.params;
            if ((!req.body && req.body !== '') ||
                    // The html/to/html endpoint is a bit different so the `html`
                    // might not be provided.
                    (!(from === 'html' && to === 'html') &&
                        !req.body[from] && req.body[from] !== '')) {
                throw new HTTPError({
                    status: 400,
                    body: {
                        type: 'bad_request',
                        description: `Missing request parameter: ${from}`
                    }
                });
            }
            // check if we have all the info for stashing
            if (req.body.stash) {
                if (!rp.title) {
                    throw new HTTPError({
                        status: 400,
                        body: {
                            type: 'bad_request',
                            description: 'Data can be stashed only for a specific title.'
                        }
                    });
                }
                if (!rp.revision) {
                    rp.revision = '0';
                }
            }

            let transform;
            if (rp.revision && rp.revision !== '0') {
                transform = this.transformRevision(hyper, req, from, to);
            } else {
                transform = this.callParsoidTransform(hyper, req, from, to);
            }
            return transform
            .catch((e) => {
                // In case a page was deleted/revision restricted while edit was happening,
                // return 410 Gone or 409 Conflict error instead of a general 400
                const pageDeleted = e.status === 404 && e.body &&
                        /Page was deleted/.test(e.body.description);
                const revisionRestricted = e.status === 403 && e.body &&
                        /Access is restricted/.test(e.body.description);
                if (pageDeleted || revisionRestricted) {
                    throw new HTTPError({
                        status: pageDeleted ? 410 : 409,
                        body: {
                            type: 'conflict',
                            title: 'Conflict detected',
                            description: e.body.description
                        }
                    });
                }
                throw e;
            })
            .then((res) => {
                if (to !== 'wikitext' && to !== 'lint') {
                    // Unwrap to the flat response format
                    res = res.body[to];
                    res.status = 200;
                }
                // normalise the content type
                mwUtil.normalizeContentType(res);
                // remove the content-length header since that
                // is added automatically
                delete res.headers['content-length'];
                return res;
            });
        };
    }

    // Get / check the revision metadata for a request
    getRevisionInfo(hyper, req) {
        const rp = req.params;
        const path = [rp.domain, 'sys', 'page_revisions', 'page', rp.title];
        if (/^(?:[0-9]+)$/.test(rp.revision)) {
            path.push(rp.revision);
        } else if (rp.revision) {
            throw new Error(`Invalid revision: ${rp.revision}`);
        }

        return hyper.get({
            uri: new URI(path),
            headers: {
                'cache-control': req.headers && req.headers['cache-control']
            }
        })
        .then((res) => res.body.items[0]);
    }

    _getOriginalContent(hyper, req, revision, tid) {
        const rp = req.params;
        return this._getContentWithFallback(hyper, rp.domain, rp.title, revision, tid)
        .then((res) => {
            res = res.body;
            res.revid = revision;
            return res;
        });
    }
}

module.exports = (options) => {
    options = options || {};
    const ps = new ParsoidService(options);

    return {
        spec,
        operations: ps.operations,
        // Dynamic resource dependencies, specific to implementation
        resources: [
            {
                uri: '/{domain}/sys/parsoid_bucket/'
            },
            {
                uri: '/{domain}/sys/key_value/parsoid',
                body: {
                    valueType: 'blob'
                }
            },
            {
                uri: '/{domain}/sys/key_value/parsoid-stash',
                body: {
                    valueType: 'blob',
                    default_time_to_live: options.grace_ttl
                }
            }
        ]
    };
};
