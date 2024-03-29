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

const testLoader = require('./test-loader');
const testRunner = require('./test-runner');

function runApiDiligence(opts) {
    const testDirs = testLoader.listTestDirs(opts.testsRoot);

    const tests = testDirs.map(testDir => {
        const test = testLoader.loadTest(testDir);

        if (opts.test) {
            Object.assign(test, opts.test);
        }

        return test;
    });

    // "test.opts" are the same for each test, so they are provided as "testOpts" param
    const testOpts = opts.test.opts || {};

    testRunner.runTests(tests, testOpts);
}

module.exports = Object.assign({ runApiDiligence }, testLoader, testRunner);
