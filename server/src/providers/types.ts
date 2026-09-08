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
 * Alt-net and cable coverage — everything that is not sold through the
 * wholesale chain we buy from.
 *
 * Deliberately a separate capability rather than part of `AvailabilityProvider`.
 * Wholesale availability is first-usable-wins, because Zen's answer for
 * Openreach is authoritative and a second opinion adds nothing. Alt-net
 * coverage is *additive*: no single source knows about all of CityFibre,
 * Virgin Media, Community Fibre and G.Network, so these results are merged
 * into the report rather than competing to replace it.
 */
export interface AltnetProvider extends ProviderMeta {
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
