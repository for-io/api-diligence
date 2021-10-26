/*!
 * api-diligence
 *
 * Copyright (c) 2019-2020 Nikolche Mihajlovski and EPFL
 * 
 * MIT License
 * 
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 * 
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 * 
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

const request = require("supertest");
const mongodb = require('mongodb');

const { initDB, exportDB } = require('./mongo-test-setup');
const { unmask } = require('./test-case-comparator');
const { preprocess } = require('./test-data-preprocessor');

const SUPPORTED_HTTP_METHODS = ['GET', 'POST', 'OPTIONS', 'PATCH', 'PUT', 'DELETE'];

const HDR_MOCK_USER = 'x-mock-user';

const TEST_CONFIG_DEFAULTS = { NODE_ENV: 'test', JWT_SECRET: 'jwt_secret', USE_MOCKS: true };

const globalState = {
    extraComponents: {},
    connection: null,
    db: null,
};

const useMongo = true;

function runTests(tests, testOpts = {}) {
    if (tests.length === 0) return;

    _runTests(tests, testOpts).catch(err => {
        console.error('Failed to setup the tests!', err);
        throw err;
    });
}

function runTest(test) {
    _runTests([test], test.opts).catch(err => {
        console.error('Failed to setup the test!', err);
        throw err;
    });
}

beforeAll(async () => {
    if (useMongo) {
        globalState.connection = await mongodb.MongoClient.connect(global.__MONGO_URI__, {
            useNewUrlParser: true,
            useUnifiedTopology: true,
        });

        globalState.db = globalState.connection.db(global.__MONGO_DB_NAME__);
        globalState.extraComponents = { mongodb, database: globalState.db };
    }
});

afterAll(async () => {
    if (useMongo) {
        if (globalState.connection) {
            await globalState.connection.close();
            globalState.connection = null;
            globalState.db = null;
        }
    }
});

async function _runTests(tests, testOpts = {}) {
    // init the express app in the first test execution, and reuse it in the next tests
    let expressApp = null;

    const appSetup = testOpts.appSetup || {};
    const appFactory = testOpts.appFactory;

    const appConfig = appSetup.config || {};
    const useMongo = appConfig.DB_TYPE === 'mongodb';

    if (!appFactory) {
        throw new Error('You must provide appFactory!');
    }

    for (let i = 0; i < tests.length; i++) {
        const test = tests[i];

        const testName = test.tags ? test.name + ' [' + test.tags.join(', ') + ']' : test.name;

        describe(testName, () => {

            beforeEach(async () => {
                if (useMongo) {
                    for (const coll of await globalState.db.collections()) {
                        coll.drop();
                    }
                }
            });

            for (let i = 0; i < test.cases.length; i++) {
                const testCase = test.cases[i];
                const caseNum = i + 1;

                if (!testCase.name) testCase.name = `case ${caseNum}`;

                it(testCase.name, async () => {

                    if (expressApp === null) {
                        const appComponents = appSetup.components || {};
                        const enrichedAppConfig = Object.assign({}, TEST_CONFIG_DEFAULTS, appConfig, test.config);
                        const enrichedAppComponents = Object.assign({}, appComponents, globalState.extraComponents);

                        const enrichedAppSetup = Object.assign({}, appSetup, {
                            config: enrichedAppConfig,
                            components: enrichedAppComponents,
                        });

                        expressApp = (await appFactory(enrichedAppSetup)).app;
                    }

                    const agent = request.agent(expressApp);

                    const assertedPrecondition = preprocess(testCase.precondition || test.precondition);

                    if (useMongo && assertedPrecondition) {
                        // set precondition
                        await initDB(globalState.db, assertedPrecondition);
                    }

                    if (assertedPrecondition) {
                        // verify precondition (sanity check)
                        const realPrecondition = useMongo ? await exportDB(globalState.db) : {};
                        expect(realPrecondition).toEqual(test.precondition);
                    }

                    for (let i = 0; i < testCase.steps.length; i++) {
                        // pre-process test case data
                        const step = testCase.steps[i];
                        if (step.skip === true) continue;

                        const stepReq = initReq(step.request);
                        const stepResp = initResp(step);

                        const username = stepReq.username || step.username || testCase.username || test.username;

                        const assertedPostcondition = step.postcondition || testCase.postcondition || test.postcondition;

                        // init asserted request
                        const defaultReq = { headers: {} };
                        const assertedReq = Object.assign(defaultReq, preprocess(stepReq));
                        validateReq(assertedReq);

                        // init asserted response
                        const defaultResp = { headers: {} };
                        const assertedResp = Object.assign(defaultResp, stepResp);

                        // prepare a request
                        const method = assertedReq.method.toLowerCase();

                        let pendingReq = agent[method](assertedReq.url)
                            .set(assertedReq.headers || {});

                        if (username) {
                            if (testOpts.mockAuth) {
                                pendingReq = pendingReq.set(HDR_MOCK_USER, username);

                            } else if (testOpts.getAuthToken && assertedReq.headers.Authorization === undefined && assertedReq.headers.authorization === undefined) {
                                let token = await testOpts.getAuthToken({ username, agent: request.agent(expressApp) });
                                pendingReq = pendingReq.set('Authorization', `Bearer ${token}`);
                            }
                        }

                        if (assertedReq.body) {
                            pendingReq = pendingReq.query(assertedReq.query).sortQuery();
                        }

                        if (assertedReq.body) {
                            pendingReq = pendingReq.send(assertedReq.body);
                        }

                        if (assertedReq.cookies) {
                            pendingReq = pendingReq.set('Cookie', constructCookieList(assertedReq.cookies));
                        }

                        // send the request and receive response
                        const result = await pendingReq
                            .timeout({ deadline: assertedReq.timeout || 1000 })
                            .catch(err => {
                                console.error(err);
                                throw err;
                            });

                        // verify response
                        const realResp = refineResponse(result, assertedResp);
                        const unmaskedResp = unmask(assertedResp, realResp);
                        expect(realResp).toEqual(unmaskedResp);

                        // verify postcondition
                        if (assertedPostcondition) {
                            const realPostcondition = useMongo ? await exportDB(globalState.db) : {};
                            const unmaskedPostcondition = unmask(assertedPostcondition, realPostcondition);
                            expect(realPostcondition).toEqual(unmaskedPostcondition);
                        }
                    }

                    if (testOpts.onDone) testOpts.onDone();
                });
            }
        });
    }
}

function initReq(req) {
    if (typeof req === 'string') {
        let parts = req.split(' ');

        return {
            method: parts[0],
            url: parts[1],
        };

    } else {
        return req;
    }
}

function initResp(step) {
    if (step.response) return step.response;

    let codes = Object.keys(step).filter(key => /^\d+$/.test(key));

    if (codes.length === 0) {
        throw new Error('The test step is missing a response!');

    } else if (codes.length > 1) {
        throw new Error('The test step has more than one response code!');

    } else {
        let code = codes[0];

        return {
            status: parseInt(code),
            body: step[code],
        };
    }
}

function constructCookieList(cookies) {
    const cookieList = [];

    for (const key in cookies) {
        if (cookies.hasOwnProperty(key)) {
            cookieList.push(`${key}=${cookies[key]}`);
        }
    }

    return cookieList;
}

function refineResponse(result, assertedResp) {
    const refinedResp = {
        status: result.statusCode,
        body: result.body,
        headers: {},
    };

    for (const hdr of Object.keys(assertedResp.headers || {})) {
        if (result.headers[hdr] !== undefined) {
            refinedResp.headers[hdr] = result.headers[hdr];
        }
    }

    return refinedResp;
}

function validateReq(req) {
    if (SUPPORTED_HTTP_METHODS.indexOf(req.method) < 0) {
        throw new Error('Unsupported HTTP method: ' + req.method);
    }
}

module.exports = { runTest, runTests };