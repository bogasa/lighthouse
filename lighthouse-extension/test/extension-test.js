/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

/* eslint-env mocha */

const path = require('path');
const assert = require('assert');
const fs = require('fs');
const puppeteer = require('../../node_modules/puppeteer/index.js');

const lighthouseExtensionPath = path.resolve(__dirname, '../dist');
const config = require(path.resolve(__dirname, '../../lighthouse-core/config/default-config.js'));

const getAuditsOfCategory = category => config.categories[category].audits;

describe('Lighthouse chrome extension', function() {
  // eslint-disable-next-line no-console
  console.log('\n✨ Be sure to have recently run this: yarn build-extension');

  const manifestLocation = path.join(lighthouseExtensionPath, 'manifest.json');
  const lighthouseCategories = Object.keys(config.categories);
  let browser;
  let extensionPage;
  let originalManifest;

  function getAuditElementsCount({category, selector}) {
    return extensionPage.evaluate(
      ({category, selector}) =>
        document.querySelector(`#${category}`).parentNode.querySelectorAll(selector).length,
      {category, selector}
    );
  }

  before(async function() {
    // eslint-disable-next-line
    this.timeout(90 * 1000);

    // read original manifest
    originalManifest = fs.readFileSync(manifestLocation);

    const manifest = JSON.parse(originalManifest);
    // add tabs permision to the manifest
    manifest.permissions.push('tabs');
    // write new file to document
    fs.writeFileSync(manifestLocation, JSON.stringify(manifest, null, 2));

    // start puppeteer
    browser = await puppeteer.launch({
      headless: false,
      executablePath: process.env.CHROME_PATH,
      args: [
        `--disable-extensions-except=${lighthouseExtensionPath}`,
        `--load-extension=${lighthouseExtensionPath}`,
      ],
    });

    const page = await browser.newPage();
    await page.goto('https://www.paulirish.com', {waitUntil: 'networkidle2'});
    const targets = await browser.targets();
    const extensionTarget = targets.find(({_targetInfo}) => {
      return _targetInfo.title === 'Lighthouse' && _targetInfo.type === 'background_page';
    });

    if (!extensionTarget) {
      return await browser.close();
    }

    const client = await extensionTarget.createCDPSession();
    const lighthouseResult = await client.send('Runtime.evaluate', {
      expression: `runLighthouseInExtension({
          restoreCleanState: true,
        }, ${JSON.stringify(lighthouseCategories)})`,
      awaitPromise: true,
      returnByValue: true,
    });

    if (lighthouseResult.exceptionDetails) {
      // Log the full result if there was an error, since the relevant information may not be found
      // in the error message alone.
      console.error(lighthouseResult); // eslint-disable-line no-console
      if (lighthouseResult.exceptionDetails.exception) {
        throw new Error(lighthouseResult.exceptionDetails.exception.description);
      }

      throw new Error(lighthouseResult.exceptionDetails.text);
    }

    extensionPage = (await browser.pages()).find(page =>
      page.url().includes('blob:chrome-extension://')
    );
  });

  after(async () => {
    // put the default manifest back
    fs.writeFileSync(manifestLocation, originalManifest);

    if (browser) {
      await browser.close();
    }
  });


  const selectors = {
    audits: '.lh-audit,.lh-timeline-metric,.lh-perf-hint',
    titles: '.lh-score__title, .lh-perf-hint__title, .lh-timeline-metric__title',
  };

  it('should contain all categories', async () => {
    const categories = await extensionPage.$$(`#${lighthouseCategories.join(',#')}`);
    assert.equal(
      categories.length,
      lighthouseCategories.length,
      `${categories.join(' ')} does not match ${lighthouseCategories.join(' ')}`
    );
  });

  it('should contain audits of all categories', async () => {
    for (const category of lighthouseCategories) {
      let expected = getAuditsOfCategory(category).length;
      if (category === 'performance') {
        expected = getAuditsOfCategory(category).filter(a => !!a.group).length;
      }

      const elementCount = await getAuditElementsCount({category, selector: selectors.audits});

      assert.equal(
        expected,
        elementCount,
        `${category} does not have the correct amount of audits`
      );
    }
  });

  it('should contain a filmstrip', async () => {
    const filmstrip = await extensionPage.$('.lh-filmstrip');

    assert.ok(!!filmstrip, `filmstrip is not available`);
  });

  it('should not have any audit errors', async () => {
    function getDebugStrings(elems, selectors) {
      return elems.map(el => {
        const audit = el.closest(selectors.audits);
        const auditTitle = audit && audit.querySelector(selectors.titles);
        return {
          debugString: el.textContent,
          title: auditTitle ? auditTitle.textContent : 'Audit title unvailable',
        };
      });
    }

    const auditErrors = await extensionPage.$$eval('.lh-debug', getDebugStrings, selectors);
    const errors = auditErrors.filter(item => item.debugString.includes('Audit error:'));
    assert.deepStrictEqual(errors, [], 'Audit errors found within the report');
  });
});
