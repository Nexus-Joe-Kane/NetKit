import { normaliseCli, type AccessTechnology, type AddressRecord } from '@sw/shared';
import type {
  AppointmentSlot,
  CallRecord,
  EthernetQuote,
  EthernetQuoteSet,
  NumberPortCheck,
  OrderQuote,
  OrderRecord,
  OrderState,
  PriceLine,
  RdnsRecord,
  SimEstate,
  SimRecord,
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

function simState(raw?: string): SimState {
  const v = (raw ?? '').toUpperCase();
  if (v.includes('ACTIVE') || v.includes('LIVE')) return 'active';
  if (v.includes('SUSPEND') || v.includes('BAR')) return 'suspended';
  if (v.includes('CEAS') || v.includes('TERMINAT')) return 'ceased';
  if (v.includes('PENDING') || v.includes('STOCK')) return 'pending';
  if (v.includes('TEST')) return 'test';
  return 'unknown';
}

/**
 * The SIM estate. Zen's cellular endpoints are Jola-backed, so this covers
 * the business SIM question without a separate Jola integration — Zen
 * answers 503 with "Jola ID or pool ID is not assigned yet" when the account
 * has not been linked.
 */
export async function fetchSimEstate(): Promise<SimEstate> {
  const [usageJson, listJson] = await Promise.all([
    zenCall<unknown>('/api/cellular/usages', { scope: 'indirect-broadbandconnection', emptyAsNull: true }).catch(() => null),
    zenCall<unknown>('/api/cellular/sims', { scope: 'indirect-broadbandconnection', emptyAsNull: true }).catch(() => null),
  ]);

  const byIccid = new Map<string, SimRecord>();

  for (const row of pickArray(usageJson, 'sims')) {
    const iccid = pickString(row, 'iccId', 'iccid');
    if (!iccid) continue;
    byIccid.set(iccid, {
      iccid,
      ...(pickString(row, 'zenReference') ? { zenReference: pickString(row, 'zenReference') } : {}),
      state: simState(pickString(row, 'state', 'status')),
      ...(pickString(row, 'postcode', 'postCode') ? { postcode: pickString(row, 'postcode', 'postCode') } : {}),
      ...(pickNumber(row, 'allowance') != null ? { allowanceBytes: pickNumber(row, 'allowance') } : {}),
      ...(pickNumber(row, 'boltOnAllowance') != null ? { boltOnBytes: pickNumber(row, 'boltOnAllowance') } : {}),
      ...(pickNumber(row, 'usage') != null ? { usedBytes: pickNumber(row, 'usage') } : {}),
      provider: 'Zen Internet (Jola)',
      source: 'zen:self-service',
    });
  }

  // The plain SIM list carries status for SIMs with no usage recorded yet.
  for (const row of Array.isArray(listJson) ? listJson : pickArray(listJson, 'sims', 'results', 'data')) {
    const iccid = pickString(row, 'iccId', 'iccid');
    if (!iccid) continue;
    const existing = byIccid.get(iccid);
    if (existing) {
      if (existing.state === 'unknown') existing.state = simState(pickString(row, 'status', 'state'));
    } else {
      byIccid.set(iccid, {
        iccid,
        state: simState(pickString(row, 'status', 'state')),
        provider: 'Zen Internet (Jola)',
        source: 'zen:self-service',
      });
    }
  }

  const poolRaw = (usageJson as { pool?: unknown })?.pool;
  const pool = poolRaw
    ? {
        ...(pickNumber(poolRaw, 'size') != null ? { sizeBytes: pickNumber(poolRaw, 'size') } : {}),
        ...(pickNumber(poolRaw, 'usage') != null ? { usedBytes: pickNumber(poolRaw, 'usage') } : {}),
        ...(pickNumber(poolRaw, 'simCount') != null ? { simCount: pickNumber(poolRaw, 'simCount') } : {}),
        ...(pickNumber(poolRaw, 'overage') != null ? { overageBytes: pickNumber(poolRaw, 'overage') } : {}),
      }
    : undefined;

  return {
    sims: [...byIccid.values()],
    ...(pool && Object.keys(pool).length ? { pool } : {}),
    checkedAt: new Date().toISOString(),
    sources: ['zen:self-service'],
  };
}

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

export const __selfServiceTesting = { orderState, orderType, simState };
