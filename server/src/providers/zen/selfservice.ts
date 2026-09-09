import { normaliseCli, type AccessTechnology, type AddressRecord } from '@sw/shared';
import type {
  AddressMatch,
  AddressRegistration,
  AppointmentSlot,
  CallRecord,
  EstateUsageReport,
  EstateUsageRow,
  EthernetQuote,
  EthernetQuoteSet,
  NetworkConfiguration,
  NetworkOption,
  NumberPortCheck,
  OrderQuote,
  OrderRecord,
  OrderState,
  PlaceOrderRequest,
  PlaceOrderResult,
  ProviderNotification,
  PriceLine,
  RdnsRecord,
  ServiceHistory,
  ServiceHistoryEvent,
  SimState,
} from '@sw/shared';
import { zenCall } from './client';
import { mapZenAddress, technologyFromProduct } from './normalise';
import { pickArray, pickBool, pickDate, pickNumber, pickString } from './map';

/**
 * Zen Indirect Self Service API — everything beyond availability and services.
 *
 * Orders, number porting, Ethernet quotes, the cellular/SIM estate, call
 * records and reverse DNS. Enum fields that Zen documents as bare integers
 * are read tolerantly and fall back to `unknown` rather than being guessed.
 */

const text = (v?: string): string | undefined => {
  const s = (v ?? '').trim();
  return s === '' || s === 'string' ? undefined : s;
};

/* ------------------------------------------------------------------ *
 * Orders
 * ------------------------------------------------------------------ */

/** Zen's documented supplier enum. */
const SUPPLIERS: Record<string, string> = {
  '0': 'All',
  '1': 'Openreach',
  '2': 'BT Wholesale',
  '3': 'CityFibre',
};

function orderState(raw: unknown): OrderState {
  const v = (
    pickString(raw, 'fulfilmentStatus', 'status', 'state', 'fulfilmentState', 'orderStatus') ?? ''
  ).toUpperCase();
  if (v.includes('CANCEL')) return 'cancelled';
  if (v.includes('REJECT')) return 'rejected';
  if (v.includes('COMPLET')) return 'completed';
  if (v.includes('DELAY')) return 'delayed';
  if (v.includes('APPOINT')) return 'awaiting_appointment';
  if (v.includes('PROGRESS') || v.includes('ACCEPTED') || v.includes('COMMITTED')) return 'in_progress';
  if (v.includes('SUBMIT') || v.includes('PLACED') || v.includes('SENT')) return 'submitted';
  if (v.includes('DRAFT')) return 'draft';
  // Fall back to dates, which are unambiguous.
  if (pickDate(raw, 'providerCompletionDate', 'completedDate')) return 'completed';
  if (pickDate(raw, 'orderDate', 'placedDate')) return 'in_progress';
  return 'unknown';
}

function orderType(raw: unknown): OrderRecord['type'] {
  const v = (pickString(raw, 'type', 'orderType') ?? '').toUpperCase();
  if (v.includes('CEASE')) return 'cease';
  if (v.includes('MODIF') || v.includes('CHANGE')) return 'modify';
  if (v.includes('PROVIDE') || v.includes('NEW')) return 'provide';
  return 'unknown';
}

export function mapOrder(raw: unknown, index: number): OrderRecord {
  const installAddress = (raw as { installationAddress?: unknown })?.installationAddress;
  const address = installAddress
    ? mapZenAddress({ address: installAddress as never }, pickString(raw, 'postCode') ?? '')
    : undefined;

  const appointmentDate = pickDate(raw, 'appointmentDate');
  const supplier = SUPPLIERS[String(pickString(raw, 'supplier') ?? pickNumber(raw, 'supplier') ?? '')];

  return {
    zenReference: pickString(raw, 'zenReference', 'reference') ?? `order-${index + 1}`,
    ...(pickString(raw, 'customerReference') ? { customerReference: pickString(raw, 'customerReference') } : {}),
    ...(pickString(raw, 'providerOrderReference', 'orderReference')
      ? { orderReference: pickString(raw, 'providerOrderReference', 'orderReference') }
      : {}),
    type: orderType(raw),
    state: orderState(raw),
    ...(pickString(raw, 'fulfilmentStatusReason', 'stateReason', 'notes')
      ? { stateReason: pickString(raw, 'fulfilmentStatusReason', 'stateReason', 'notes') }
      : {}),
    ...(pickString(raw, 'productDescription', 'product', 'productName')
      ? { productName: pickString(raw, 'productDescription', 'product', 'productName') }
      : {}),
    ...(pickString(raw, 'productCode') ? { productCode: pickString(raw, 'productCode') } : {}),
    ...(normaliseCli(pickString(raw, 'phoneNumber', 'cli') ?? '')
      ? { cli: normaliseCli(pickString(raw, 'phoneNumber', 'cli')!)! }
      : {}),
    ...(pickString(raw, 'serviceId') ? { serviceId: pickString(raw, 'serviceId') } : {}),
    ...(pickString(raw, 'accessLineId') ? { accessLineId: pickString(raw, 'accessLineId') } : {}),
    ...(address?.singleLine ? { address } : {}),
    ...(pickDate(raw, 'orderDate', 'placedDate', 'orderReceivedDate')
      ? { placedAt: pickDate(raw, 'orderDate', 'placedDate', 'orderReceivedDate') }
      : {}),
    ...(pickDate(raw, 'committedDate') ? { committedDate: pickDate(raw, 'committedDate') } : {}),
    ...(pickDate(raw, 'providerPromisedCompletionDate')
      ? { promisedDate: pickDate(raw, 'providerPromisedCompletionDate') }
      : {}),
    ...(pickDate(raw, 'providerCompletionDate', 'completedDate')
      ? { completedAt: pickDate(raw, 'providerCompletionDate', 'completedDate') }
      : {}),
    ...(pickDate(raw, 'preferredActivationDate')
      ? { preferredActivationDate: pickDate(raw, 'preferredActivationDate') }
      : {}),
    ...(appointmentDate || pickString(raw, 'appointmentReference')
      ? {
          appointment: {
            ...(pickString(raw, 'appointmentReference') ? { reference: pickString(raw, 'appointmentReference') } : {}),
            ...(appointmentDate ? { date: appointmentDate } : {}),
            ...(pickString(raw, 'timeslot', 'appointmentTimeslot')
              ? { slot: pickString(raw, 'timeslot', 'appointmentTimeslot') }
              : {}),
            ...(pickString(raw, 'appointmentType') ? { type: pickString(raw, 'appointmentType') } : {}),
          },
        }
      : {}),
    ...(pickString(raw, 'delayReason') ? { delayReason: pickString(raw, 'delayReason') } : {}),
    ...(supplier && supplier !== 'All' ? { supplier } : {}),
    ...(pickBool(raw, 'requiresEngineerAppointment') != null
      ? { requiresEngineer: pickBool(raw, 'requiresEngineerAppointment') }
      : {}),
    ...(pickBool(raw, 'workingLineTakeover') != null
      ? { workingLineTakeover: pickBool(raw, 'workingLineTakeover') }
      : {}),
    ...(pickString(raw, 'contactFullName', 'contactName') ? { contactName: pickString(raw, 'contactFullName', 'contactName') } : {}),
    ...(pickString(raw, 'contactEmail', 'email') ? { contactEmail: pickString(raw, 'contactEmail', 'email') } : {}),
    provider: 'Zen Internet',
    source: 'zen:self-service',
  };
}

/** Orders matching a search term — Zen ref, customer ref or phone number. */
export async function searchOrders(searchTerm?: string): Promise<OrderRecord[]> {
  const json = await zenCall<unknown>('/api/orders/search', {
    scope: 'indirect-order',
    query: {
      ...(searchTerm ? { 'searchCriteria.searchTerm': searchTerm } : {}),
      'searchCriteria.pageSize': 50,
    },
    emptyAsNull: true,
  });
  return pickArray(json, 'fulfilments', 'orders', 'results', 'data', 'items').map(mapOrder);
}

/** In-flight and recently completed provide, modify and cease orders. */
export async function fetchOrderStatus(searchTerm?: string): Promise<OrderRecord[]> {
  const json = await zenCall<unknown>('/api/orders/status', {
    scope: 'indirect-order',
    query: { ...(searchTerm ? { 'request.searchTerm': searchTerm } : {}), 'request.pageSize': 50 },
    emptyAsNull: true,
  });
  return pickArray(json, 'orderStatus', 'orders', 'results', 'data').map(mapOrder);
}

/** The work-in-progress report — the whole in-flight book in one call. */
export async function fetchWipReport(): Promise<OrderRecord[]> {
  const json = await zenCall<unknown>('/api/orders/WipReport', { scope: 'indirect-order', emptyAsNull: true });
  return pickArray(json, 'wip', 'results', 'data', 'items').map(mapOrder);
}

export async function cancelOrder(zenReference: string, reason: string): Promise<{ ok: boolean; message?: string }> {
  const json = await zenCall<unknown>(`/api/orders/${encodeURIComponent(zenReference)}/Cancel`, {
    scope: 'indirect-order',
    method: 'POST',
    body: { reason, type: 0 },
    emptyAsNull: true,
  });
  return {
    ok: true,
    ...(pickString(json, 'message', 'status') ? { message: pickString(json, 'message', 'status') } : {}),
  };
}

/**
 * Places a real order.
 *
 * The only write in NetKit that spends money, so it is the only one that
 * refuses to guess: every field is passed through as given, nothing is
 * defaulted on the operator's behalf, and the provider's own validation
 * messages are returned verbatim rather than being summarised.
 */
export async function placeOrder(request: PlaceOrderRequest): Promise<PlaceOrderResult> {
  // The appointment token is the opaque JSON handed back by
  // `fetchAppointments`, so a slot can only be booked as the provider
  // offered it. A token we cannot parse is dropped rather than invented.
  let appointment: Record<string, unknown> | undefined;
  if (request.appointmentToken) {
    try {
      const parsed: unknown = JSON.parse(request.appointmentToken);
      if (parsed && typeof parsed === 'object') appointment = parsed as Record<string, unknown>;
    } catch {
      appointment = undefined;
    }
  }

  const json = await zenCall<unknown>('/api/order', {
    scope: 'indirect-placeorder',
    method: 'POST',
    body: {
      availabilityReference: request.availabilityReference,
      productCode: request.productCode,
      ...(request.productName ? { productName: request.productName } : {}),
      installationDetails: {
        goldAddressKey: request.goldAddressKey,
        districtCode: request.districtCode,
        ...(request.uprn ? { uprn: request.uprn } : {}),
        address: request.addressLine,
        postCode: request.postcode,
        ...(request.phoneNumber ? { phoneNumber: request.phoneNumber } : {}),
        ...(request.accessLineId ? { accessLineId: request.accessLineId } : {}),
        ...(request.ontSerialNumber ? { ontDetails: { serialNumber: request.ontSerialNumber } } : {}),
      },
      ...(appointment ? { appointment } : {}),
      ...(request.workingLineTakeover != null ? { workingLineTakeover: request.workingLineTakeover } : {}),
      ...(request.contractTermMonths != null ? { contractTerm: request.contractTermMonths } : {}),
      ...(request.preferredActivationDate ? { preferredActivationDate: request.preferredActivationDate } : {}),
      ...(request.customerReference ? { customerReference: request.customerReference } : {}),
      ...(request.contactName || request.contactNumber || request.contactEmail
        ? {
            contactDetails: {
              ...(request.contactName ? { name: request.contactName } : {}),
              ...(request.contactNumber ? { phoneNumber: request.contactNumber } : {}),
              ...(request.contactEmail ? { emailAddress: request.contactEmail } : {}),
            },
          }
        : {}),
      ...(request.notes ? { notes: request.notes } : {}),
    },
    emptyAsNull: true,
  });

  const zenReference = text(pickString(json, 'zenReference', 'reference', 'fulfilmentReference'));
  const messages = pickArray(json, 'messages', 'validationMessages', 'errors')
    .map((m) => text(pickString(m, 'description', 'message', 'text')) ?? (typeof m === 'string' ? m : undefined))
    .filter((m): m is string => Boolean(m));

  // A reference is the only unambiguous evidence the order landed. Zen
  // return 200 with validation messages and no reference when it did not.
  const accepted = Boolean(zenReference);

  return {
    accepted,
    ...(zenReference ? { zenReference } : {}),
    ...(text(pickString(json, 'orderReference', 'customerReference')) ? { orderReference: text(pickString(json, 'orderReference', 'customerReference')) } : {}),
    ...(accepted ? { state: orderState(json) } : {}),
    ...(text(pickString(json, 'message', 'status', 'statusDescription'))
      ? { message: text(pickString(json, 'message', 'status', 'statusDescription')) }
      : {}),
    ...(messages.length ? { messages } : {}),
    ...(pickDate(json, 'committedDate', 'promisedDate') ? { committedDate: pickDate(json, 'committedDate', 'promisedDate') } : {}),
    source: 'zen:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Pricing and appointments
 * ------------------------------------------------------------------ */

export async function fetchPricing(productCode: string, productName?: string): Promise<OrderQuote> {
  const json = await zenCall<unknown>('/api/pricingDetails', {
    scope: 'indirect-placeorder',
    query: { 'request.productCode': productCode, ...(productName ? { 'request.productName': productName } : {}) },
    emptyAsNull: true,
  });

  const rows = Array.isArray(json) ? json : pickArray(json, 'results', 'data', 'prices');
  const lines: PriceLine[] = rows
    .map((r) => {
      const name = pickString(r, 'productName', 'name');
      const amount = pickNumber(r, 'price', 'amount');
      if (!name || amount == null) return null;
      // `rentalRateFrequency` being present at all means it recurs.
      const recurring = pickNumber(r, 'rentalRateFrequency') != null || pickBool(r, 'isMonthlyRecurringCost') === true;
      return {
        name,
        amount,
        recurring,
        ...(pickString(r, 'rentalRateFrequency') ? { frequency: pickString(r, 'rentalRateFrequency') } : {}),
      };
    })
    .filter((l): l is PriceLine => l !== null);

  return {
    productCode,
    ...(productName ? { productName } : {}),
    lines,
    monthlyTotal: lines.filter((l) => l.recurring).reduce((s, l) => s + l.amount, 0),
    oneOffTotal: lines.filter((l) => !l.recurring).reduce((s, l) => s + l.amount, 0),
    currency: 'GBP',
    source: 'zen:self-service',
  };
}

/** Engineer appointment slots. Needs the availability reference from a check. */
export async function fetchAppointments(params: {
  availabilityReference: string;
  productCode: string;
  goldAddressKey: string;
  districtCode: string;
  appointmentType?: number;
}): Promise<AppointmentSlot[]> {
  const json = await zenCall<unknown>('/api/appointments', {
    scope: 'indirect-availability',
    query: {
      'request.availabilityReference': params.availabilityReference,
      'request.productCode': params.productCode,
      'request.goldAddressKey': params.goldAddressKey,
      'request.districtCode': params.districtCode,
      ...(params.appointmentType != null ? { 'request.appointmentType': params.appointmentType } : {}),
    },
    emptyAsNull: true,
  });

  return pickArray(json, 'availableAppointments', 'appointments', 'results', 'data')
    .map((a): AppointmentSlot | null => {
      const date = pickDate(a, 'date');
      if (!date) return null;
      const slotValue = pickNumber(a, 'timeslot');
      return {
        date,
        // Zen returns the slot as an enum; render the documented meanings and
        // fall back to the raw value so nothing is invented.
        slot: slotValue === 0 ? 'AM' : slotValue === 1 ? 'PM' : slotValue === 2 ? 'All day' : `Slot ${slotValue ?? '?'}`,
        ...(pickNumber(a, 'appointmentType') != null ? { appointmentType: String(pickNumber(a, 'appointmentType')) } : {}),
        token: JSON.stringify({ date, timeSlot: slotValue ?? 0, appointmentType: pickNumber(a, 'appointmentType') ?? 0 }),
      };
    })
    .filter((a): a is AppointmentSlot => a !== null);
}

/* ------------------------------------------------------------------ *
 * Number porting
 * ------------------------------------------------------------------ */

/** Starts a porting check. Asynchronous — poll with `pollNumberPort`. */
export async function startNumberPortCheck(phoneNumber: string, exchangePrefix?: string, cupid?: string): Promise<NumberPortCheck> {
  const json = await zenCall<unknown>('/api/numberPort/availability', {
    scope: 'indirect-availability',
    method: 'POST',
    body: {
      phoneNumber,
      ...(exchangePrefix ? { exchangePrefix } : {}),
      ...(cupid ? { cupid } : {}),
    },
    emptyAsNull: true,
  });

  const reference = pickString(json, 'reference');
  const canBePorted = pickBool(json, 'canBePorted');

  return {
    ...(reference ? { reference } : {}),
    phoneNumber,
    ...(canBePorted != null ? { canBePorted } : {}),
    // Zen answers 202 while the check runs, so no verdict means keep polling.
    pending: canBePorted == null && Boolean(reference),
    ...(exchangePrefix ? { exchangePrefix } : {}),
    ...(cupid ? { cupid } : {}),
    messages: pickArray(json, 'messages', 'errors')
      .map((m) => (typeof m === 'string' ? m : pickString(m, 'message', 'description')))
      .filter((m): m is string => Boolean(m)),
    checkedAt: new Date().toISOString(),
    source: 'zen:self-service',
  };
}

export async function pollNumberPort(reference: string, phoneNumber = ''): Promise<NumberPortCheck> {
  const json = await zenCall<unknown>(`/api/numberPort/availability/${encodeURIComponent(reference)}`, {
    scope: 'indirect-availability',
    emptyAsNull: true,
  });
  const canBePorted = pickBool(json, 'canBePorted');
  return {
    reference,
    phoneNumber: pickString(json, 'phoneNumber') ?? phoneNumber,
    ...(canBePorted != null ? { canBePorted } : {}),
    pending: canBePorted == null,
    messages: pickArray(json, 'messages', 'errors')
      .map((m) => (typeof m === 'string' ? m : pickString(m, 'message', 'description')))
      .filter((m): m is string => Boolean(m)),
    checkedAt: new Date().toISOString(),
    source: 'zen:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Ethernet quotes
 * ------------------------------------------------------------------ */

export async function fetchEthernetQuotes(address: AddressRecord): Promise<EthernetQuoteSet> {
  const json = await zenCall<unknown>('/api/quotes/ethernet', {
    scope: 'indirect-quote',
    query: {
      ...(address.postcode ? { 'request.postCode': address.postcode } : {}),
      ...(address.uprn ? { 'request.uprn': address.uprn } : {}),
      ...(address.addressKey ? { 'request.addressReferenceNumber': address.addressKey } : {}),
    },
    emptyAsNull: true,
  });

  const quotes: EthernetQuote[] = pickArray(json, 'quotes', 'results', 'data', 'items')
    .map((q, i): EthernetQuote | null => {
      const productName = pickString(q, 'productName', 'name', 'product');
      if (!productName) return null;
      return {
        id: pickString(q, 'id', 'quoteReference', 'reference') ?? `eth-${i + 1}`,
        productName,
        ...(pickNumber(q, 'bearer', 'bearerSpeed', 'bearerMbps') != null
          ? { bearerMbps: pickNumber(q, 'bearer', 'bearerSpeed', 'bearerMbps') }
          : {}),
        ...(pickNumber(q, 'committed', 'committedSpeed', 'committedMbps') != null
          ? { committedMbps: pickNumber(q, 'committed', 'committedSpeed', 'committedMbps') }
          : {}),
        technology: technologyFromProduct(productName) as AccessTechnology,
        ...(pickNumber(q, 'monthlyCharge', 'rental', 'recurringCharge') != null
          ? { monthlyCharge: pickNumber(q, 'monthlyCharge', 'rental', 'recurringCharge') }
          : {}),
        ...(pickNumber(q, 'installCharge', 'connectionCharge', 'oneOffCharge') != null
          ? { installCharge: pickNumber(q, 'installCharge', 'connectionCharge', 'oneOffCharge') }
          : {}),
        ...(pickNumber(q, 'excessConstructionCharge', 'ecc') != null
          ? { excessConstruction: pickNumber(q, 'excessConstructionCharge', 'ecc') }
          : {}),
        ...(pickNumber(q, 'termMonths', 'contractTerm') != null
          ? { termMonths: pickNumber(q, 'termMonths', 'contractTerm') }
          : {}),
        ...(pickNumber(q, 'leadTimeDays', 'leadTime') != null
          ? { leadTimeDays: pickNumber(q, 'leadTimeDays', 'leadTime') }
          : {}),
        // Treated as indicative unless the provider explicitly says firm.
        indicative: pickBool(q, 'firm', 'isFirmQuote') !== true,
        notes: pickArray(q, 'notes', 'messages')
          .map((n) => (typeof n === 'string' ? n : pickString(n, 'message', 'text')))
          .filter((n): n is string => Boolean(n)),
        source: 'zen:self-service',
      };
    })
    .filter((q): q is EthernetQuote => q !== null);

  return { address, quotes, checkedAt: new Date().toISOString(), sources: ['zen:self-service'] };
}

/* ------------------------------------------------------------------ *
 * Cellular / SIM estate
 * ------------------------------------------------------------------ */


/*
 * Zen's SIM estate used to be read here and is not any more.
 *
 * Zen's cellular endpoints are Jola-backed, the SIMs are held directly with
 * Jola, and asking both produced a second copy of the same estate with fewer
 * fields on it — which then won the dedupe about half the time and blanked
 * the customer name, the number and the usage on rows Jola had answered
 * properly. Removed rather than left switched off, so nobody re-enables it
 * looking for SIMs that were never really there. Mobile is Jola's job.
 */

/* ------------------------------------------------------------------ *
 * Call records
 * ------------------------------------------------------------------ */

/** Call records. Zen limits the window to two days, which this enforces. */
export async function fetchCallRecords(from: Date, to: Date): Promise<CallRecord[]> {
  const maxWindowMs = 2 * 86_400_000;
  const clampedTo = to.getTime() - from.getTime() > maxWindowMs ? new Date(from.getTime() + maxWindowMs) : to;

  const json = await zenCall<unknown>('/api/calls/cdrs', {
    scope: 'indirect-cdr',
    query: {
      'query.fromDateCreated': from.toISOString().slice(0, 19),
      'query.toDateCreated': clampedTo.toISOString().slice(0, 19),
    },
    emptyAsNull: true,
  });

  return pickArray(json, 'cdrs', 'results', 'data')
    .map((c, i): CallRecord | null => {
      const startedAt = pickString(c, 'started', 'created');
      if (!startedAt) return null;
      return {
        id: String(pickNumber(c, 'id') ?? i + 1),
        startedAt,
        ...(pickString(c, 'sourceNumber') ? { sourceNumber: pickString(c, 'sourceNumber') } : {}),
        ...(pickString(c, 'presentationNumber') ? { presentationNumber: pickString(c, 'presentationNumber') } : {}),
        ...(pickString(c, 'destinationNumber') ? { destinationNumber: pickString(c, 'destinationNumber') } : {}),
        ...(pickNumber(c, 'durationInSeconds') != null ? { durationSeconds: pickNumber(c, 'durationInSeconds') } : {}),
        ...(pickString(c, 'classification') ? { classification: pickString(c, 'classification') } : {}),
        ...(pickString(c, 'destinationDescription', 'geographicalDestinationDescription')
          ? { destinationDescription: pickString(c, 'destinationDescription', 'geographicalDestinationDescription') }
          : {}),
        ...(pickString(c, 'dialCode') ? { dialCode: pickString(c, 'dialCode') } : {}),
        ...(pickNumber(c, 'priceInPounds') != null ? { costPounds: pickNumber(c, 'priceInPounds') } : {}),
        source: 'zen:self-service',
      };
    })
    .filter((c): c is CallRecord => c !== null);
}

/* ------------------------------------------------------------------ *
 * Reverse DNS
 * ------------------------------------------------------------------ */

export async function fetchRdns(zenReference?: string): Promise<RdnsRecord[]> {
  const path = zenReference ? `/api/rdns/${encodeURIComponent(zenReference)}` : '/api/rdns';
  const json = await zenCall<unknown>(path, { scope: 'indirect-broadbandconnection', emptyAsNull: true });

  return pickArray(json, 'records', 'rdns', 'results', 'data')
    .map((r): RdnsRecord | null => {
      const ipAddress = pickString(r, 'ipAddress', 'ip', 'address');
      if (!ipAddress) return null;
      return {
        ipAddress,
        ...(pickString(r, 'hostname', 'ptr', 'name') ? { hostname: pickString(r, 'hostname', 'ptr', 'name') } : {}),
        ...(pickString(r, 'zenReference') ? { zenReference: pickString(r, 'zenReference') } : {}),
        editable: pickBool(r, 'editable', 'canEdit') !== false,
        source: 'zen:self-service',
      };
    })
    .filter((r): r is RdnsRecord => r !== null);
}

/* ------------------------------------------------------------------ *
 * Address references and Openreach registration
 * ------------------------------------------------------------------ */

/**
 * Resolves one address against both wholesale databases.
 *
 * Openreach and BT Wholesale keep separate address lists and disagree over
 * subdivided buildings often enough that a rejected order is usually this.
 */
export async function matchAddress(query: {
  postcode: string;
  postTown?: string;
  premiseName?: string;
  thoroughfareNumber?: string;
}): Promise<AddressMatch> {
  const json = await zenCall<unknown>('/api/address/match', {
    scope: 'indirect-availability',
    query: {
      'request.postCode': query.postcode,
      ...(query.postTown ? { 'request.postTown': query.postTown } : {}),
      ...(query.premiseName ? { 'request.premiseName': query.premiseName } : {}),
      ...(query.thoroughfareNumber ? { 'request.thoroughFareNumber': query.thoroughfareNumber } : {}),
    },
    emptyAsNull: true,
  });

  const bto = text(pickString(json, 'btoAddressReference', 'btoAddressReferenceNumber'));
  const btw = text(pickString(json, 'btwAddressReference', 'btwAddressReferenceNumber'));
  const messages = pickArray(json, 'messages', 'availabilityInformation.messages')
    .map((m) => text(pickString(m, 'description', 'message')))
    .filter((m): m is string => Boolean(m));

  return {
    query,
    ...(bto ? { btoAddressReference: bto } : {}),
    ...(btw ? { btwAddressReference: btw } : {}),
    ...(text(pickString(json, 'districtCode')) ? { districtCode: text(pickString(json, 'districtCode')) } : {}),
    ...(text(pickString(json, 'uprn')) ? { uprn: text(pickString(json, 'uprn')) } : {}),
    // Only claim agreement when both actually answered. One reference and a
    // silence is not agreement, and saying so would be the worst kind of
    // wrong on the screen that exists to spot disagreement.
    agrees: Boolean(bto && btw),
    messages,
    source: 'zen:self-service',
  };
}

/** Registers a premises with Openreach and returns the new address key. */
export async function registerAddress(request: {
  postcode: string;
  buildingName?: string;
  buildingNumber?: string;
  thoroughfare: string;
  postTown: string;
  county?: string;
  uprn?: string;
}): Promise<AddressRegistration> {
  const json = await zenCall<unknown>('/api/bto/addaddress', {
    scope: 'indirect-availability',
    method: 'POST',
    body: {
      postCode: request.postcode,
      ...(request.buildingName ? { buildingName: request.buildingName } : {}),
      ...(request.buildingNumber ? { buildingNumber: request.buildingNumber } : {}),
      thoroughFareName: request.thoroughfare,
      postTown: request.postTown,
      ...(request.county ? { county: request.county } : {}),
      ...(request.uprn ? { uprn: request.uprn } : {}),
    },
    emptyAsNull: true,
  });

  const reference = text(pickString(json, 'addressReferenceNumber', 'addressReference', 'goldAddressKey'));
  return {
    created: Boolean(reference),
    ...(reference ? { addressReference: reference } : {}),
    ...(text(pickString(json, 'districtCode')) ? { districtCode: text(pickString(json, 'districtCode')) } : {}),
    technologyRestrictions: pickArray(json, 'technologyRestrictions', 'restrictions')
      .map((r) => {
        const technology = text(pickString(r, 'technology', 'technologyType', 'name')) ?? (typeof r === 'string' ? r : undefined);
        if (!technology) return null;
        return {
          technology,
          ...(text(pickString(r, 'reason', 'description')) ? { reason: text(pickString(r, 'reason', 'description')) } : {}),
        };
      })
      .filter((r): r is { technology: string; reason?: string } => r !== null),
    messages: pickArray(json, 'messages', 'errors')
      .map((m) => text(pickString(m, 'description', 'message')) ?? (typeof m === 'string' ? m : undefined))
      .filter((m): m is string => Boolean(m)),
    source: 'zen:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Service history
 * ------------------------------------------------------------------ */

export async function fetchServiceHistory(zenReference: string): Promise<ServiceHistory> {
  const json = await zenCall<unknown>(`/api/service/${encodeURIComponent(zenReference)}/history`, {
    scope: 'indirect-service',
    emptyAsNull: true,
  });

  const events = pickArray(json, 'history', 'events', 'results', 'data')
    .map((e): ServiceHistoryEvent | null => {
      const at = pickDate(e, 'date', 'changeDate', 'createdDate', 'at');
      if (!at) return null;
      return {
        at,
        type: text(pickString(e, 'type', 'changeType', 'action')) ?? 'Change',
        ...(text(pickString(e, 'description', 'detail', 'summary'))
          ? { description: text(pickString(e, 'description', 'detail', 'summary')) }
          : {}),
        ...(text(pickString(e, 'previousValue', 'from', 'oldValue'))
          ? { from: text(pickString(e, 'previousValue', 'from', 'oldValue')) }
          : {}),
        ...(text(pickString(e, 'newValue', 'to', 'currentValue'))
          ? { to: text(pickString(e, 'newValue', 'to', 'currentValue')) }
          : {}),
        ...(text(pickString(e, 'reference', 'orderReference')) ? { reference: text(pickString(e, 'reference', 'orderReference')) } : {}),
        ...(text(pickString(e, 'user', 'actor', 'raisedBy')) ? { actor: text(pickString(e, 'user', 'actor', 'raisedBy')) } : {}),
      };
    })
    .filter((e): e is ServiceHistoryEvent => e !== null)
    // Newest first: the last change is nearly always the one being asked about.
    .sort((a, b) => b.at.localeCompare(a.at));

  return { zenReference, events, source: 'zen:self-service' };
}

/* ------------------------------------------------------------------ *
 * Notifications
 * ------------------------------------------------------------------ */

/** Zen documents severity as an integer with no value table, so read both. */
function notificationSeverity(raw: unknown): ProviderNotification['severity'] {
  const value = pickString(raw, 'severity', 'importance', 'level') ?? '';
  const v = value.toUpperCase();
  if (v.includes('CRIT') || v.includes('URGENT') || v === '3') return 'critical';
  if (v.includes('WARN') || v.includes('HIGH') || v === '2') return 'warn';
  if (v.includes('INFO') || v.includes('LOW') || v === '1' || v === '0') return 'info';
  return 'unknown';
}

export async function fetchNotifications(options: { since?: string; searchTerm?: string } = {}): Promise<ProviderNotification[]> {
  const json = await zenCall<unknown>('/api/notifications/search', {
    scope: 'indirect-customerengagement',
    query: {
      ...(options.since ? { 'searchCriteria.fromDate': options.since } : {}),
      ...(options.searchTerm ? { 'searchCriteria.searchTerm': options.searchTerm } : {}),
      'searchCriteria.pageSize': 100,
    },
    emptyAsNull: true,
  });

  return pickArray(json, 'notifications', 'results', 'data', 'items')
    .map((n, i): ProviderNotification | null => {
      const title = text(pickString(n, 'title', 'subject', 'summary', 'headline'));
      if (!title) return null;
      const publishedAt = pickDate(n, 'publishedDate', 'createdDate', 'date') ?? new Date().toISOString();
      return {
        id: text(pickString(n, 'id', 'reference', 'notificationId')) ?? `notification-${i + 1}`,
        publishedAt,
        ...(text(pickString(n, 'category', 'type')) ? { category: text(pickString(n, 'category', 'type')) } : {}),
        severity: notificationSeverity(n),
        title,
        ...(text(pickString(n, 'detail', 'body', 'description')) ? { detail: text(pickString(n, 'detail', 'body', 'description')) } : {}),
        ...(pickArray(n, 'affectedServices', 'services', 'references').length
          ? {
              affectedReferences: pickArray(n, 'affectedServices', 'services', 'references')
                .map((r) => text(pickString(r, 'zenReference', 'reference')) ?? (typeof r === 'string' ? r : undefined))
                .filter((r): r is string => Boolean(r)),
            }
          : {}),
        ...(pickDate(n, 'actionRequiredBy', 'dueDate') ? { actionRequiredBy: pickDate(n, 'actionRequiredBy', 'dueDate') } : {}),
        ...(pickBool(n, 'read', 'isRead') != null ? { read: pickBool(n, 'read', 'isRead') } : {}),
        source: 'zen:self-service',
      };
    })
    .filter((n): n is ProviderNotification => n !== null)
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

/* ------------------------------------------------------------------ *
 * Network management
 * ------------------------------------------------------------------ */

export async function fetchNetworkConfiguration(zenReference?: string): Promise<NetworkConfiguration> {
  // Two endpoints: the catalogue of options, and the configuration of one
  // service. Either can be missing without the other being useless.
  const [namesJson, detailsJson] = await Promise.all([
    zenCall<unknown>('/api/networkmanagement/serviceselectionnames', {
      scope: 'indirect-broadbandconnection',
      emptyAsNull: true,
    }).catch(() => null),
    zenReference
      ? zenCall<unknown>('/api/networkmanagement/networkdetails', {
          scope: 'indirect-broadbandconnection',
          query: { 'request.zenReference': zenReference },
          emptyAsNull: true,
        }).catch(() => null)
      : Promise.resolve(null),
  ]);

  const serviceSelectionNames: NetworkOption[] = pickArray(namesJson, 'serviceSelectionNames', 'names', 'results', 'data')
    .map((o): NetworkOption | null => {
      const name = text(pickString(o, 'name', 'serviceSelectionName', 'value')) ?? (typeof o === 'string' ? o : undefined);
      if (!name) return null;
      const ip = (pickString(o, 'ipVersion', 'addressFamily') ?? '').toLowerCase();
      return {
        name,
        ...(text(pickString(o, 'description')) ? { description: text(pickString(o, 'description')) } : {}),
        ...(text(pickString(o, 'realm')) ? { realm: text(pickString(o, 'realm')) } : {}),
        ...(ip.includes('dual') ? { ipVersion: 'dual' as const } : ip.includes('6') ? { ipVersion: 'ipv6' as const } : ip.includes('4') ? { ipVersion: 'ipv4' as const } : {}),
        ...(text(pickString(o, 'staticBlock', 'subnetSize')) ? { staticBlock: text(pickString(o, 'staticBlock', 'subnetSize')) } : {}),
        ...(pickBool(o, 'isDefault', 'default') === true ? { default: true } : {}),
      };
    })
    .filter((o): o is NetworkOption => o !== null);

  // The detail payload is a flat bag whose keys differ by product, so it is
  // rendered as label/value pairs rather than being forced into a shape.
  const details: Array<{ label: string; value: string }> = [];
  if (detailsJson && typeof detailsJson === 'object') {
    for (const [key, value] of Object.entries(detailsJson as Record<string, unknown>)) {
      if (value === null || value === undefined) continue;
      if (typeof value === 'object') continue;
      const rendered = String(value).trim();
      if (!rendered || rendered === 'string') continue;
      details.push({ label: key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase()), value: rendered });
    }
  }

  return {
    ...(zenReference ? { zenReference } : {}),
    serviceSelectionNames,
    details,
    source: 'zen:self-service',
  };
}

/* ------------------------------------------------------------------ *
 * Estate-wide usage
 * ------------------------------------------------------------------ */

export async function fetchEstateUsage(period?: string): Promise<EstateUsageReport> {
  const [reportJson, periodsJson] = await Promise.all([
    zenCall<unknown>('/api/monthlyusage/report', {
      scope: 'indirect-service',
      query: { ...(period ? { 'request.period': period } : {}) },
      emptyAsNull: true,
    }),
    zenCall<unknown>('/api/monthlyusage/reports', { scope: 'indirect-service', emptyAsNull: true }).catch(() => null),
  ]);

  const rows: EstateUsageRow[] = pickArray(reportJson, 'usage', 'rows', 'results', 'data', 'services')
    .map((r): EstateUsageRow | null => {
      const zenReference = text(pickString(r, 'zenReference', 'reference'));
      if (!zenReference) return null;
      const down = pickNumber(r, 'downloadBytes', 'download', 'bytesDown');
      const up = pickNumber(r, 'uploadBytes', 'upload', 'bytesUp');
      const total = pickNumber(r, 'totalBytes', 'total') ?? (down != null || up != null ? (down ?? 0) + (up ?? 0) : undefined);
      return {
        zenReference,
        ...(text(pickString(r, 'serviceId')) ? { serviceId: text(pickString(r, 'serviceId')) } : {}),
        ...(normaliseCli(pickString(r, 'cli', 'phoneNumber') ?? '') ? { cli: normaliseCli(pickString(r, 'cli', 'phoneNumber')!)! } : {}),
        ...(text(pickString(r, 'address', 'installationAddress')) ? { address: text(pickString(r, 'address', 'installationAddress')) } : {}),
        ...(down != null ? { downloadBytes: down } : {}),
        ...(up != null ? { uploadBytes: up } : {}),
        ...(total != null ? { totalBytes: total } : {}),
        ...(pickBool(r, 'overAllowance', 'isOverAllowance') != null
          ? { overAllowance: pickBool(r, 'overAllowance', 'isOverAllowance') }
          : {}),
      };
    })
    .filter((r): r is EstateUsageRow => r !== null)
    .sort((a, b) => (b.totalBytes ?? 0) - (a.totalBytes ?? 0));

  return {
    period: period ?? text(pickString(reportJson, 'period')) ?? new Date().toISOString().slice(0, 7),
    rows,
    totalBytes: rows.reduce((sum, r) => sum + (r.totalBytes ?? 0), 0),
    availablePeriods: pickArray(periodsJson, 'reports', 'periods', 'results', 'data')
      .map((p) => text(pickString(p, 'period', 'name')) ?? (typeof p === 'string' ? p : undefined))
      .filter((p): p is string => Boolean(p)),
    source: 'zen:self-service',
  };
}

export const __selfServiceTesting = { orderState, orderType, notificationSeverity };

