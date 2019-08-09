'use strict';

const assert = require('../utils/assert.js');
const Server = require('../utils/server.js');
const preq   = require('preq');

[
    {
        endpoint: 'media',
        check: (res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(/^application\/json/.test(res.headers['content-type']), true);
            assert.deepEqual(!!res.body.items, true);
        }
    },
    {
        endpoint: 'media-list',
        check: (res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(/^application\/json/.test(res.headers['content-type']), true);
            assert.deepEqual(!!res.body.items, true);
        }
    },
    {
        endpoint: 'metadata',
        check: (res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(/^application\/json/.test(res.headers['content-type']), true);
            assert.deepEqual(!!res.body.revision, true);
            assert.deepEqual(!!res.body.tid, true);
            assert.deepEqual(!!res.body.toc, true);
            assert.deepEqual(!!res.body.language_links, true);
            assert.deepEqual(!!res.body.categories, true);
            assert.deepEqual(!!res.body.protection, true);
        }
    },
    {
        endpoint: 'references',
        check: (res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(/^application\/json/.test(res.headers['content-type']), true);
            assert.deepEqual(!!res.body.revision, true);
            assert.deepEqual(!!res.body.tid, true);
            assert.deepEqual(!!res.body.reference_lists, true);
            assert.deepEqual(!!res.body.references_by_id, true);
        }
    }
].forEach((testSpec) => {
    describe(`Page Content Service: /page/${testSpec.endpoint}`, () => {
        const server = new Server();
        before(() => server.start());
        after(() => server.stop());

        const pageTitle = 'Foobar';
        const pageRev = 757550077;

        it(`Should fetch latest ${testSpec.endpoint}`, () => {
            return preq.get({
                uri: `${server.config.bucketURL()}/${testSpec.endpoint}/${pageTitle}`
            })
            .then((res) => {
                testSpec.check(res);
                assert.deepEqual(!!res.headers.etag, true);
            });
        });

        it(`Should fetch older ${testSpec.endpoint}`, () => {
            return preq.get({
                uri: `${server.config.bucketURL()}/${testSpec.endpoint}/${pageTitle}/${pageRev}`
            })
            .then((res) => {
                testSpec.check(res);
                assert.deepEqual(new RegExp(`^(?:W\/)?"${pageRev}\/.+"$`).test(res.headers.etag), true);
            });
        });
    });
});

describe('Page Content Service: transforms', () => {
    const server = new Server();
    before(() => server.start());
    after(() => server.stop());

    it('should transform wikitext to mobile-html', () => {
        return preq.post({
            uri: `${server.config.baseURL()}/transform/wikitext/to/mobile-html/Main_Page`,
            body: {
                wikitext: '== Heading =='
            }
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-language'], 'en');
            assert.checkString(res.headers['cache-control'], /private/, 'Must not be cached');
            assert.checkString(res.body, /<h2 id="Heading" class="(:?[^"]+)">Heading<\/h2>/);
        })
    });

    it('should transform wikitext to mobile-html, language variants, no variant', () => {
        return preq.post({
            uri: `${server.config.baseURL('sr.wikipedia.beta.wmflabs.org')}/transform/wikitext/to/mobile-html/RESTBase_Testing_Page`,
            body: { wikitext: 'Ово је тестна страница - 1\n\nOvo je testna stranica - 2' }
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-language'], 'sr');
            assert.checkString(res.headers['cache-control'], /private/, 'Must not be cached');
            assert.checkString(res.body, /Ово је тестна страница - 1/, 'Must not convert cyrillic with no variant');
            assert.checkString(res.body, /Ovo je testna stranica - 2/, 'Must not convert latin with no variant');
        });
    });

    it('should transform wikitext to mobile-html, language variants, cyrillic variant', () => {
        return preq.post({
            uri: `${server.config.baseURL('sr.wikipedia.beta.wmflabs.org')}/transform/wikitext/to/mobile-html/RESTBase_Testing_Page`,
            headers: {
                'accept-language': 'sr-ec'
            },
            body: { wikitext: 'Ово је тестна страница - 1\n\nOvo je testna stranica - 2' }
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-language'], 'sr-ec');
            assert.checkString(res.headers['cache-control'], /private/, 'Must not be cached');
            assert.checkString(res.body, /Ово је тестна страница - 1/, 'Must not convert cyrillic with cyrillic variant');
            assert.checkString(res.body, /Ово је тестна страница - 2/, 'Must convert latin with cyrillic variant');
        });
    });

    it('should transform wikitext to mobile-html, language variants, latin variant', () => {
        return preq.post({
            uri: `${server.config.baseURL('sr.wikipedia.beta.wmflabs.org')}/transform/wikitext/to/mobile-html/RESTBase_Testing_Page`,
            headers: {
                'accept-language': 'sr-el'
            },
            body: { wikitext: 'Ово је тестна страница - 1\n\nOvo je testna stranica - 2' }
        })
        .then((res) => {
            assert.deepEqual(res.status, 200);
            assert.deepEqual(res.headers['content-language'], 'sr-el');
            assert.checkString(res.headers['cache-control'], /private/, 'Must not be cached');
            assert.checkString(res.body, /Ovo je testna stranica - 1/, 'Must convert cyrillic with latin variant');
            assert.checkString(res.body, /Ovo je testna stranica - 2/, 'Must not convert latin with latin variant');
        });
    });
});

