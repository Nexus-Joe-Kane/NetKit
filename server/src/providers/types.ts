import type {
  AddressRecord,
  BroadbandAvailability,
  BroadbandOffer,
  LineRecord,
  SignalReport,
} from '@sw/shared';

export interface ProviderMeta {
  readonly name: string;
  readonly label: string;
  /** True when real credentials/endpoints are present. */
  readonly configured: boolean;
  /** `live` when it talks to a real API, `mock` when it returns fixtures. */
  readonly mode: 'live' | 'mock';
}

export interface AddressProvider extends ProviderMeta {
  /** Every premises at a postcode — this is what fills the dropdown. */
  byPostcode(postcode: string): Promise<AddressRecord[]>;
  /** Exact premises by UPRN. */
  byUprn(uprn: string): Promise<AddressRecord | null>;
  /** Free-text search over first line of address etc. */
  search(query: string, limit: number): Promise<AddressRecord[]>;
}

export interface AvailabilityProvider extends ProviderMeta {
  forAddress(address: AddressRecord): Promise<BroadbandAvailability>;
}

/**
 * Extra options at a premises, beyond the primary wholesale chain.
 *
 * Two kinds of thing land here, and both are *additive* rather than
 * competing:
 *
 * - **Alt-net and cable coverage** — CityFibre, Virgin Media, Community
 *   Fibre, G.Network. No single source knows about all of them.
 * - **A second wholesale supplier** — Giacom carry BT Wholesale, CityFibre,
 *   TalkTalk and Virgin Media Business, so the same premises can be sellable
 *   through more than one account at different prices.
 *
 * Deliberately separate from `AvailabilityProvider`, which is
 * first-usable-wins: Zen's Openreach answer is authoritative and a second
 * opinion on it only contradicts confusingly. These results are merged into
 * the report, deduped per operator+technology, with the source that actually
 * checked the address winning over one that only knows the footprint.
 */
export interface OfferProvider extends ProviderMeta {
  forAddress(address: AddressRecord): Promise<BroadbandOffer[]>;
}

export interface SignalProvider extends ProviderMeta {
  forAddress(address: AddressRecord): Promise<SignalReport>;
}

export interface LineProvider extends ProviderMeta {
  byCli(cli: string): Promise<LineRecord[]>;
  byAccessId(accessLineId: string): Promise<LineRecord[]>;
  byServiceId(serviceId: string): Promise<LineRecord[]>;
  byOntSerial(serial: string): Promise<LineRecord[]>;
  byUprn(uprn: string): Promise<LineRecord[]>;
  /**
   * Optional postcode sweep. Zen has no UPRN search key, so finding every
   * line at a premises means listing the postcode and filtering by UPRN.
   */
  byPostcode?(postcode: string): Promise<LineRecord[]>;
}
