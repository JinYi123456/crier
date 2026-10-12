import { findTrade } from '../../../server/floor';
import CheckoutSlip from '../../ui/CheckoutSlip';

export const dynamic = 'force-dynamic';

/**
 * Where the processor sends a buyer who walked away.
 *
 * Nothing here is rolled back, because nothing moved: an order the buyer never approved is not
 * capturable, and the escrow on our side of the books is still theirs. The trade stays on the pile,
 * which is the honest place to leave a decision that needs a person.
 */
export default async function CheckoutCancelPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<React.ReactElement> {
  const params = await searchParams;
  const tradeId = typeof params.trade === 'string' ? params.trade.trim() : '';
  const found = tradeId.length > 0 ? findTrade(tradeId) : null;
  return <CheckoutSlip kind="cancel" trade={found?.trade ?? null} floorId={found?.floorId ?? null} awaitingBuyer={null} />;
}
