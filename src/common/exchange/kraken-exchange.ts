import { ForbiddenException } from '@nestjs/common';
import { ExchangeNameEnum } from '@prisma/client';
import { kraken } from 'ccxt';
import { EMPTY, catchError, delay, expand, from, reduce, tap } from 'rxjs';
import { GetExchangeDto } from 'src/common/exchange/dto';
import { BaseExchange } from 'src/common/exchange/exchange.base';

export class KrakenExchange extends BaseExchange {
  public exchange: kraken;
  constructor(exchangeDto: GetExchangeDto) {
    super(exchangeDto);
    this.name = ExchangeNameEnum.KRAKEN;
    this.exchange = new kraken({
      apiKey: this.apiKey,
      secret: this.apiSecret,
    });
    // Respect the exchange's rate limits (https://docs.kraken.com/rest/#section/Rate-Limits)
    this.requestDelay = 2000;
  }

  /**
   * Send a sample request to ensure that the provided credentials are correct.
   */
  async validateCredentials() {
    try {
      await this.exchange.privatePostGetWebSocketsToken();
      return true;
    } catch (err) {
      // A PermissionDenied will be thrown if websockets are not enabled on the API credentials
      if (err.name in ['AuthenticationError', 'PermissionDenied']) {
        return false;
      }
      throw new ForbiddenException(err);
    }
  }

  /**
   * Ensure that the provided credentials do not have access to sensitive information.
   *
   * The `fetchBalance` fn should throw an error.
   */
  async validateCredentialLimitations() {
    try {
      // It should throw an error
      await this.exchange.fetchBalance();

      // These credentials should not be accepted
      return false;
    } catch (err) {
      if (err.name === 'PermissionDenied') {
        return true;
      }
      throw new Error(err);
    }
  }

  private _fetchClosedOrders(
    startDateObj: Date,
    endDateObj: Date,
    ofs: number,
  ) {
    this.logger.log(
      `Fetching orders: startDate ${startDateObj.toISOString()} (${
        startDateObj.getTime() / 1000
      }), endDate ${endDateObj.toISOString()} (${
        endDateObj.getTime() / 1000
      }), offset ${ofs}`,
    );
    const symbol = undefined;
    const since = undefined;
    const limit = undefined;
    return this.exchange.fetchClosedOrders(symbol, since, limit, {
      trades: true,
      start: startDateObj.getTime() / 1000,
      end: endDateObj.getTime() / 1000,
      ofs,
    });
  }

  /**
   * Sync the orders of a user with his exchange account
   *
   * See API endpoint details here: https://docs.kraken.com/rest/#tag/Account-Data/operation/getClosedOrders
   */
  // You were here, using previously the lastOrder param.
  syncOrders(startDateObj: Date, endDateObj: Date) {
    // Default kraken API page size
    const pageSize = 50;

    this.logger.debug(
      `[START] Sync orders using key "${this.apiKey}" in "${this.name}"`,
    );

    let page = 1;
    let ofs = 0;
    // Request the first page
    const paginationObs = from(
      Promise.resolve(this._fetchClosedOrders(startDateObj, endDateObj, ofs)),
    ).pipe(
      catchError((error: any) => {
        this.logger.error(error);
        throw new Error(`An ${error.name} error occurred (${error})`);
      }),
      tap(() => this.logger.log(`Fetched page: ${page}, ofs: ${ofs}`)),
      tap(() =>
        this.logger.log(
          `Going to sleep for ${this.requestDelay / 1000}secs...`,
        ),
      ),
      // Delay the next request to respect the exchange rate limits
      delay(this.requestDelay),
      tap(() => this.logger.log(`Slept for ${this.requestDelay / 1000}secs`)),
      // Use expand to recursively request the next pages
      expand((res) => {
        if (res.length < pageSize) {
          return EMPTY;
        }

        // Adjust pagination params to fetch the next page
        page += 1;
        ofs += res.length;

        return from(
          // Use ofset pagination for a given date window
          Promise.resolve(
            this._fetchClosedOrders(startDateObj, endDateObj, ofs),
          ),
        ).pipe(
          catchError((error: any) => {
            this.logger.error(error);
            throw new Error(`An ${error.name} error occurred (${error})`);
          }),
          tap(() => this.logger.log(`  - Fetched page: ${page}, ofs: ${ofs}`)),
          tap(() =>
            this.logger.log(
              `About to sleep for ${this.requestDelay / 1000}secs...`,
            ),
          ),
          delay(this.requestDelay),
          tap(() =>
            this.logger.log(`Slept for ${this.requestDelay / 1000}secs`),
          ),
        );
      }),
      tap(() => this.logger.log(`    * Processing page ${page}`)),
      reduce((allOrders, orderPage) => {
        const allOrdersObj = {};
        const orderedres = [];
        console.log('IN REDUCE: ');
        orderPage.forEach((o) => {
          orderedres.push({ dt: o.datetime, orderId: o.id });
          allOrdersObj[o.id] = o;
        });
        console.log(
          `Orders count: ${orderedres.length}, page: ${page}, offset: ${ofs}`,
        );
        console.log({ orderedres });
        return allOrders.concat(orderPage);
      }, []),
      tap(() => {
        this.logger.debug(
          `[END] Sync orders using key "${this.apiKey}" in "${this.name}"`,
        );
      }),
    );

    return paginationObs;
  }
}
