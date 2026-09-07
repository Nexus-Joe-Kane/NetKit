/** Realistic UK reference data used to shape fixture premises and networks. */

export const STREETS = [
  'High Street', 'Station Road', 'Church Lane', 'Victoria Road', 'Mill Lane',
  'Kings Road', 'Queens Road', 'Manor Road', 'Park Avenue', 'Albert Road',
  'The Green', 'York Road', 'Windsor Road', 'Grange Road', 'Springfield Road',
  'Cavendish Street', 'Bramhall Lane', 'Oakfield Avenue', 'Beech Grove', 'Elm Close',
  'Chatsworth Road', 'Northgate', 'Wellington Street', 'Bridge Street', 'Market Place',
] as const;

export const BUILDING_NAMES = [
  'Ashley Court', 'The Old Bakery', 'Rosewood House', 'Mill View', 'Kingsley Mews',
  'Waterside Apartments', 'Chapel House', 'The Coach House', 'Riverbank Court', 'Fern Lodge',
] as const;

export const ORGANISATIONS = [
  'Northwind Consulting Ltd', 'Bramhall Dental Practice', 'Pennine Logistics',
  'Clearwater Accountancy', 'Fielding & Sons', 'Aurora Creative Studio',
  'Meadowbank Veterinary Centre', 'Redstone Engineering Ltd',
] as const;

/**
 * Real Openreach exchange names with their Telephone Location Codes. Support
 * staff recognise these, which is what makes the fixture data feel credible.
 */
export const EXCHANGES = [
  { name: 'Manchester Central', tlc: 'MRCEN', code: 'MRCEN' },
  { name: 'Manchester Didsbury', tlc: 'MRDSB', code: 'MRDSB' },
  { name: 'Salford', tlc: 'MRSAL', code: 'MRSAL' },
  { name: 'Stockport', tlc: 'MRSTK', code: 'MRSTK' },
  { name: 'Leeds City', tlc: 'LSCTY', code: 'LSCTY' },
  { name: 'Sheffield Highfield', tlc: 'SLHFD', code: 'SLHFD' },
  { name: 'Birmingham Central', tlc: 'CMTHL', code: 'CMTHL' },
  { name: 'Bristol Central', tlc: 'BSCEN', code: 'BSCEN' },
  { name: 'London Kensington', tlc: 'LNKEN', code: 'LNKEN' },
  { name: 'London Shoreditch', tlc: 'LNSHO', code: 'LNSHO' },
  { name: 'Glasgow Halfway', tlc: 'GWHWY', code: 'GWHWY' },
  { name: 'Edinburgh Central', tlc: 'ESCEN', code: 'ESCEN' },
  { name: 'Cardiff Central', tlc: 'CFCEN', code: 'CFCEN' },
  { name: 'Newcastle Central', tlc: 'NECEN', code: 'NECEN' },
  { name: 'Nottingham Trent Bridge', tlc: 'NGTRB', code: 'NGTRB' },
  { name: 'Reading Central', tlc: 'THRDG', code: 'THRDG' },
] as const;

/** Alt-net footprints, used to decide which non-Openreach operators appear. */
export const ALTNETS = [
  { operator: 'cityfibre' as const, label: 'CityFibre', weight: 4 },
  { operator: 'virgin-media' as const, label: 'Virgin Media O2', weight: 6 },
  { operator: 'hyperoptic' as const, label: 'Hyperoptic', weight: 2 },
  { operator: 'netomnia' as const, label: 'Netomnia / YouFibre', weight: 2 },
  { operator: 'community-fibre' as const, label: 'Community Fibre', weight: 1 },
  { operator: 'gigaclear' as const, label: 'Gigaclear', weight: 1 },
  { operator: 'trooli' as const, label: 'Trooli', weight: 1 },
  { operator: 'zzoomm' as const, label: 'Zzoomm', weight: 1 },
] as const;

export const CPE_MODELS = [
  { vendor: 'Zyxel', model: 'VMG8825-T50K' },
  { vendor: 'FRITZ!Box', model: '7530 AX' },
  { vendor: 'Zyxel', model: 'EX3301-T0' },
  { vendor: 'DrayTek', model: 'Vigor 2865ac' },
  { vendor: 'TP-Link', model: 'Archer VR2100' },
  { vendor: 'Technicolor', model: 'DGA4134' },
] as const;

export const ONT_MODELS = [
  { vendor: 'Nokia', model: 'G-010G-P', prefix: 'ALCL' },
  { vendor: 'Huawei', model: 'HG8010H', prefix: 'HWTC' },
  { vendor: 'Nokia', model: '7368 ISAM ONT', prefix: 'NOKG' },
  { vendor: 'Adtran', model: '622v', prefix: 'ADTN' },
] as const;

/** Zen retail product names, so the Lines panel reads like a real bill. */
export const ZEN_PRODUCTS = [
  { name: 'Full Fibre 900', tech: 'FTTP', down: 900, up: 900 },
  { name: 'Full Fibre 500', tech: 'FTTP', down: 500, up: 500 },
  { name: 'Full Fibre 300', tech: 'FTTP', down: 300, up: 300 },
  { name: 'Full Fibre 150', tech: 'FTTP', down: 150, up: 30 },
  { name: 'Unlimited Fibre 2 (SOGEA)', tech: 'SOGEA', down: 76, up: 19 },
  { name: 'Unlimited Fibre 1 (SOGEA)', tech: 'SOGEA', down: 38, up: 9.5 },
  { name: 'Unlimited Fibre 2', tech: 'FTTC', down: 76, up: 19 },
  { name: 'Unlimited Broadband', tech: 'ADSL2+', down: 17, up: 1 },
] as const;

export const FAULT_SUMMARIES = [
  'Intermittent loss of sync — DLM banded profile applied',
  'No dial tone reported, suspected DP fault',
  'Slow throughput, high error counts on downstream',
  'ONT reporting LOS, fibre break suspected upstream of CBT',
  'Line dropping during rainfall — suspected water ingress at joint',
] as const;

/**
 * Postcode area → the exchanges and dialling code that actually serve it.
 *
 * Without this, a Manchester postcode could be handed a Reading exchange and
 * a Sheffield dialling code, which instantly gives the game away. Keying the
 * seeded choice by postcode area keeps fixture data regionally coherent.
 */
export const REGIONS: Record<string, { exchanges: string[]; dialCode: string; town: string }> = {
  M: { exchanges: ['MRCEN', 'MRDSB', 'MRSAL'], dialCode: '0161496', town: 'Manchester' },
  SK: { exchanges: ['MRSTK', 'MRDSB'], dialCode: '0161496', town: 'Stockport' },
  LS: { exchanges: ['LSCTY'], dialCode: '0113496', town: 'Leeds' },
  S: { exchanges: ['SLHFD'], dialCode: '0114496', town: 'Sheffield' },
  B: { exchanges: ['CMTHL'], dialCode: '0121496', town: 'Birmingham' },
  BS: { exchanges: ['BSCEN'], dialCode: '0117496', town: 'Bristol' },
  W: { exchanges: ['LNKEN'], dialCode: '0207946', town: 'London' },
  EC: { exchanges: ['LNSHO'], dialCode: '0207946', town: 'London' },
  SW: { exchanges: ['LNKEN'], dialCode: '0207946', town: 'London' },
  N: { exchanges: ['LNSHO'], dialCode: '0207946', town: 'London' },
  G: { exchanges: ['GWHWY'], dialCode: '0141496', town: 'Glasgow' },
  EH: { exchanges: ['ESCEN'], dialCode: '0131496', town: 'Edinburgh' },
  CF: { exchanges: ['CFCEN'], dialCode: '0292018', town: 'Cardiff' },
  NE: { exchanges: ['NECEN'], dialCode: '0191498', town: 'Newcastle' },
  NG: { exchanges: ['NGTRB'], dialCode: '0115496', town: 'Nottingham' },
  RG: { exchanges: ['THRDG'], dialCode: '0118496', town: 'Reading' },
};

/** The letters at the start of a postcode — its postcode area. */
export function postcodeArea(postcode: string): string {
  return (postcode.match(/^[A-Za-z]+/)?.[0] ?? '').toUpperCase();
}

/** Region for a postcode, falling back to Manchester for unknown areas. */
export function regionFor(postcode: string): { exchanges: string[]; dialCode: string; town: string } {
  const area = postcodeArea(postcode);
  return REGIONS[area] ?? REGIONS[area.slice(0, 1)] ?? { exchanges: ['MRCEN'], dialCode: '0161496', town: 'Manchester' };
}

/** Postcodes the demo/fixture mode always has premises for. */
export const DEMO_POSTCODES = [
  'M1 1AE', 'M20 2YY', 'SK7 1AA', 'LS1 4DY', 'S1 2HH',
  'B1 1BB', 'BS1 4DJ', 'W8 5TT', 'EC2A 3AY', 'G2 1DY',
  'EH1 1YZ', 'CF10 1EP', 'NE1 4ST', 'NG2 5FX', 'RG1 1AX',
] as const;
