import c from 'chalk'
import { bybits, config } from './config'
import { AccountTypeV5, OrderSideV5, OrderTypeV5, RestClientV5 } from 'bybit-api'
import { randomUUID } from 'crypto'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Extract the global token, orderType, and orderSide from the configuration
const token = config.token
const pair = `${token}USDT`
const orderType = config.orderType as OrderTypeV5
const orderSide: OrderSideV5 = !process.argv[2] ? (config.orderSide as OrderSideV5) : process.argv[2] === 'buy' ? 'Buy' : 'Sell'

const timeout = config.timeout

class BybitSeller {
  account: { name: string; apiKey: string; secret: string }
  client: RestClientV5
  color: string = '#559922'

  constructor(options: any) {
    this.account = options
    this.client = new RestClientV5({ ...options })
    if (this.account.name) this.color = '#' + Buffer.from(this.account.name).toString('hex').substring(0, 6)
  }

  l(...args: any[]): undefined {
    args = Array.from(args)
    args.unshift(c.hex(this.color)(this.account.name) + ':')

    return console.log.apply(console, args) as unknown as undefined
  }

  getCoin = async (coin: string, accountType: AccountTypeV5 = 'UNIFIED') =>
    this.client
      .getCoinBalance({ coin, accountType })
      .then((r) => r.result.balance)
      .catch((e) => this.l(c.red('Get coin error:'), e.message))

  getCoinBalance = async (coin: string, accountType: AccountTypeV5 = 'UNIFIED') =>
    this.getCoin(coin, accountType).then((r) => r?.walletBalance)

  transferCoin = async (coin: string, from: AccountTypeV5, to: AccountTypeV5) => {
    const amount = await this.getCoinBalance(coin, from)

    return this.client
      .createInternalTransfer(randomUUID(), coin, amount, from, to)
      .then((r) =>
        r.result.transferId
          ? this.l(c.green(`Transfer ${c.cyan(amount + ' ' + coin)} to UNIFIED successful!`))
          : this.l(c.red('Transfer coin failed!'))
      )
      .catch((e) => this.l(c.red('Transfer funds error:'), e.message))
  }

  getTicker = async () =>
    this.client
      .getTickers({
        category: 'spot',
        symbol: pair
      })
      .then((r) => r.result.list[0])
      .catch((e) => this.l(c.red('Get ticker error:'), e.message))

  getBalances = async () => {
    const [fundingTokenBalance, unifiedTokenBalance, fundingUSDTBalance, unifiedUSDTBalance] = await Promise.all([
      await this.getCoinBalance(token, 'FUND'),
      await this.getCoinBalance(token, 'UNIFIED'),
      await this.getCoinBalance('USDT', 'FUND'),
      await this.getCoinBalance('USDT', 'UNIFIED')
    ])

    this.l(
      `${c.cyan(token)} balance:`,
      +fundingTokenBalance > 0 ? c.green(`${fundingTokenBalance}`) : c.grey(`${fundingTokenBalance}`),
      c.grey('(funding)'),
      +unifiedTokenBalance > 0 ? c.green(`${unifiedTokenBalance}`) : c.grey(`${unifiedTokenBalance}`),
      c.grey('(unified)')
    )

    this.l(
      `${c.cyan('USDT')} balance:`,
      +fundingUSDTBalance > 0 ? c.green(`${fundingUSDTBalance}`) : c.grey(`${fundingUSDTBalance}`),
      c.grey('(funding)'),
      +unifiedUSDTBalance > 0 ? c.green(`${unifiedUSDTBalance}`) : c.grey(`${unifiedUSDTBalance}`),
      c.grey('(unified)')
    )

    return {
      fundingTokenBalance,
      unifiedTokenBalance,
      fundingUSDTBalance,
      unifiedUSDTBalance
    }
  }

  waitToken = async () => {
    while (true) {
      const { fundingTokenBalance, unifiedTokenBalance, unifiedUSDTBalance } = await this.getBalances()

      if (+fundingTokenBalance > 0) await this.transferCoin(token, 'FUND', 'UNIFIED')

      const { lastPrice } = await this.getTicker()
      this.l(`current SPOT price of ${c.cyan(pair)}:`, lastPrice)

      if (+unifiedTokenBalance > 0 || +unifiedUSDTBalance > 0) {
        if (await this.createOrder()) break
      }

      await sleep(timeout)
    }
  }

  createOrder = async () => {
    let completed: any = false
    const fromCoin = orderSide === 'Buy' ? 'USDT' : token
    const toCoin = orderSide === 'Buy' ? token : 'USDT'
    let fromAmount = await this.getCoinBalance(fromCoin, 'UNIFIED')
    let toAmount

    if (fromCoin === 'USDT') fromAmount = String(Number(await this.getCoinBalance(fromCoin, 'UNIFIED')) * 0.99)

    while (!completed) {
      if (+fromAmount > config.maxOrderAmount) fromAmount = String(config.maxOrderAmount)
      else fromAmount = Number(fromAmount).toFixed(3)

      const { lastPrice, ask1Price, bid1Price } = await this.getTicker()
      this.l(`last price: ${c.yellow(lastPrice)}, ask price: ${c.red(ask1Price)}, bid price: ${c.green(bid1Price)}`)
      let price = orderSide === 'Sell' ? ask1Price : bid1Price

      if (fromCoin === 'USDT') toAmount = (+fromAmount / +price).toFixed(2)
      else toAmount = (+fromAmount * +price).toFixed(2)

      if (+toAmount < 0.01) {
        this.l(c.magenta(`all funds sold!`))
        completed = true
        break
      }

      this.l(
        `create ${orderSide === 'Buy' ? c.green('BUY') : c.red('SELL')} order:`,
        c.cyan(`${fromAmount} ${fromCoin}`),
        'to',
        c.cyan(`${toAmount} ${toCoin}`),
        `with price ${c.magenta(price)}`
      )

      const order = await this.client.submitOrder({
        category: 'spot',
        symbol: pair,
        side: orderSide,
        orderType: orderType,
        qty: toAmount,
        ...(orderType === 'Limit' ? { price } : {})
      })

      if (order.retCode === 0) this.l(c.green(`order ${order.result.orderId} created!`))
      else this.l(c.red(`something wrong:`), order.retMsg)

      await sleep(timeout)

      await this.client
        .cancelAllOrders({
          category: 'spot',
          symbol: pair
        })
        .then((r) => (r.retCode === 0 ? this.l(c.gray(`all orders canceled!`)) : this.l(c.red(`cancel orders error:`), r.retMsg)))

      fromAmount = await this.getCoinBalance(fromCoin, 'UNIFIED')
    }

    return this.getBalances()
  }
}

for (const account of bybits) {
  new BybitSeller(account).waitToken()
}
