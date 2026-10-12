import { findTrade, orderAwaitingBuyer } from '../../../server/floor';
import CheckoutSlip from '../../ui/CheckoutSlip';

export const dynamic = 'force-dynamic';

/**
 * Where the processor sends a buyer back to.
 *
 * PayPal's return URL carries only the trade, so this page has to work out which room the deal
 * happened in and what the books say about it now. It reads the processor's queue rather than its
 * approve endpoint, because approving is the move that captures money and this page is loaded by a
 * browser, not signed by an operator.
 */
export default async function CheckoutReturnPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const tradeId = typeof params.trade === 'string' ? params.trade.trim() : '';
  const found = tradeId.length > 0 ? findTrade(tradeId) : null;
  const trade = found?.trade ?? null;
  let awaitingBuyer: boolean | null = null;
  if (found !== null && trade !== null && trade.phase === 'funded' && trade.orderId !== null) {
    awaitingBuyer = await orderAwaitingBuyer(found.floorId, trade.orderId);
  }
  return <CheckoutSlip kind="return" trade={trade} floorId={found?.floorId ?? null} awaitingBuyer={awaitingBuyer} />;
}
