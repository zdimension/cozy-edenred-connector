const {
  log,
  cozyClient,
  updateOrCreate,
  BaseKonnector,
  categorize
} = require('cozy-konnector-libs')
const moment = require('moment')
const { getEdenredData } = require('./edenred')
const { getClientTokens, getToken } = require('./auth')
const doctypes = require('cozy-doctypes')
const { Document, BankAccount, BankTransaction, BankingReconciliator } =
  doctypes

Document.registerClient(cozyClient)

const minilog = require('@cozy/minilog')
minilog.suggest.allow('cozy-client', 'info')

const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })

class EdenredConnector extends BaseKonnector {
  async fetch(fields) {
    if (!fields.login) {
      throw new Error('Missing login')
    }
    if (process.env.NODE_ENV !== 'standalone') {
      cozyClient.new.login()
    }

    log('info', 'Authenticating ...')
    this.authData = await getClientTokens()
    if (fields.token === undefined) {
      log('info', 'Getting token from credentials ...')
      this.authData.token = await getToken(this, fields.login, fields.password)
    } else {
      this.authData.token = fields.token
    }
    log('info', 'Successfully logged in')

    if (this.browser) {
      await this.browser.close()
    }
    try {
      const edenredData = await getEdenredData(fields.login, this.authData)

      log('info', 'Successfully fetched data')
      log('info', 'Parsing ...')

      const accounts = this.parseAccounts(edenredData)
      const operations = this.parseOps(
        edenredData.flatMap(card => card.operations)
      )
      const categorizedTransactions = await categorize(operations)
      const { accounts: savedAccounts } = await reconciliator.save(
        accounts,
        categorizedTransactions
      )

      log('info', savedAccounts)

      const balances = await fetchBalances(savedAccounts)
      await saveBalances(balances)
    } catch (e) {
      log('error', e)
      log('error', e.stack)
    }
  }

  parseAccounts(cards) {
    return cards.map(card => {
      const wallet = card.wallets.filter(w => w.product_ref === 'CTR_H')[0] // TODO: is there ever more than 1 wallet?
      return {
        vendorId: card.card_ref,
        number: card.card_ref,
        currency: wallet.currency,
        institutionLabel: 'Edenred',
        label: card.employer.name,
        balance: wallet.total_balance / 100,
        type: 'Checkings'
      }
    })
  }

  parseOps(ops) {
    return ops.map(op => {
      const wallet = op.transaction_details.wallets.filter(
        w => w.product_ref === 'CTR_H'
      )[0] // TODO: same
      return {
        vendorId: op.operation_ref,
        vendorAccountId: op.card.card_ref,
        amount: wallet.amount / 100,
        date: op.date,
        dateOperation: op.date,
        dateImport: new Date().toISOString(),
        currency: op.currency,
        label: op.outlet.name,
        originalBankLabel: op.outlet.name
      }
    })
  }
}

const fetchBalances = accounts => {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await getBalanceHistory(currentYear, account._id)
      history.balances[todayAsString] = account.balance

      return history
    })
  )
}

const getBalanceHistory = async (year, accountId) => {
  const index = await cozyClient.data.defineIndex(
    'io.cozy.bank.balancehistories',
    ['year', 'relationships.account.data._id']
  )
  const options = {
    selector: { year, 'relationships.account.data._id': accountId },
    limit: 1
  }
  const [balance] = await cozyClient.data.query(index, options)

  if (balance) {
    log(
      'info',
      `Found a io.cozy.bank.balancehistories document for year ${year} and account ${accountId}`
    )
    return balance
  }

  log(
    'info',
    `io.cozy.bank.balancehistories document not found for year ${year} and account ${accountId}, creating a new one`
  )
  return getEmptyBalanceHistory(year, accountId)
}

const getEmptyBalanceHistory = (year, accountId) => {
  return {
    year,
    balances: {},
    metadata: {
      version: 1
    },
    relationships: {
      account: {
        data: {
          _id: accountId,
          _type: 'io.cozy.bank.accounts'
        }
      }
    }
  }
}

const saveBalances = balances => {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

const connector = new EdenredConnector({
  cheerio: false,
  json: false
})

connector.run()
