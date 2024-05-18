const puppeteer = require('puppeteer-extra')
const StealthPlugin = require('puppeteer-extra-plugin-stealth')
puppeteer.use(StealthPlugin())
const { log } = require('cozy-konnector-libs')
const fs = require('fs')

module.exports = {
  getClientTokens: async function () {
    const htmlContent = await fetch('https://www.myedenred.fr').then(res =>
      res.text()
    )
    const jsUrl = htmlContent.match(
      /<link rel="modulepreload" crossorigin href="(\/assets\/common\.[^"]*)">/
    )[1]
    // get client ID and secret from https://myedenred.fr/js/parameters.36712c67.js
    // the code contains "ClientId":"..." and "ClientSecret":"...
    // just fetch that JS file and look up
    // todo: this is really weird, right?
    const jsContent = await fetch(`https://www.myedenred.fr${jsUrl}`).then(
      res => res.text()
    )
    const clientId = jsContent.match(/ClientId:([^,]*),/)[1]
    const clientSecret = jsContent.match(/ClientSecret:([^,]*),/)[1]
    const clientIdVal = jsContent.match(new RegExp(`,${clientId}="([^"]*)"`))[1]
    const clientSecretVal = jsContent.match(
      new RegExp(`,${clientSecret}="([^"]*)"`)
    )[1]
    return { clientId: clientIdVal, clientSecret: clientSecretVal }
  },

  getToken: async function (connector, username, password) {
    log('info', `${username} ${password}`)
    // TODO(zdimension): why doesn't Edenred provide an open API for this...
    // each login requires providing an SMS-sent OTP code and there's no way
    // to get a permanent token
    log('info', 'Get token')
    let dataDir = `./data/${username}`
    // create data dir if it doesn't exist
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir)
    }
    let browser = await puppeteer.launch({
      headless: false,
      userDataDir: dataDir
    })
    let page = await browser.newPage()
    await page.goto('https://myedenred.fr/connexion')
    await page.waitForTimeout(2000)

    try {
      log('info', 'Waiting for profile button')
      await page.waitForSelector('#btn-profil-nav', { timeout: 5000 })
    } catch (e) {
      log('info', 'Not logged in')

      // if not on /connexion, go to it
      if (!page.url().includes('/connexion') && !page.url().includes('password')) {
        await page.goto('https://myedenred.fr/connexion')
      }

      try {
        const onetrust = '#onetrust-accept-btn-handler'
        const onetrustBtn = await page.waitForSelector(onetrust, {
          timeout: 1000
        })
        log('info', 'Cookies')

        if (onetrustBtn !== null) {
          await Promise.all([page.waitForNetworkIdle(), page.click(onetrust)])
        }
      } catch (e) {
        //
      }

      await page.waitForSelector('input[name="Username"]')
      log('info', 'username found')
      const form = await page.$('form')

      await form.$('input[name="Username"]').then(el => el.type(username))
      await form.$('input[name="Password"]').then(el => el.type(password))
      await page.waitForTimeout(200)
      await form.$('button[type="submit"]').then(el => el.click())

      await page.waitForSelector('input.verifyotp-number', { timeout: 20000 })

      const two_fa_form = await page.$('form')
      if (two_fa_form) {
        await connector.deactivateAutoSuccessfulLogin()

        /* let code;
                          if (process.env.COZY_JOB_MANUAL_EXECUTION !== 'true') {
                              const readline = require('readline').createInterface({
                                  input: process.stdin,
                                  output: process.stdout
                              });
                              code = await new Promise(resolve => readline.question('Enter 2FA code: ', resolve));
                              readline.close();
                          } else {
                              await connector.waitForTwoFaCode();
                          }
              
                          // code is in form 123456
                          // fields are input class="verifyotp-number" data-index="N" with N in [0, 5]
                          for (let i = 0; i < 6; i++) {
                              await two_fa_form.$(`input[class="verifyotp-number"][data-index="${i}"]`).then(el => el.type(code[i]));
                          }
                          await two_fa_form.$('button[id="sendOtp"]').then(el => el.click());
              
                          await page.wai*/
        await page.waitForSelector('#btn-profil-nav', { timeout: 0 })
      }
    }

    log('info', 'Logged in')
    const bearer = await page.evaluate(() =>
      sessionStorage.getItem('access_token')
    )
    log('info', 'Closing browser')
    await browser.close()

    log('info', 'Client ID and secret found')
    await connector.notifySuccessfulLogin()
    log('info', 'Auth done')
    return bearer
  }
}
