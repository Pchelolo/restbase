"use strict";

const mwUtil = require('../lib/mwUtil');
const URI = require('hyperswitch').URI;
const P = require('bluebird');

const spec = require('hyperswitch').utils.loadSpec(`${__dirname}/summary.yaml`);

module.exports = (options) => {
    const isNewStorageEnabled = (() => {
        const checkEnableRegex = options.new_storage_enabled
            && mwUtil.constructRegex(options.new_storage_enabled);
        return domain => checkEnableRegex && checkEnableRegex.test(domain);
    })();

    return {
        spec,
        globals: { options },
        operations: {
            getSummary: (hyper, req) => {
                const rp = req.params;
                const oldURI = new URI([rp.domain, 'sys', 'summary_old', 'summary', rp.title]);
                const newURI = new URI([rp.domain, 'sys', 'summary_new', 'summary', rp.title]);
                if (mwUtil.isNoCacheRequest(req) && isNewStorageEnabled(req.params.domain)) {
                    return P.props({
                        oldContent: hyper.get({
                            uri: oldURI,
                            headers: req.headers,
                            query: req.query
                        }),
                        newContent: hyper.get({
                            uri: newURI,
                            headers: req.headers,
                            query: req.query
                        })
                        .catch(e => undefined),
                    })
                    .get('oldContent');
                } else {
                    return hyper.get({
                        uri: oldURI,
                        headers: req.headers,
                        query: req.query
                    });
                }
            }
        }
    };
};
