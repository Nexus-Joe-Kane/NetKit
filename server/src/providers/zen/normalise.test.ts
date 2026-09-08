import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  availabilityFromZen,
  lineStatusFromZen,
  mapZenAddress,
  mapZenService,
  offersFromLineDetails,
  openreachFromAvailability,
  statusFromRag,
  technologyFromProduct,
  type ZenAvailabilityResponse,
} from './normalise';
import { finaliseAddress } from '@sw/shared';

test('RAG values map onto availability status', () => {
  assert.equal(statusFromRag('Green'), 'available');
  assert.equal(statusFromRag('G'), 'available');
  assert.equal(statusFromRag('Amber'), 'available');
  assert.equal(statusFromRag('Red'), 'not_available');
  assert.equal(statusFromRag(undefined, 'Available'), 'available');
  assert.equal(statusFromRag(undefined, 'Not available at this address'), 'not_available');
  assert.equal(statusFromRag(undefined, undefined), 'unknown');
});

test('Zen addresses map to the domain model with the Gold Address Key', () => {
  const address = mapZenAddress({
    address: {
      subPremises: 'Flat 2',
      premisesName: 'Ashley Court',
      thoroughfareNumber: '12',
      thoroughfareName: 'High Street',
      postTown: 'manchester',
      postCode: 'm11ae',
      county: 'Greater Manchester',
    },
    addressReference: {
      uprn: '100023336956',
      addressReferenceNumber: 'A00012345678',
      districtCode: 'MR',
    },
    coordinates: { easting: '384500', northing: '398200' },
    addressClassification: { classificationCode: 'RD06', classificationDescription: 'Self-contained flat' },
  });

  assert.equal(address.uprn, '100023336956');
  // The Gold Address Key is what an order needs, so it must survive mapping.
  assert.equal(address.addressKey, 'A00012345678');
  assert.equal(address.postcode, 'M1 1AE');
  assert.equal(address.postTown, 'MANCHESTER');
  assert.equal(address.singleLine, 'Flat 2, Ashley Court, 12 High Street, MANCHESTER, M1 1AE');
  assert.equal(address.easting, 384500);
  assert.equal(address.premisesType, 'residential');
});

test('Swagger placeholder strings are treated as absent', () => {
  // Zen's docs render every empty field as the literal "string"; mapping that
  // through verbatim would fill the UI with the word "string".
  const address = mapZenAddress({
    address: { premisesName: 'string', thoroughfareName: 'Real Road', postTown: 'LEEDS', postCode: 'LS1 1AA' },
    addressReference: { uprn: 'string' },
  });
  assert.equal(address.buildingName, undefined);
  assert.equal(address.uprn, undefined);
  assert.equal(address.singleLine, 'Real Road, LEEDS, LS1 1AA');
});

test('lineDetails becomes one offer per technology, best first', () => {
  const offers = offersFromLineDetails({
    fttp: { rag: 'Red', fttpUnAvailableMessage: 'No fibre path', maxDownstreamSpeedValue: 1000 },
    sogea: {
      rag: 'Green',
      rangeADownstreamTopSpeedValue: 76,
      rangeADownstreamBottomSpeedValue: 55,
      rangeAUpstreamTopSpeedValue: 19,
      rangeBDownstreamTopSpeedValue: 60,
      rangeBDownstreamBottomSpeedValue: 40,
    },
    adsl2Plus: { rag: 'Green', speedRangeMaxValue: 17, speedRangeMinValue: 6 },
  });

  const technologies = offers.map((o) => o.technology);
  // SOGEA is orderable and faster than ADSL, so it leads; FTTP is red, so last.
  assert.equal(technologies[0], 'SOGEA');
  assert.equal(offers[0]!.status, 'available');
  assert.equal(offers[0]!.speeds.downMbpsHigh, 76);
  assert.equal(offers[0]!.speeds.downMbpsLow, 55);
  assert.ok(offers[0]!.notes.some((n) => n.includes('Range B')), 'Range B estimate should be kept as a note');

  const fttp = offers.find((o) => o.technology === 'FTTP');
  assert.equal(fttp?.status, 'not_available');
  assert.ok(fttp?.notes.includes('No fibre path'));
});

test('the Openreach panel picks up cabinet, loop length and the existing provider', () => {
  const or = openreachFromAvailability({
    lineDetails: {
      fttp: { rag: 'Green', fttpExchangeName: 'Manchester Central', fttpExchangeCode: 'MRCEN' },
      sogea: { rag: 'Green', mdfSiteId: 'MDF123', mdfSiteName: 'Manchester Central' },
      lineCharacteristics: { pcpId: 'PCP 42', lineLength: '850', cpName: 'Openreach', spName: 'BT' },
    },
    ontDetails: [{ serialNumber: 'ALCLFA1234AB', ports: [{ status: 'Spare' }, { status: 'In use' }] }],
    availabilityInformation: {
      messages: [{ severity: 'Warning', description: 'Stop sell in force at this exchange', errorCode: 'SS01' }],
    },
    addressReference: { addressReferenceNumber: 'A999', districtCode: 'MR' },
  });

  assert.equal(or.exchange?.name, 'Manchester Central');
  assert.equal(or.exchange?.tlc, 'MRCEN');
  assert.equal(or.cabinet?.id, 'PCP 42');
  assert.equal(or.copper?.lineLengthMetres, 850);
  assert.equal(or.fttp?.available, true);
  assert.equal(or.fttp?.ontSerial, 'ALCLFA1234AB');
  assert.equal(or.fttp?.ontPortsTotal, 2);
  assert.equal(or.fttp?.ontPortsUsed, 1);
  assert.equal(or.addressKey, 'A999');

  // Who is already on the line is the fact that decides migrate vs provide.
  const inService = or.flags.find((f) => f.label === 'Line already in service');
  assert.ok(inService, 'should flag that the line is already in service');
  assert.match(inService!.detail!, /BT via Openreach/);

  const warning = or.flags.find((f) => f.label === 'SS01');
  assert.equal(warning?.level, 'warn');
});

test('a full availability response yields a headline', () => {
  const address = finaliseAddress({ postTown: 'LEEDS', postcode: 'LS1 1AA', uprn: '1', source: 'zen' });
  const response: ZenAvailabilityResponse = {
    availabilityReference: 'AV-123',
    lineDetails: { fttp: { rag: 'Green', maxDownstreamSpeedValue: 1000, maxUpstreamSpeedValue: 1000 } },
    broadbandGroups: [
      { products: [{ productCode: 'FF900', productName: 'Full Fibre 900', isOrderable: true }] },
    ],
  };
  const availability = availabilityFromZen(address, response);
  assert.equal(availability.headline?.technology, 'FTTP');
  assert.equal(availability.headline?.downMbps, 1000);
  assert.ok(availability.offers.length >= 2, 'wholesale line detail and retail products should both appear');
  assert.equal(availability.uprn, '1');
});

test('a non-orderable product is reported as unavailable with the reason', () => {
  const address = finaliseAddress({ postTown: 'LEEDS', postcode: 'LS1 1AA', source: 'zen' });
  const availability = availabilityFromZen(address, {
    broadbandGroups: [
      {
        products: [
          {
            productCode: 'SOGEA80',
            productName: 'SOGEA 80/20',
            isOrderable: false,
            isOrderableDescription: 'Working line takeover required',
          },
        ],
      },
    ],
  });
  const offer = availability.offers.find((o) => o.productCode === 'SOGEA80');
  assert.equal(offer?.status, 'not_available');
  assert.ok(offer?.notes.includes('Working line takeover required'));
});

test('service status is inferred when the enum is opaque', () => {
  assert.equal(lineStatusFromZen({ serviceStatus: 'Active' }), 'active');
  assert.equal(lineStatusFromZen({ serviceStatus: 'PendingCease' }), 'pending_cease');
  // Zen documents serviceStatus as an integer with no published value table,
  // so a ceased date is the reliable signal.
  assert.equal(lineStatusFromZen({ serviceStatus: 0, ceasedDate: '2024-01-01T00:00:00Z' }), 'ceased');
  assert.equal(lineStatusFromZen({ serviceStatus: 0, startDate: '2023-01-01T00:00:00Z' }), 'active');
  assert.equal(lineStatusFromZen({}), 'unknown');
});

test('a Zen service maps to a line with its identifiers and address', () => {
  const line = mapZenService({
    zenReference: 'ZEN123',
    serviceId: 'BBEU12345678',
    phoneNumber: '0161 750 1234',
    accessLineId: 'AL123456789',
    ontReference: 'ALCLFA9999ZZ',
    port: '1',
    productDescription: 'Full Fibre 900',
    connectionTechnology: 'FTTP',
    serviceStatus: 'Active',
    supplier: 1,
    startDate: '2023-05-01T00:00:00Z',
    contractEndDate: '2030-05-01T00:00:00Z',
    postCode: 'M1 1AE',
    installationAddress: {
      thoroughfareNumber: '4',
      thoroughfareName: 'High Street',
      postTown: 'MANCHESTER',
      postCode: 'M1 1AE',
      uprn: '148575287842',
      addressReferenceNumber: 'A555',
    },
  });

  assert.equal(line.cli, '01617501234');
  assert.equal(line.lineAccessId, 'AL123456789');
  assert.equal(line.serviceId, 'BBEU12345678');
  assert.equal(line.status, 'active');
  assert.equal(line.technology, 'FTTP');
  assert.equal(line.ont?.serial, 'ALCLFA9999ZZ');
  assert.equal(line.address.uprn, '148575287842');
  assert.equal(line.address.singleLine, '4 High Street, MANCHESTER, M1 1AE');
  assert.equal(line.contract?.inContract, true);
  assert.ok(line.notes.some((n) => n.includes('Openreach')), 'the access supplier should be noted');
});

test('technology is inferred from product naming', () => {
  assert.equal(technologyFromProduct('Full Fibre 900'), 'FTTP');
  assert.equal(technologyFromProduct('SOGEA 80/20'), 'SOGEA');
  assert.equal(technologyFromProduct('Unlimited Fibre 2 (FTTC)'), 'FTTC');
  assert.equal(technologyFromProduct('ADSL2+ Annex M'), 'ADSL2+');
  assert.equal(technologyFromProduct('Ethernet 1Gb'), 'EAD');
  assert.equal(technologyFromProduct('Mystery Product'), 'Unknown');
});

test('Openreach kbit/s speeds do not become gigabits', () => {
  // The live symptom: Apartment 1, 113 Newton Street rendered "80 Gb down /
  // 18.2 Gb up". Zen published 80000 / 18200, which is kbit/s.
  const offers = offersFromLineDetails({
    fttc: {
      rangeADownstreamTopSpeedValue: 80000,
      rangeADownstreamBottomSpeedValue: 55000,
      rangeAUpstreamTopSpeedValue: 18200,
      rangeAUpstreamBottomSpeedValue: 12000,
    },
  } as never);

  const fttc = offers.find((o) => o.technology === 'FTTC');
  assert.ok(fttc, 'expected an FTTC offer');
  assert.equal(fttc?.speeds.downMbpsHigh, 80);
  assert.equal(fttc?.speeds.downMbpsLow, 55);
  assert.equal(fttc?.speeds.upMbpsHigh, 18.2);
  assert.equal(fttc?.speeds.upMbpsLow, 12);
});

test('a genuine gigabit FTTP figure in Mbit/s is left alone', () => {
  const offers = offersFromLineDetails({
    fttp: { maxDownstreamSpeedValue: 1000, maxUpstreamSpeedValue: 1000 },
  } as never);
  const fttp = offers.find((o) => o.technology === 'FTTP');
  assert.equal(fttp?.speeds.downMbpsHigh, 1000, '1000 Mb must stay 1000 Mb');
});
